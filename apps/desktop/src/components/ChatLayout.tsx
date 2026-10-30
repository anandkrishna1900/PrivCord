import { useEffect, useState } from 'react';
import type { ChatEngine, ChatState } from '../lib/engine';
import type { AppSettings } from '../lib/settings';
import { LOCAL_ID } from '../lib/identity';
import { Avatar } from './Avatar';
import { ConnectionBadge } from './ConnectionBadge';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { SettingsDialog, type SettingsSection } from './SettingsDialog';
import { ManualConnectDialog } from './ManualConnectDialog';
import { ClearChatDialog, NukeDialog } from './KillSwitchDialogs';
import { RecoveryDialog } from './RecoveryDialogs';
import { ContactDialog } from './ContactDialog';
import {
  AlertIcon,
  CheckIcon,
  ChatIcon,
  KeyIcon,
  LinkIcon,
  LoaderIcon,
  LockIcon,
  RefreshIcon,
  SettingsIcon,
  ShieldIcon,
  UserIcon,
  XIcon,
} from './Icons';

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('profile');
  const [manualOpen, setManualOpen] = useState(false);
  const [nukeOpen, setNukeOpen] = useState(false);
  const [clearChatOpen, setClearChatOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState<'backup' | 'restore'>('restore');
  const [contactOpen, setContactOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const peerName = settings.peerNickname || 'Your friend';
  const selfName = 'You';

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
          <button type="button" className="button secondary" onClick={() => window.location.reload()}>
            <RefreshIcon size={16} />
            Reload
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
          <button type="button" className="button secondary" onClick={() => window.location.reload()}>
            <RefreshIcon size={16} />
            Reload
          </button>
        </section>
      </main>
    );
  }

  const peerActive = state.p2pConnected;
  const relayed = state.path?.kind === 'relayed';
  const subline = state.p2pConnected
    ? (state.path?.label ?? 'Direct connection active')
    : state.paired
      ? 'Not connected'
      : 'Not paired yet';
  const noticeVisible = state.notice && state.notice !== dismissed;
  const errorVisible = state.error;

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
            <span className="muted small">This device</span>
          </div>
        </div>

        <div className="peer-mini">
          <Avatar name={peerName} size={42} online={peerActive} />
          <div>
            <strong>{peerName}</strong>
            <span className={`muted small ${relayed ? 'path-relayed' : ''}`}>{subline}</span>
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
            <span className={`nav-dot tone-${state.p2pConnected ? 'direct' : 'offline'}`} />
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
              <p className={`muted small ${relayed ? 'path-relayed' : ''}`}>{subline}</p>
            </div>
          </div>
          <div className="chat-header-actions">
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
              onClick={() => setContactOpen(true)}
              title={state.paired ? 'Friend' : 'Add your friend'}
              aria-label="Add your friend"
            >
              <UserIcon size={18} />
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
              A direct channel is open but this device is not verified yet.
              Compare the safety number with your friend, then confirm it.
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
          onRetry={(messageId) => void engine?.retry(messageId)}
          peerDirect={state.p2pConnected}
          paired={state.paired}
        />

        <Composer
          onSend={(text) =>
            engine?.send(text) ?? Promise.resolve({ ok: false as const, error: 'Not ready.' })
          }
          disabled={state.phase !== 'ready'}
          connected={state.p2pConnected}
        />
      </main>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialSection={settingsSection}
        engine={engine}
        state={state}
        settings={settings}
        updateSettings={updateSettings}
        onOpenManual={openManual}
        onOpenNuke={() => setNukeOpen(true)}
        onOpenRecovery={(mode) => {
          setRecoveryMode(mode);
          setRecoveryOpen(true);
        }}
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
        uid={LOCAL_ID}
        peerUid={state?.peerUid ?? ''}
        onFinished={async () => {
          // Wipe finished: reload so the app starts over with a fresh identity.
          window.location.reload();
        }}
      />

      <ClearChatDialog
        open={clearChatOpen}
        onClose={() => setClearChatOpen(false)}
        engine={engine}
        uid={LOCAL_ID}
        peerUid={state?.peerUid ?? ''}
      />

      <RecoveryDialog
        open={recoveryOpen}
        onClose={() => setRecoveryOpen(false)}
        mode={recoveryMode}
        onIdentityReady={() => window.location.reload()}
      />

      <ContactDialog
        open={contactOpen}
        onClose={() => setContactOpen(false)}
        engine={engine}
        state={state}
      />
    </div>
  );
}
