import { useEffect, useState, type ReactNode } from 'react';
import { presentConnection } from '@duochat/protocol';
import type { ChatEngine, ChatState } from '../lib/engine';
import type { AppSettings, MessageMode, ThemeMode } from '../lib/settings';
import { ACCENTS } from '../lib/settings';
import { copyText } from '../lib/clipboard';
import { ensureNotificationPermission } from '../lib/notifications';
import { formatLastSeen, truncateMiddle } from '../lib/format';
import { config } from '../config';
import { Modal } from './Modal';
import { Avatar } from './Avatar';
import {
  BellIcon,
  CheckIcon,
  CopyIcon,
  InfoIcon,
  KeyIcon,
  LinkIcon,
  LoaderIcon,
  LockIcon,
  LogOutIcon,
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
  | 'data'
  | 'about';

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: ReactNode }> = [
  { id: 'profile', label: 'Profile', icon: <UserIcon size={16} /> },
  { id: 'appearance', label: 'Appearance', icon: <PaletteIcon size={16} /> },
  { id: 'notifications', label: 'Notifications', icon: <BellIcon size={16} /> },
  { id: 'connection', label: 'Connection', icon: <LinkIcon size={16} /> },
  { id: 'data', label: 'Privacy & data', icon: <LockIcon size={16} /> },
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
  email,
  settings,
  updateSettings,
  onSignOut,
  onOpenManual,
}: {
  open: boolean;
  onClose: () => void;
  initialSection: SettingsSection;
  engine: ChatEngine | null;
  state: ChatState | null;
  email: string;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  onSignOut: () => Promise<void>;
  onOpenManual: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [name, setName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameStatus, setNameStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmCloudUpload, setConfirmCloudUpload] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [permission, setPermission] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    setSection(initialSection);
    setName(state?.selfProfile?.displayName ?? '');
    setNameStatus(null);
    setConfirmCloudUpload(false);
    setClearConfirm(false);
    setCopied(false);
    setPermission(
      typeof Notification !== 'undefined' ? Notification.permission : 'unavailable',
    );
  }, [open, initialSection, state?.selfProfile?.displayName]);

  async function saveName() {
    if (!engine) return;
    setSavingName(true);
    setNameStatus(null);
    try {
      await engine.changeDisplayName(name);
      setNameStatus('Display name saved.');
    } catch (caught) {
      setNameStatus(caught instanceof Error ? caught.message : 'Could not save the name.');
    } finally {
      setSavingName(false);
    }
  }

  async function copyDiagnostics() {
    if (!state) return;
    const diagnostics = {
      app: 'DuoChat Desktop',
      version: config.appVersion,
      conversationId: state.conversationId,
      connectionMode: state.connectionMode,
      presentation: presentConnection(state.connectionMode, state.queuedCount),
      cloudConnected: state.cloudConnected,
      p2pState: state.p2pState,
      p2pConnected: state.p2pConnected,
      peerTrust: state.peerTrust,
      peerKeySource: state.peerKeySource,
      safetyNumber: state.safetyNumber,
      queuedMessages: state.queuedCount,
      storageBackend: state.storageBackend,
      lastSyncAt: state.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : null,
      stun: config.stunUrls,
      turnConfigured: Boolean(config.turn),
      peerLastSeen: state.peerProfile?.lastSeenAt
        ? new Date(state.peerProfile.lastSeenAt).toISOString()
        : null,
    };
    setCopied(await copyText(JSON.stringify(diagnostics, null, 2)));
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function requestNotifications() {
    const granted = await ensureNotificationPermission();
    setPermission(granted ? 'granted' : 'denied');
    updateSettings({ notificationsEnabled: granted });
  }

  function chooseMessageMode(mode: MessageMode) {
    if (mode === settings.messageMode) return;
    if (
      mode === 'cloud' &&
      settings.messageMode === 'direct' &&
      (state?.queuedCount ?? 0) > 0
    ) {
      setConfirmCloudUpload(true);
      return;
    }
    setConfirmCloudUpload(false);
    updateSettings({ messageMode: mode });
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
                <h3>Your profile</h3>
                <p className="muted">
                  Visible only to the other approved member of this conversation.
                </p>
              </header>
              <div className="profile-row">
                <Avatar name={name || state?.selfProfile?.displayName || 'You'} size={58} />
                <div>
                  <strong>{name || 'Your name'}</strong>
                  <p className="muted small">
                    {email} · {state?.selfProfile?.lastSeenAt ? formatLastSeen(state.selfProfile.lastSeenAt) : 'Presence unavailable'}
                  </p>
                </div>
              </div>
              <label className="field">
                <span>Display name</span>
                <input
                  value={name}
                  maxLength={40}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Display name"
                />
              </label>
              <div className="button-row">
                <button
                  type="button"
                  className="button primary"
                  disabled={savingName || name.trim().length === 0}
                  onClick={() => void saveName()}
                >
                  {savingName ? <LoaderIcon size={15} className="spin" /> : <CheckIcon size={15} />}
                  Save display name
                </button>
              </div>
              {nameStatus ? <p className="status-text">{nameStatus}</p> : null}
              <dl className="detail-grid">
                <div>
                  <dt>Your user ID</dt>
                  <dd className="mono selectable">{state?.uid ?? '—'}</dd>
                </div>
                <div>
                  <dt>Conversation</dt>
                  <dd className="mono">{state?.conversationId ?? config.conversationId}</dd>
                </div>
              </dl>
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
                  Desktop notifications are shown while DuoChat is running or in
                  the background. Android delivery uses Firebase Cloud Messaging.
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
                  Push notifications are best-effort and cannot be guaranteed
                  during a complete cloud outage. Direct messaging does not
                  depend on them while both apps are open.
                </p>
              </div>
            </section>
          ) : null}

          {section === 'connection' ? (
            <section className="settings-section">
              <header>
                <h3>Connection & diagnostics</h3>
                <p className="muted">
                  {settings.messageMode === 'direct'
                    ? 'Direct message route selected. Cloud is used only for signaling and profile metadata.'
                    : presentation.detail}
                </p>
              </header>
              <div className="setting-block">
                <span className="setting-label">Message route</span>
                <div className="segmented" role="group" aria-label="Message route">
                  {(['cloud', 'direct'] as MessageMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={settings.messageMode === mode ? 'active' : ''}
                      onClick={() => chooseMessageMode(mode)}
                      aria-pressed={settings.messageMode === mode}
                    >
                      {mode === 'cloud' ? 'Cloud' : 'Direct'}
                    </button>
                  ))}
                </div>
                <p className="muted small">
                  {settings.messageMode === 'direct'
                    ? 'Messages use only the authenticated peer channel. No message text is uploaded to the cloud.'
                    : 'Messages use the normal cloud sync path alongside the direct channel.'}
                </p>
              </div>
              {confirmCloudUpload ? (
                <div className="callout warning" role="alert">
                  <InfoIcon size={17} />
                  <div>
                    <strong>
                      Upload {state?.queuedCount ?? 0} queued message
                      {(state?.queuedCount ?? 0) === 1 ? '?' : 's?'}
                    </strong>
                    <p>
                      Switching to Cloud mode uploads messages that are still waiting
                      to be delivered. Cancel to keep them local in Direct mode.
                    </p>
                    <div className="button-row">
                      <button
                        type="button"
                        className="button primary small"
                        onClick={() => {
                          setConfirmCloudUpload(false);
                          updateSettings({ messageMode: 'cloud' });
                        }}
                      >
                        Switch &amp; upload
                      </button>
                      <button
                        type="button"
                        className="button ghost small"
                        onClick={() => setConfirmCloudUpload(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
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
                  <dt>Cloud sync</dt>
                  <dd>{state?.cloudConnected ? 'Connected' : 'Unavailable'}</dd>
                </div>
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
                  <dt>Peer key source</dt>
                  <dd>{state?.peerKeySource ?? '—'}</dd>
                </div>
                <div>
                  <dt>Local storage</dt>
                  <dd>{state?.storageBackend === 'sqlite' ? 'SQLite (encrypted payloads)' : 'Browser dev store'}</dd>
                </div>
                <div>
                  <dt>Last cloud sync</dt>
                  <dd>{state?.lastSyncAt ? formatLastSeen(state.lastSyncAt) : '—'}</dd>
                </div>
                <div>
                  <dt>STUN</dt>
                  <dd>{config.stunUrls.length} server{config.stunUrls.length === 1 ? '' : 's'}</dd>
                </div>
                <div>
                  <dt>TURN relay</dt>
                  <dd>{config.turn ? 'Configured' : 'Disabled'}</dd>
                </div>
              </dl>
              {state?.safetyNumber ? (
                <div className="safety-block">
                  <span className="setting-label">
                    <ShieldIcon size={15} /> Safety number
                  </span>
                  <code className="safety-number selectable">{state.safetyNumber}</code>
                  <p className="muted small">
                    Compare this with your friend over a separate channel before
                    trusting a direct connection that is not cloud-verified.
                  </p>
                </div>
              ) : null}
              <div className="button-row wrap">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => engine?.requestDirectConnection()}
                >
                  <RefreshIcon size={15} />
                  Reconnect now
                </button>
                <button type="button" className="button secondary" onClick={onOpenManual}>
                  <KeyIcon size={15} />
                  Manual connection
                </button>
                <button type="button" className="button ghost" onClick={() => void copyDiagnostics()}>
                  {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
                  {copied ? 'Diagnostics copied' : 'Copy diagnostics'}
                </button>
              </div>
              <div className="callout subtle">
                <InfoIcon size={17} />
                <p>
                  Automatic signaling uses the cloud. An already-established
                  direct channel keeps working when the cloud fails. With no
                  cloud and no direct path, use manual setup or wait for a network
                  path to return.
                </p>
              </div>
            </section>
          ) : null}

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
                  Cloud messages are protected by TLS and Firestore rules, but
                  they are not end-to-end encrypted. Someone with authorized
                  project access could read stored messages. DuoChat does not
                  claim E2EE.
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
                    Deletes local messages, metadata, and queued unsent messages.
                    Cloud history is not deleted and can be restored on next sync.
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
                <div>
                  <dt>Firebase project</dt>
                  <dd className="mono">{config.firebase.projectId || '—'}</dd>
                </div>
                <div>
                  <dt>Emulator mode</dt>
                  <dd>{config.emulatorHost || 'Off'}</dd>
                </div>
              </dl>
              <p className="muted small">
                Cloud access is enforced by Firestore rules and a two-member
                allowlist. Peer connections use challenge-response identity proof
                plus manual safety-number verification when signaling is offline.
              </p>
              <button type="button" className="button secondary" onClick={() => void onSignOut()}>
                <LogOutIcon size={15} />
                Sign out
              </button>
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
