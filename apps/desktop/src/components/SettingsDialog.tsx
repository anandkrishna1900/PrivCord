import { useEffect, useState, type ReactNode } from 'react';
import { presentConnection } from '@duochat/protocol';
import type { ChatEngine, ChatState } from '../lib/engine';
import type { AppSettings, ThemeMode } from '../lib/settings';
import { ACCENTS } from '../lib/settings';
import { copyText } from '../lib/clipboard';
import { ensureNotificationPermission } from '../lib/notifications';
import { truncateMiddle } from '../lib/format';
import { config } from '../config';
import { loadNetworkConfig } from '../lib/network';
import { Modal } from './Modal';
import { NetworkSettings } from './NetworkSettings';
import { Avatar } from './Avatar';
import {
  AlertIcon,
  BellIcon,
  CheckIcon,
  CopyIcon,
  InfoIcon,
  KeyIcon,
  LinkIcon,
  LoaderIcon,
  LockIcon,
  PaletteIcon,
  RefreshIcon,
  SettingsIcon,
  ShieldIcon,
  TrashIcon,
  UserIcon,
} from './Icons';

export type SettingsSection =
  | 'profile'
  | 'appearance'
  | 'notifications'
  | 'connection'
  | 'network'
  | 'data'
  | 'security'
  | 'about';

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: ReactNode }> = [
  { id: 'profile', label: 'Profile', icon: <UserIcon size={16} /> },
  { id: 'appearance', label: 'Appearance', icon: <PaletteIcon size={16} /> },
  { id: 'notifications', label: 'Notifications', icon: <BellIcon size={16} /> },
  { id: 'connection', label: 'Connection', icon: <LinkIcon size={16} /> },
  { id: 'network', label: 'Network', icon: <RefreshIcon size={16} /> },
  { id: 'data', label: 'Privacy & data', icon: <LockIcon size={16} /> },
  { id: 'security', label: 'Security', icon: <ShieldIcon size={16} /> },
  { id: 'about', label: 'About', icon: <InfoIcon size={16} /> },
];

function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-row">
      <div>
        <strong>{label}</strong>
        <p className="muted small">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
        disabled={disabled}
      >
        <span />
      </button>
    </div>
  );
}

