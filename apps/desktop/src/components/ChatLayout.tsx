import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatEngine, ChatState } from '../lib/engine';
import type { AppSettings } from '../lib/settings';
import { LOCAL_ID } from '../lib/identity';
import { formatTime } from '../lib/format';
import { Avatar } from './Avatar';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { SettingsDialog, type SettingsSection } from './SettingsDialog';
import { ManualConnectDialog } from './ManualConnectDialog';
import { ClearChatDialog, NukeDialog } from './KillSwitchDialogs';
import { RecoveryDialog } from './RecoveryDialogs';
import { AddFriendDialog } from './AddFriendDialog';
import { GroupDetailsDialog, NewGroupDialog } from './GroupDialogs';
import { PersonDialog } from './PersonDialog';
import { AlertIcon, ArrowLeftIcon, LoaderIcon, RefreshIcon, SettingsIcon, ShieldIcon, UserIcon, XIcon } from './Icons';

interface Row {
  id: string;
  isGroup: boolean;
  name: string;
  preview: string;
  at: number;
  unread: number;
  online: boolean;
}

function Splash({ title, text, danger }: { title: string; text: string; danger?: boolean }) {
  return (
    <main className="loading-page">
      <div className="splash">
        <div className={`brand-lock large ${danger ? 'danger' : ''}`}>
          {danger ? <AlertIcon size={26} /> : <LoaderIcon size={26} className="spin" />}
        </div>
        <h1>{title}</h1>
        <p className="muted">{text}</p>
        {danger ? (
          <button type="button" className="button secondary" onClick={() => window.location.reload()}>
            <RefreshIcon size={16} />
            Reload
          </button>
        ) : null}
      </div>
    </main>
  );
}

