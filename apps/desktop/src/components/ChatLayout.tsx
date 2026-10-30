import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import type { ChatEngine, ChatState } from '../lib/engine';
import type { AppSettings } from '../lib/settings';
import { formatLastSeen } from '../lib/format';
import { Avatar } from './Avatar';
import { ConnectionBadge } from './ConnectionBadge';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { SettingsDialog, type SettingsSection } from './SettingsDialog';
import { ManualConnectDialog } from './ManualConnectDialog';
import { ClearChatDialog, NukeDialog } from './KillSwitchDialogs';
import {
  AlertIcon,
  CheckIcon,
  ChatIcon,
  KeyIcon,
  LinkIcon,
  LoaderIcon,
  LockIcon,
  LogOutIcon,
  SettingsIcon,
  ShieldIcon,
  XIcon,
} from './Icons';

export function ChatLayout({
  user,
  state,
  engine,
  settings,
  updateSettings,
  onSignOut,
  fatal,
}: {
  user: User;
  state: ChatState | null;
  engine: ChatEngine | null;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  onSignOut: () => Promise<void>;
  fatal: string | null;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('profile');
  const [manualOpen, setManualOpen] = useState(false);
  const [nukeOpen, setNukeOpen] = useState(false);
  const [clearChatOpen, setClearChatOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const peerName = state?.peerProfile?.displayName ?? 'Your friend';
  const selfName = state?.selfProfile?.displayName ?? user.displayName ?? user.email ?? 'You';

  useEffect(() => {
    document.title = `${peerName} · DuoChat`;
  }, [peerName]);

  useEffect(() => {
    if (!engine) return;
    const update = () =>
      engine.setVisible(document.visibilityState === 'visible' && document.hasFocus());
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

  function openSettings(section: SettingsSection) {
    setSettingsSection(section);
    setSettingsOpen(true);
    setSidebarOpen(false);
  }

  function openManual() {
    setSettingsOpen(false);
    setManualOpen(true);
  }

  if (fatal) {
    return (
      <main className="centered-page">
        <section className="setup-card">
          <div className="brand-lock large danger">
            <AlertIcon size={26} />
          </div>
          <p className="eyebrow">Startup failed</p>
          <h1>DuoChat could not initialize</h1>
          <p className="muted">{fatal}</p>
          <button type="button" className="button secondary" onClick={() => void onSignOut()}>
            <LogOutIcon size={16} />
            Sign out
          </button>
        </section>
      </main>
    );
  }

  if (!state || state.phase === 'starting') {
    return (
      <main className="loading-page">
        <div className="splash">
          <div className="brand-lock large">
            <LoaderIcon size={26} className="spin" />
          </div>
          <h1>DuoChat</h1>
          <p className="muted">Opening your encrypted local conversation…</p>
        </div>
      </main>
    );
  }

  if (state.phase === 'error') {
    return (
      <main className="centered-page">
        <section className="setup-card">
          <div className="brand-lock large danger">
            <AlertIcon size={26} />
          </div>
          <p className="eyebrow">Conversation unavailable</p>
          <h1>DuoChat could not start</h1>
          <p className="muted">{state.error ?? 'Unknown startup error.'}</p>
          <button type="button" className="button secondary" onClick={() => void onSignOut()}>
            <LogOutIcon size={16} />
            Sign out
          </button>
        </section>
      </main>
    );
  }

  const peerActive =
    state.p2pConnected ||
    (state.cloudConnected &&
      state.peerProfile?.lastSeenAt != null &&
      Date.now() - state.peerProfile.lastSeenAt < 150_000);
  const subline = state.p2pConnected
    ? 'Direct connection active'
    : peerActive
      ? 'Active now'
      : formatLastSeen(state.peerProfile?.lastSeenAt ?? null);
  const noticeVisible = state.notice && state.notice !== dismissed;
  const errorVisible = state.error;
  const directMode = settings.messageMode === 'direct';

  return (
    <div className={`app-shell ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <ShieldIcon size={20} />
          </span>
          <div>
            <strong>DuoChat</strong>
            <span>Two-person private line</span>
          </div>
        </div>

        <div className="self-mini">
          <Avatar name={selfName} size={42} />
          <div>
            <strong>{selfName}</strong>
            <span className="muted small">You</span>
          </div>
        </div>

        <div className="peer-mini">
          <Avatar name={peerName} size={42} online={peerActive} />
          <div>
            <strong>{peerName}</strong>
            <span className="muted small">{subline}</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Main navigation">
          <button type="button" className="sidebar-button active" onClick={() => setSidebarOpen(false)}>
            <ChatIcon size={17} />
            Conversation
          </button>
          <button type="button" className="sidebar-button" onClick={() => openSettings('connection')}>
            <LinkIcon size={17} />
            Connection
            <span className={`nav-dot tone-${state.cloudConnected ? 'online' : state.p2pConnected ? 'direct' : 'offline'}`} />
          </button>
          <button type="button" className="sidebar-button" onClick={() => openSettings('profile')}>
            <SettingsIcon size={17} />
            Settings
          </button>
        </nav>

        <div className="sidebar-spacer" />

        <div className="security-note">
          <ShieldIcon size={16} />
          <div>
            <strong>Private by design</strong>
            <p>
              {state.storageBackend === 'sqlite'
                ? 'Encrypted local store · verified peers'
                : 'Development browser store · not encrypted at rest'}
            </p>
          </div>
        </div>

        <div className="sidebar-footer">
          <span className="muted small">v0.1.0</span>
          <button
            type="button"
            className="icon-button subtle"
            onClick={() => void onSignOut()}
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOutIcon size={16} />
          </button>
        </div>
      </aside>

      <main className="chat-panel">
        <header className="chat-header">
          <button
            type="button"
            className="icon-button sidebar-toggle"
            onClick={() => setSidebarOpen((value) => !value)}
            aria-label="Toggle sidebar"
          >
            {sidebarOpen ? <XIcon size={18} /> : <ChatIcon size={18} />}
          </button>
          <div className="chat-header-identity">
            <Avatar name={peerName} size={40} online={peerActive} />
            <div>
              <h1>{peerName}</h1>
              <p className="muted small">{subline}</p>
            </div>
          </div>
          <div className="chat-header-actions">
            <span
              className={`mode-pill ${directMode ? 'direct' : ''}`}
              title={
                directMode
                  ? 'Direct mode: no cloud message upload'
                  : 'Cloud mode: messages sync through the cloud'
              }
            >
              {directMode ? 'Direct' : 'Cloud'}
            </span>
            <button
              type="button"
              className="connection-button"
              onClick={() => openSettings('connection')}
              title="Connection details"
            >
              <ConnectionBadge mode={state.connectionMode} queuedMessages={state.queuedCount} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={openManual}
              title="Manual direct connection"
              aria-label="Manual direct connection"
            >
              <KeyIcon size={18} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => openSettings('profile')}
              title="Settings"
              aria-label="Settings"
            >
              <SettingsIcon size={18} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => setClearChatOpen(true)}
              title="Conversation security — Clear Everything"
              aria-label="Conversation security"
            >
              <LockIcon size={18} />
            </button>
          </div>
        </header>

        {errorVisible ? (
          <div className="banner error" role="alert">
            <AlertIcon size={16} />
            <span>{errorVisible}</span>
            <button
              type="button"
              className="icon-button subtle"
              aria-label="Dismiss error"
              onClick={() => engine?.clearNotice()}
            >
              <XIcon size={15} />
            </button>
          </div>
        ) : null}

        {noticeVisible ? (
          <div className="banner info" role="status">
            <LinkIcon size={16} />
            <span>{state.notice}</span>
            <button
              type="button"
              className="icon-button subtle"
              aria-label="Dismiss notice"
              onClick={() => {
                setDismissed(state.notice);
                engine?.clearNotice();
              }}
            >
              <XIcon size={15} />
            </button>
          </div>
        ) : null}

        {state.p2pState === 'connected' && state.peerTrust === 'unverified' ? (
          <div className="banner warning" role="alert">
            <ShieldIcon size={16} />
            <span>
              A direct channel is open but its identity is not cloud-verified.
              Compare the safety number before sending.
            </span>
            <button type="button" className="button small secondary" onClick={openManual}>
              Verify
            </button>
          </div>
        ) : null}

        {state.storageBackend === 'browser' ? (
          <div className="banner subtle" role="note">
            <LockIcon size={16} />
            <span>
              Browser development mode: SQLite is not active and the browser store
              is not encrypted at rest. Run the Tauri desktop app for the real
              local store.
            </span>
          </div>
        ) : null}

        <MessageList
          messages={state.messages}
          selfUid={state.uid}
          peerName={peerName}
          hasOlder={state.hasOlder}
          loadingOlder={state.loadingOlder}
          onLoadOlder={() => void engine?.loadOlder()}
          onRetry={(messageId) => void engine?.retry(messageId)}
          peerDirect={state.p2pConnected}
          directMode={directMode}
        />

        <Composer
          onSend={(text) =>
            engine?.send(text) ?? Promise.resolve({ ok: false as const, error: 'Not ready.' })
          }
          disabled={state.phase !== 'ready'}
          connected={directMode ? state.p2pConnected : state.cloudConnected || state.p2pConnected}
          queued={directMode ? !state.p2pConnected : !state.cloudConnected && !state.p2pConnected}
          directMode={directMode}
        />
      </main>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialSection={settingsSection}
        engine={engine}
        state={state}
        email={user.email ?? ''}
        settings={settings}
        updateSettings={updateSettings}
        onSignOut={onSignOut}
        onOpenManual={openManual}
        onOpenNuke={() => setNukeOpen(true)}
      />

      <ManualConnectDialog
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        engine={engine}
        state={state}
      />

      <NukeDialog
        open={nukeOpen}
        onClose={() => setNukeOpen(false)}
        engine={engine}
        uid={user.uid}
        peerUid={state?.peerUid ?? ''}
        onFinished={async () => {
          // Wipe finished: drop the session so the app lands on the very
          // first identity screen.
          await onSignOut();
        }}
      />

      <ClearChatDialog
        open={clearChatOpen}
        onClose={() => setClearChatOpen(false)}
        engine={engine}
        uid={user.uid}
        peerUid={state?.peerUid ?? ''}
      />
    </div>
  );
}