export function SettingsDialog({
  open,
  onClose,
  initialSection,
  engine,
  state,
  settings,
  updateSettings,
  onOpenManual,
  onOpenNuke,
  onOpenRecovery,
}: {
  open: boolean;
  onClose: () => void;
  initialSection: SettingsSection;
  engine: ChatEngine | null;
  state: ChatState | null;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  onOpenManual: () => void;
  onOpenNuke: () => void;
  onOpenRecovery?: (mode: 'backup' | 'restore') => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [nickname, setNickname] = useState(settings.peerNickname);
  const [nameStatus, setNameStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [permission, setPermission] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    setSection(initialSection);
    setNickname(settings.peerNickname);
    setNameStatus(null);
    setResetConfirm(false);
    setClearConfirm(false);
    setCopied(false);
    setPermission(
      typeof Notification !== 'undefined' ? Notification.permission : 'unavailable',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSection]);

  function saveNickname() {
    updateSettings({ peerNickname: nickname.trim() });
    setNameStatus('Saved on this device.');
  }

  async function copyDiagnostics() {
    if (!state) return;
    const diagnostics = {
      app: 'DuoChat Desktop',
      version: config.appVersion,
      conversationId: state.conversationId,
      connectionMode: state.connectionMode,
      presentation: presentConnection(state.connectionMode, state.queuedCount),
      p2pState: state.p2pState,
      p2pConnected: state.p2pConnected,
      peerTrust: state.peerTrust,
      paired: state.paired,
      safetyNumber: state.safetyNumber,
      queuedMessages: state.queuedCount,
      storageBackend: state.storageBackend,
      path: state.path,
      signaling: state.signaling,
      network: loadNetworkConfig(),
    };
    setCopied(await copyText(JSON.stringify(diagnostics, null, 2)));
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function requestNotifications() {
    const granted = await ensureNotificationPermission();
    setPermission(granted ? 'granted' : 'denied');
    updateSettings({ notificationsEnabled: granted });
  }

  const mode = state?.connectionMode ?? 'OFFLINE_QUEUED';
  const presentation = presentConnection(mode, state?.queuedCount ?? 0);

  return (
    <Modal open={open} onClose={onClose} eyebrow="DuoChat" title="Settings" wide>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`settings-nav-button ${section === item.id ? 'active' : ''}`}
              onClick={() => setSection(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {section === 'profile' ? (
            <section className="settings-section">
              <header>
                <h3>You &amp; your friend</h3>
                <p className="muted">
                  There are no accounts. Your identity is a key that lives on this
                  device; your friend is the device you paired with.
                </p>
              </header>
              <div className="profile-row">
                <Avatar name={nickname || 'Friend'} size={58} />
                <div>
                  <strong>{nickname || 'Your friend'}</strong>
                  <p className="muted small">
                    {state?.paired ? 'Paired' : 'Not paired yet'} ·{' '}
                    {state?.p2pConnected ? 'connected now' : 'not connected'}
                  </p>
                </div>
              </div>
              <label className="field">
                <span>Nickname for your friend</span>
                <input
                  value={nickname}
                  maxLength={40}
                  onChange={(event) => setNickname(event.target.value)}
                  placeholder="Your friend"
                />
              </label>
              <div className="button-row">
                <button
                  type="button"
                  className="button primary"
                  disabled={nickname.trim() === settings.peerNickname}
                  onClick={saveNickname}
                >
                  <CheckIcon size={15} />
                  Save nickname
                </button>
              </div>
              {nameStatus ? <p className="status-text">{nameStatus}</p> : null}
              <dl className="detail-grid">
                <div>
                  <dt>Your ID</dt>
                  <dd className="mono selectable">{state?.uid ?? '—'}</dd>
                </div>
                <div>
                  <dt>Friend&apos;s ID</dt>
                  <dd className="mono selectable">{state?.peerUid ?? '—'}</dd>
                </div>
              </dl>
              {state?.paired ? (
                <div className="danger-zone">
                  <div>
                    <strong>Reset pairing</strong>
                    <p className="muted small">
                      Forgets your friend&apos;s key so a different device can be paired.
                      Messages are kept.
                    </p>
                  </div>
                  {resetConfirm ? (
                    <div className="button-row">
                      <button
                        type="button"
                        className="button danger"
                        onClick={() => {
                          engine?.resetPairing();
                          setResetConfirm(false);
                        }}
                      >
                        Yes, reset pairing
                      </button>
                      <button type="button" className="button ghost" onClick={() => setResetConfirm(false)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="button danger ghost" onClick={() => setResetConfirm(true)}>
                      Reset pairing
                    </button>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}

          {section === 'appearance' ? (
            <section className="settings-section">
              <header>
                <h3>Appearance</h3>
                <p className="muted">Theme and accent are stored on this device.</p>
              </header>
              <div className="setting-block">
                <span className="setting-label">Theme</span>
                <div className="segmented" role="group" aria-label="Theme">
                  {(['system', 'dark', 'light'] as ThemeMode[]).map((theme) => (
                    <button
                      key={theme}
                      type="button"
                      className={settings.theme === theme ? 'active' : ''}
                      onClick={() => updateSettings({ theme })}
                      aria-pressed={settings.theme === theme}
                    >
                      {theme === 'system' ? 'System' : theme === 'dark' ? 'Dark' : 'Light'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-block">
                <span className="setting-label">Accent color</span>
                <div className="swatches">
                  {ACCENTS.map((accent) => (
                    <button
                      key={accent.value}
                      type="button"
                      className={`swatch ${settings.accent === accent.value ? 'active' : ''}`}
                      style={{ background: accent.value }}
                      onClick={() => updateSettings({ accent: accent.value })}
                      aria-label={accent.name}
                      aria-pressed={settings.accent === accent.value}
                      title={accent.name}
                    >
                      {settings.accent === accent.value ? <CheckIcon size={15} /> : null}
                    </button>
                  ))}
                </div>
              </div>
              <div className="theme-preview">
                <div className="preview-bubble theirs">How does this look?</div>
                <div className="preview-bubble own">Clean, readable, and yours.</div>
              </div>
            </section>
          ) : null}

          {section === 'notifications' ? (
            <section className="settings-section">
              <header>
                <h3>Notifications</h3>
                <p className="muted">
                  Desktop notifications are shown while DuoChat is running and
                  connected to your friend.
                </p>
              </header>
              <Toggle
                label="Desktop notifications"
                description="Show a system notification for new messages."
                checked={settings.notificationsEnabled}
                onChange={(value) => updateSettings({ notificationsEnabled: value })}
              />
              <Toggle
                label="Message previews"
                description="Include message text in notifications. Turn off for privacy."
                checked={settings.notificationPreviews}
                onChange={(value) => updateSettings({ notificationPreviews: value })}
                disabled={!settings.notificationsEnabled}
              />
              <div className="button-row">
                <button type="button" className="button secondary" onClick={() => void requestNotifications()}>
                  <BellIcon size={15} />
                  Request OS permission
                </button>
              </div>
              <p className="muted small">
                Current permission: <strong>{permission}</strong>
              </p>
              <div className="callout subtle">
                <InfoIcon size={17} />
                <p>
                  With no server there is no push service: you are notified
                  only while the app is open and a direct connection is active.
                </p>
              </div>
            </section>
          ) : null}

          {section === 'connection' ? (
            <section className="settings-section">
              <header>
                <h3>Connection & diagnostics</h3>
                <p className="muted">{presentation.detail}</p>
              </header>
              <div className={`connection-summary tone-${presentation.tone}`}>
                <span className="connection-dot" />
                <strong>{presentation.label}</strong>
                <span className="muted small">
                  {state?.queuedCount ?? 0} queued message
                  {(state?.queuedCount ?? 0) === 1 ? '' : 's'}
                </span>
              </div>
              <dl className="detail-grid">
                <div>
                  <dt>Direct channel</dt>
                  <dd>
                    {state?.p2pConnected
                      ? 'Connected'
                      : state?.p2pState === 'connecting'
                        ? 'Negotiating'
                        : state?.p2pState === 'failed'
                          ? 'Failed'
                          : 'Idle'}
                  </dd>
                </div>
                <div>
                  <dt>Peer identity</dt>
                  <dd>{state?.peerTrust ?? 'none'}</dd>
                </div>
                <div>
                  <dt>Local storage</dt>
                  <dd>{state?.storageBackend === 'sqlite' ? 'SQLite (encrypted payloads)' : 'Browser dev store'}</dd>
                </div>
                <div>
                  <dt>Path</dt>
                  <dd>{state?.path ? state.path.label : state?.p2pConnected ? 'Measuring…' : '—'}</dd>
                </div>
                <div>
                  <dt>Signaling</dt>
                  <dd>{state?.signaling ?? 'idle'}</dd>
                </div>
                <div>
                  <dt>STUN / TURN</dt>
                  <dd>
                    {loadNetworkConfig().stun.length} STUN · {loadNetworkConfig().turn.length} TURN
                  </dd>
                </div>
              </dl>
              {state?.path ? (
                <div className={`callout ${state.path.kind === 'relayed' ? 'warning' : 'subtle'}`}>
                  <InfoIcon size={17} />
                  <p>
                    <strong>{state.path.label}.</strong> {state.path.detail}
                  </p>
                </div>
              ) : null}
              {state?.safetyNumber ? (
                <div className="safety-block">
                  <span className="setting-label">
                    <ShieldIcon size={15} /> Safety number
                  </span>
                  <code className="safety-number selectable">{state.safetyNumber}</code>
                  <p className="muted small">
                    Compare this with your friend over a separate channel before
                    trusting a new device.
                  </p>
                </div>
              ) : null}
              <div className="button-row wrap">
                <button type="button" className="button secondary" onClick={onOpenManual}>
                  <KeyIcon size={15} />
                  {state?.paired ? 'Connect with a code' : 'Pair with a code'}
                </button>
                <button type="button" className="button ghost" onClick={() => void copyDiagnostics()}>
                  {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
                  {copied ? 'Diagnostics copied' : 'Copy diagnostics'}
                </button>
              </div>
              <div className="callout subtle">
                <InfoIcon size={17} />
                <p>
                  Paired friends reconnect automatically through the signaling service
                  you configure under Network. Without one, use a connection code: one of
                  you creates it, the other pastes it and sends a reply. Either way, messages
                  then go directly between your devices (or through your TURN server, if
                  that is the only path, and the path above tells you which).
                </p>
              </div>
            </section>
          ) : null}

          {section === 'network' ? <NetworkSettings engine={engine} state={state} /> : null}

          {section === 'data' ? (
            <section className="settings-section">
              <header>
                <h3>Privacy & local data</h3>
                <p className="muted">
                  Local message text is encrypted at rest with AES-GCM. The key is
                  kept in the operating system credential store.
                </p>
              </header>
              <div className="callout">
                <LockIcon size={17} />
                <p>
                  Messages never leave your two devices. They travel over an
                  encrypted direct connection and are stored encrypted on each
                  device. There is no server that could read or keep them.
                </p>
              </div>
              <dl className="detail-grid">
                <div>
                  <dt>Queued messages</dt>
                  <dd>{state?.queuedCount ?? 0}</dd>
                </div>
                <div>
                  <dt>Storage engine</dt>
                  <dd>{state?.storageBackend === 'sqlite' ? 'SQLite' : 'Browser local storage'}</dd>
                </div>
                <div>
                  <dt>Device identity</dt>
                  <dd className="mono">{truncateMiddle(localStorage.getItem('duochat.device-id') ?? '—')}</dd>
                </div>
              </dl>
              <div className="danger-zone">
                <div>
                  <strong>Clear local cache</strong>
                  <p className="muted small">
                    Deletes local messages and queued unsent messages. This cannot
                    be undone: no copy exists anywhere else.
                  </p>
                </div>
                {clearConfirm ? (
                  <div className="button-row">
                    <button
                      type="button"
                      className="button danger"
                      disabled={clearing}
                      onClick={() => {
                        setClearing(true);
                        void engine?.clearLocalData().finally(() => {
                          setClearing(false);
                          setClearConfirm(false);
                        });
                      }}
                    >
                      {clearing ? <LoaderIcon size={15} className="spin" /> : <TrashIcon size={15} />}
                      {clearing ? 'Clearing…' : 'Yes, clear local data'}
                    </button>
                    <button type="button" className="button ghost" onClick={() => setClearConfirm(false)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" className="button danger ghost" onClick={() => setClearConfirm(true)}>
                    <TrashIcon size={15} />
                    Clear local cache
                  </button>
                )}
              </div>
            </section>
          ) : null}

          {section === 'security' ? (
            <section className="settings-section">
              <header>
                <h3>Security &amp; Emergency Actions</h3>
                <p className="muted">
                  Emergency deletion for this device. Deletion never touches the
                  other person's device, screenshots, exports, or external
                  backups.
                </p>
              </header>

              <div className="card-box" style={{ padding: '16px', border: '1px solid var(--border-subtle)', borderRadius: '12px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <KeyIcon size={18} />
                  <strong>Your 12-word recovery phrase</strong>
                </div>
                <p className="muted small" style={{ marginBottom: '12px' }}>
                  Your identity is derived from your 12-word phrase. DuoChat never stores it, so it cannot
                  be shown again: keep your written copy safe. On a new device or after a wipe, enter it
                  here to get the same identity and keep your paired friend.
                </p>
                <div className="button-row">
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => {
                      onClose();
                      onOpenRecovery?.('restore');
                    }}
                  >
                    Restore identity from phrase
                  </button>
                </div>
              </div>

              <div className="emergency-block">
                <div>
                  <strong>NUKE DUOCHAT — app-wide emergency erase</strong>
                  <p className="muted small">
                    Permanently deletes this device's conversations, contacts,
                    cached media, keys, session state, and app settings, then
                    returns DuoChat to its initial identity setup. Requires two
                    deliberate confirmation steps.
                  </p>
                </div>
                <div className="button-row">
                  <button
                    type="button"
                    className="button danger"
                    onClick={() => {
                      onClose();
                      onOpenNuke();
                    }}
                  >
                    <AlertIcon size={15} />
                    NUKE DUOCHAT
                  </button>
                </div>
              </div>
              <div className="callout subtle">
                <ShieldIcon size={17} />
                <p>
                  Per-conversation emergency deletion lives in the conversation
                  security menu (shield button in the chat header) under
                  <strong> Security → Clear Everything</strong>, with separate
                  &ldquo;CLEAR LOCAL CHAT&rdquo; and &ldquo;DELETE CHAT AND LOCAL
                  SESSION STATE&rdquo; options.
                </p>
              </div>
            </section>
          ) : null}

          {section === 'about' ? (
            <section className="settings-section">
              <header>
                <h3>About DuoChat</h3>
                <p className="muted">Private messaging for exactly two people.</p>
              </header>
              <div className="about-hero">
                <div className="brand-lock">
                  <ShieldIcon size={24} />
                </div>
                <div>
                  <strong>DuoChat Desktop</strong>
                  <p className="muted small">Version {config.appVersion} · Tauri 2 / React</p>
                </div>
              </div>
              <dl className="detail-grid">
                <div>
                  <dt>Conversation</dt>
                  <dd className="mono">{state?.conversationId}</dd>
                </div>
              </dl>
              <p className="muted small">
                Peer connections use a challenge-response identity proof and a
                safety number you compare with your friend. No accounts, no
                servers, no analytics.
              </p>
            </section>
          ) : null}
        </div>
      </div>

      <div className="settings-footer">
        <span className="muted small">
          <SettingsIcon size={13} /> Settings apply to this device
        </span>
        <button type="button" className="button ghost small" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