export function ChatLayout({
  state,
  engine,
  settings,
  updateSettings,
  fatal,
}: {
  state: ChatState | null;
  engine: ChatEngine | null;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  fatal: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<
    null | 'settings' | 'add' | 'group' | 'details' | 'manual' | 'nuke' | 'clear' | 'recovery'
  >(null);
  const [settingsSection] = useState<SettingsSection>('profile');
  const [manualUid, setManualUid] = useState('');
  const [verifyUid, setVerifyUid] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!engine) return;
    const update = () => engine.setVisible(document.visibilityState === 'visible' && document.hasFocus());
    update();
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [engine]);

  useEffect(() => {
    engine?.openConversation(selected);
  }, [engine, selected]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const rows = useMemo<Row[]>(() => {
    if (!state) return [];
    const list: Row[] = [
      ...state.contacts.map((c) => ({
        id: c.uid,
        isGroup: false,
        name: c.name,
        preview: c.last ? `${c.last.own ? 'You: ' : ''}${c.last.text}` : c.status,
        at: c.last?.at ?? 0,
        unread: c.unread,
        online: c.conn === 'connected',
      })),
      ...state.groups.map((g) => ({
        id: g.groupId,
        isGroup: true,
        name: g.name,
        preview: g.last
          ? `${g.last.own ? 'You' : (g.last.senderName ?? 'Someone')}: ${g.last.text}`
          : g.status === 'member'
            ? `${g.members.length} members`
            : g.status === 'removed' ? 'You were removed' : 'You left',
        at: g.last?.at ?? 0,
        unread: g.unread,
        online: g.connected > 0,
      })),
    ];
    return list.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  }, [state]);

  useEffect(() => {
    document.title = 'PrivCord';
  }, []);

  if (fatal) return <Splash danger title="PrivCord could not start" text={fatal} />;
  if (!state || state.phase === 'starting') return <Splash title="PrivCord" text="Opening your chats…" />;
  if (state.phase === 'error') return <Splash danger title="PrivCord could not start" text={state.error ?? 'Unknown error.'} />;

  const person = state.contacts.find((c) => c.uid === selected) ?? null;
  const group = state.groups.find((g) => g.groupId === selected) ?? null;
  const current = person ?? group;
  const verifyPerson = state.contacts.find((c) => c.uid === verifyUid) ?? null;
  const messages = (selected && state.messages[selected]) || [];
  const hasChats = rows.length > 0;
  const readOnly = group !== null && group.status !== 'member';

  const headerStatus = person
    ? person.status
    : group
      ? group.status === 'member'
        ? `${group.members.length} members · ${group.connected} connected`
        : group.status === 'removed' ? 'You were removed' : 'You left'
      : '';

  function open(id: string) {
    setSelected(id);
    setMenuOpen(false);
  }

  return (
    <div className={`app-shell ${current ? 'has-chat' : ''}`}>
      <aside className="sidebar">
        <header className="sidebar-head">
          <span className="brand-mark">
            <ShieldIcon size={18} />
          </span>
          <h1>PrivCord</h1>
          <button type="button" className="icon-button" aria-label="Settings" title="Settings" onClick={() => setDialog('settings')}>
            <SettingsIcon size={18} />
          </button>
        </header>
        <div className="sidebar-actions">
          <button type="button" className="button primary" aria-label="Add friend" onClick={() => setDialog('add')}>
            <UserIcon size={16} />
            Add friend
          </button>
          <button
            type="button"
            className="button secondary"
            aria-label="New group"
            onClick={() => setDialog('group')}
          >
            New group
          </button>
        </div>

        {hasChats ? (
          <nav className="chat-list" aria-label="Chats">
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                className={`chat-row ${row.id === selected ? 'active' : ''}`}
                onClick={() => open(row.id)}
              >
                <Avatar name={row.name} size={42} online={row.online} />
                <span className="chat-row-main">
                  <span className="chat-row-top">
                    <strong>{row.name}</strong>
                    {row.at ? <span className="muted small">{formatTime(row.at)}</span> : null}
                  </span>
                  <span className="chat-row-bottom">
                    <span className="muted small chat-row-preview">{row.preview}</span>
                    {row.unread > 0 ? <span className="unread-dot" aria-label={`${row.unread} unread`}>{row.unread}</span> : null}
                  </span>
                </span>
              </button>
            ))}
          </nav>
        ) : (
          <div className="sidebar-empty">
            <p className="muted small">No chats yet.</p>
          </div>
        )}
      </aside>

      <main className="chat-panel">
        {current ? (
          <>
            <header className="chat-header">
              <button type="button" className="icon-button back-button" aria-label="Back to chats" onClick={() => setSelected(null)}>
                <ArrowLeftIcon size={18} />
              </button>
              <div className="chat-header-identity">
                <Avatar name={current.name} size={40} online={person ? person.conn === 'connected' : (group?.connected ?? 0) > 0} />
                <div>
                  <h2>{current.name}</h2>
                  <p className="muted small">{headerStatus}</p>
                </div>
              </div>
              <div className="menu-wrap" ref={menuRef}>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="More"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((v) => !v)}
                >
                  <span aria-hidden="true">⋯</span>
                </button>
                {menuOpen ? (
                  <div className="menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        if (person) setVerifyUid(person.uid);
                        else setDialog('details');
                      }}
                    >
                      {person ? 'Friend details' : 'Group details'}
                    </button>
                    {person ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          setManualUid(person.uid);
                          setDialog('manual');
                        }}
                      >
                        Connect without internet
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </header>

            {state.error ? (
              <div className="banner error" role="alert">
                <AlertIcon size={16} />
                <span>{state.error}</span>
                <button type="button" className="icon-button subtle" aria-label="Dismiss" onClick={() => engine?.clearNotice()}>
                  <XIcon size={15} />
                </button>
              </div>
            ) : null}
            {state.notice ? (
              <div className="banner info" role="status">
                <span>{state.notice}</span>
                <button type="button" className="icon-button subtle" aria-label="Dismiss" onClick={() => engine?.clearNotice()}>
                  <XIcon size={15} />
                </button>
              </div>
            ) : null}
            {person?.trust === 'introduced' && !person.checked ? (
              <div className="banner subtle" role="note">
                <span>Introduced by {person.introducedByName ?? 'a friend'}.</span>
                <button type="button" className="button small secondary" onClick={() => setVerifyUid(person.uid)}>
                  Verify
                </button>
              </div>
            ) : null}
            {state.storageBackend === 'browser' ? (
              <div className="banner subtle" role="note">
                <span>Development mode: chats are not encrypted on disk. Use the desktop app for the real thing.</span>
              </div>
            ) : null}

            <MessageList
              convId={selected ?? ''}
              messages={messages}
              isGroup={group !== null}
              empty={
                group
                  ? 'No messages yet. Say hello to the group.'
                  : person?.conn === 'connected'
                    ? 'Connected. Say hello.'
                    : 'Messages you write now are sent as soon as they are online.'
              }
              onRetry={(id) => void engine?.retry(id)}
            />

            {readOnly ? (
              <div className="composer-note">{group!.status === 'removed' ? 'You were removed from this group.' : 'You left this group.'}</div>
            ) : (
              <Composer
                key={selected}
                disabled={state.phase !== 'ready'}
                placeholder={group ? `Message ${group.name}` : `Message ${current.name}`}
                onSend={(text) => engine?.send(selected!, text) ?? Promise.resolve({ ok: false as const, error: 'Not ready.' })}
              />
            )}
          </>
        ) : (
          <div className="welcome">
            <div className="empty-emblem">
              <ShieldIcon size={30} />
            </div>
            <h2>{hasChats ? 'Pick a chat' : 'Welcome to PrivCord'}</h2>
            {hasChats ? (
              <p className="muted">Choose someone from the list, or add a friend.</p>
            ) : (
              <>
                <p className="muted">Private chats and groups. No account, no cloud.</p>
                <ol className="welcome-steps">
                  <li>Tap <strong>Add friend</strong> and swap invites.</li>
                  <li>Start chatting. Messages go straight to their device.</li>
                  <li>Make a <strong>group</strong>. Friends you add can add theirs, and everyone connects automatically.</li>
                </ol>
                <button type="button" className="button primary" onClick={() => setDialog('add')}>
                  Add your first friend
                </button>
              </>
            )}
          </div>
        )}
      </main>

      <AddFriendDialog open={dialog === 'add'} onClose={() => setDialog(null)} engine={engine} onAdded={open} />
      <NewGroupDialog open={dialog === 'group'} onClose={() => setDialog(null)} engine={engine} state={state} onCreated={open} />
      <GroupDetailsDialog
        open={dialog === 'details' && group !== null}
        onClose={() => setDialog(null)}
        engine={engine}
        state={state}
        group={group}
        onVerify={(uid) => {
          setDialog(null);
          setVerifyUid(uid);
        }}
      />
      <PersonDialog
        open={verifyPerson !== null}
        onClose={() => setVerifyUid(null)}
        engine={engine}
        person={verifyPerson}
        onManual={(uid) => {
          setManualUid(uid);
          setDialog('manual');
        }}
        onRemoved={() => setSelected(null)}
      />
      <ManualConnectDialog open={dialog === 'manual'} onClose={() => setDialog(null)} engine={engine} state={state} uid={manualUid} />
      <SettingsDialog
        open={dialog === 'settings'}
        onClose={() => setDialog(null)}
        initialSection={settingsSection}
        engine={engine}
        state={state}
        settings={settings}
        updateSettings={updateSettings}
        onOpenNuke={() => setDialog('nuke')}
        onOpenClearChats={() => setDialog('clear')}
        onOpenRecovery={() => setDialog('recovery')}
      />
      <NukeDialog
        open={dialog === 'nuke'}
        onClose={() => setDialog(null)}
        engine={engine}
        uid={LOCAL_ID}
        peerUid=""
        onFinished={async () => {
          window.location.reload();
        }}
      />
      <ClearChatDialog open={dialog === 'clear'} onClose={() => setDialog(null)} engine={engine} uid={LOCAL_ID} peerUid="" />
      <RecoveryDialog open={dialog === 'recovery'} onClose={() => setDialog(null)} mode="restore" onIdentityReady={() => window.location.reload()} />
    </div>
  );
}
