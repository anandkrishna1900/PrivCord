import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatEngine, ChatState, UiMessage } from '../lib/engine';
import type { AppSettings } from '../lib/settings';
import { LOCAL_ID } from '../lib/identity';
import { formatTime } from '../lib/format';
import { MAX_FILE_BYTES, formatBytes } from '@duochat/protocol';
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
import { RequestDialog } from './RequestDialog';
import { ChannelsDialog } from './ChannelsDialog';
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
    null | 'settings' | 'add' | 'group' | 'channels' | 'details' | 'manual' | 'nuke' | 'clear' | 'recovery'
  >(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('profile');
  const [panic, setPanic] = useState(false);
  const [manualUid, setManualUid] = useState('');
  const [verifyUid, setVerifyUid] = useState<string | null>(null);
  const [replying, setReplying] = useState<UiMessage | null>(null);
  const [query, setQuery] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const loadFile = useCallback((id: string) => engine?.getFile(id) ?? Promise.resolve(null), [engine]);

  // Panic wipe: three quick Ctrl+Shift+Backspace presses, when the user turned it on.
  useEffect(() => {
    if (!settings.panicWipe) return;
    const times: number[] = [];
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey && e.shiftKey && e.key === 'Backspace')) return;
      const now = Date.now();
      times.push(now);
      while (times.length && now - times[0]! > 2000) times.shift();
      if (times.length >= 3) {
        times.length = 0;
        setPanic(true);
        setDialog('nuke');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settings.panicWipe]);

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
    setReplying(null);
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
      ...state.contacts.filter((c) => c.direct).map((c) => ({
        id: c.uid,
        isGroup: false,
        name: c.name,
        preview: c.last ? `${c.last.own ? 'You: ' : ''}${c.last.text}` : c.status,
        at: c.last?.at ?? 0,
        unread: c.unread,
        online: c.conn === 'connected',
      })),
      ...state.channels.map((c) => ({
        id: c.id,
        isGroup: true,
        name: `# ${c.name}`,
        preview: c.last ? `${c.last.own ? 'You' : (c.last.senderName ?? 'Someone')}: ${c.last.text}` : 'Public channel',
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

  const hits = useMemo(() => (engine && query.trim().length >= 2 ? engine.search(query) : []), [engine, query, state?.messages]);

  useEffect(() => {
    document.title = 'PrivCord';
  }, []);

  if (fatal) return <Splash danger title="PrivCord could not start" text={fatal} />;
  if (!state || state.phase === 'starting') return <Splash title="PrivCord" text="Opening your chats…" />;
  if (state.phase === 'error') return <Splash danger title="PrivCord could not start" text={state.error ?? 'Unknown error.'} />;

  const person = state.contacts.find((c) => c.uid === selected) ?? null;
  const group = state.groups.find((g) => g.groupId === selected) ?? null;
  const channel = state.channels.find((c) => c.id === selected) ?? null;
  const current = person ?? group ?? (channel ? { name: `# ${channel.name}` } : null);
  const verifyPerson = state.contacts.find((c) => c.uid === verifyUid) ?? null;
  const messages = (selected && state.messages[selected]) || [];
  const hasChats = rows.length > 0;
  const readOnly = group !== null && group.status !== 'member';

  const headerStatus = channel
    ? 'Public channel · anyone who knows the name can read this'
    : person
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
          <button type="button" className="button secondary" aria-label="Channels" onClick={() => setDialog('channels')}>
            Channels
          </button>
        </div>

        {hasChats ? (
          <div className="search-box">
            <input
              type="search"
              aria-label="Search messages"
              placeholder="Search messages"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        ) : null}
        {query.trim().length >= 2 ? (
          <div className="search-results" aria-label="Search results">
            {hits.length === 0 ? <p className="muted small" style={{ padding: 12 }}>Nothing found.</p> : null}
            {hits.map((h) => (
              <button
                key={h.messageId}
                type="button"
                className="search-hit"
                onClick={() => {
                  setSelected(h.convId);
                  setFocusId(h.messageId);
                  setQuery('');
                }}
              >
                <strong>
                  {h.convName} · {h.senderName}
                </strong>
                <span className="muted small">{h.text}</span>
              </button>
            ))}
          </div>
        ) : hasChats ? (
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
                        else if (channel) {
                          engine?.leaveChannel(channel.id);
                          setSelected(null);
                        } else setDialog('details');
                      }}
                    >
                      {person ? 'Friend details' : channel ? 'Leave channel' : 'Group details'}
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
            {person?.diagnosis ? (
              <div className="banner info" role="status" data-testid="diagnosis">
                <span>{person.diagnosis.message}</span>
                {person.diagnosis.actions.includes('enable-store-forward') ? (
                  <button type="button" className="btn small" onClick={() => void engine?.enableStoreForward()}>
                    Deliver via relays
                  </button>
                ) : null}
                {person.diagnosis.actions.some((a) => a === 'add-turn' || a === 'open-connection-settings') ? (
                  <button type="button" className="btn small" onClick={() => { setSettingsSection('connection'); setDialog('settings'); }}>
                    Connection settings
                  </button>
                ) : null}
              </div>
            ) : null}
            {channel ? (
              <div className="banner subtle" role="note">
                <span>Public channel: anyone who knows the name can read it. Your messages show your name and a short ID.</span>
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
              isGroup={group !== null || channel !== null}
              canReply={channel === null}
              onMute={channel ? (uid) => engine?.muteSender(uid) : undefined}
              empty={
                group
                  ? 'No messages yet. Say hello to the group.'
                  : person?.conn === 'connected'
                    ? 'Connected. Say hello.'
                    : 'Messages you write now are sent as soon as they are online.'
              }
              onRetry={(id) => void engine?.retry(id)}
              onReact={(id, emoji) => engine?.react(id, emoji)}
              onDelete={(id, everyone) => engine?.deleteMessage(id, everyone)}
              focusId={focusId}
              onFocused={() => setFocusId(null)}
              onReply={setReplying}
              loadFile={loadFile}
            />

            {readOnly ? (
              <div className="composer-note">{group!.status === 'removed' ? 'You were removed from this group.' : 'You left this group.'}</div>
            ) : (
              <Composer
                key={selected}
                disabled={state.phase !== 'ready'}
                placeholder={group ? `Message ${group.name}` : `Message ${current.name}`}
                isChannel={channel !== null}
                reply={replying ? { name: replying.own ? 'yourself' : replying.senderName, preview: replying.text } : null}
                onCancelReply={() => setReplying(null)}
                onSend={async (text) => {
                  const r = (await engine?.send(selected!, text, replying?.messageId)) ?? { ok: false as const, error: 'Not ready.' };
                  if (r.ok) setReplying(null);
                  return r;
                }}
                onSendFile={async (file) => {
                  if (file.size > MAX_FILE_BYTES) return { ok: false as const, error: `Files can be at most ${formatBytes(MAX_FILE_BYTES)}.` };
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  const r = (await engine?.sendFile(selected!, { name: file.name, mime: file.type, bytes }, replying?.messageId)) ?? { ok: false as const, error: 'Not ready.' };
                  if (r.ok) setReplying(null);
                  return r;
                }}
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

      <RequestDialog requests={state.requests} engine={engine} onAdded={open} />
      <ChannelsDialog
        open={dialog === 'channels'}
        onClose={() => setDialog(null)}
        engine={engine}
        channels={state.channels}
        onJoined={open}
      />
      <AddFriendDialog open={dialog === 'add'} onClose={() => setDialog(null)} engine={engine} answer={state.answer} onAdded={open} />
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
        onMessage={(uid) => {
          setDialog(null);
          open(uid);
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
        autoRun={panic}
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
