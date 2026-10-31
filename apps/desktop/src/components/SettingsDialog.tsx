import { useEffect, useRef, useState } from 'react';
import { disableLock, enableLock, isLockEnabled, lockSupported, unlock } from '../lib/appLock';
import type { ChatEngine, ChatState } from '../lib/engine';
import type { AppSettings, ThemeMode } from '../lib/settings';
import { ACCENTS } from '../lib/settings';
import { THEMES, themeVars } from '../lib/themes';
import { ensureNotificationPermission } from '../lib/notifications';
import { config } from '../config';
import { Modal } from './Modal';
import { NetworkSettings } from './NetworkSettings';
import { AlertIcon, CheckIcon, KeyIcon, TrashIcon } from './Icons';

export type SettingsSection = 'profile' | 'appearance' | 'connection' | 'security' | 'about';

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'profile', label: 'Profile' },
  { id: 'appearance', label: 'Look' },
  { id: 'connection', label: 'Connection' },
  { id: 'security', label: 'Security' },
  { id: 'about', label: 'About' },
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

function BackupControl({ engine }: { engine: ChatEngine | null }) {
  const [pass, setPass] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function backUp() {
    if (!engine) return;
    setBusy(true);
    setMessage(null);
    try {
      const text = await engine.exportBackup(pass);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `privcord-backup-${new Date().toISOString().slice(0, 10)}.privcord`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMessage({ text: 'Backup saved. Keep the file and the passphrase safe: you need both, and nobody can recover the passphrase.', error: false });
    } catch (caught) {
      setMessage({ text: caught instanceof Error ? caught.message : 'Could not make the backup.', error: true });
    } finally {
      setBusy(false);
    }
  }

  async function restore(file: File) {
    if (!engine) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await engine.importBackup(await file.text(), pass);
      setMessage({ text: `Restored ${result.friends} friends, ${result.groups} groups and ${result.messages} messages.`, error: false });
    } catch (caught) {
      setMessage({ text: caught instanceof Error ? caught.message : 'Could not restore.', error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card-box">
      <div className="card-title">
        <KeyIcon size={18} />
        <strong>Back up and restore chats</strong>
      </div>
      <p className="muted small">
        Saves your friends, groups, channels and messages (not photos or files) in one file, locked with a passphrase you
        choose. Restoring adds to what is here and needs the same identity (restore the 12-word phrase first on a new device).
      </p>
      <input
        type="password"
        aria-label="Backup passphrase"
        placeholder="Passphrase (at least 8 characters)"
        value={pass}
        onChange={(event) => setPass(event.target.value)}
      />
      <div className="button-row">
        <button type="button" className="button secondary small" disabled={busy || pass.length < 8} onClick={() => void backUp()}>
          Save a backup
        </button>
        <button type="button" className="button secondary small" disabled={busy || pass.length < 8} onClick={() => fileRef.current?.click()}>
          Restore from a file
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          aria-label="Backup file"
          onChange={(event) => {
            const f = event.target.files?.[0];
            event.target.value = '';
            if (f) void restore(f);
          }}
        />
      </div>
      {message ? (
        <p className={`status-text ${message.error ? 'error' : ''}`} role={message.error ? 'alert' : 'status'}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

function AppLockControl() {
  const [on, setOn] = useState(isLockEnabled());
  const [supported, setSupported] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void lockSupported().then(setSupported);
  }, []);

  async function change(next: boolean) {
    setError(null);
    try {
      if (next) {
        await enableLock();
        setOn(true);
      } else {
        // Turning it off needs the same proof as opening the app.
        if (!(await unlock())) throw new Error('That did not work.');
        disableLock();
        setOn(false);
      }
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : 'Cancelled.');
    }
  }

  return (
    <>
      <Toggle
        label="Lock PrivCord with Windows Hello"
        description={
          supported === false
            ? 'Not available: this device has no passkey sign-in (Windows Hello, fingerprint, face or PIN) set up.'
            : 'Ask for your face, fingerprint or PIN to open PrivCord, and again after it has been out of sight for 5 minutes. It keeps other people at your computer out; it does not replace the encryption of the files on disk.'
        }
        checked={on}
        onChange={(value) => void change(value)}
        disabled={supported === false && !on}
      />
      {on ? (
        <button type="button" className="button secondary small" onClick={() => window.dispatchEvent(new Event('privcord:lock'))}>
          Lock now
        </button>
      ) : null}
      {error ? (
        <p className="status-text error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

const SIGNALING_TEXT: Record<string, string> = {
  online: 'Online. Friends can find you.',
  connecting: 'Connecting…',
  idle: 'No connection service is on. Only Bluetooth and open connections work.',
  error: 'Could not reach the connection service. Retrying.',
};

export function SettingsDialog({
  open,
  onClose,
  initialSection,
  engine,
  state,
  settings,
  updateSettings,
  onOpenNuke,
  onOpenClearChats,
  onOpenRecovery,
}: {
  open: boolean;
  onClose: () => void;
  initialSection: SettingsSection;
  engine: ChatEngine | null;
  state: ChatState;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  onOpenNuke: () => void;
  onOpenClearChats: () => void;
  onOpenRecovery: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [displayName, setDisplayName] = useState(settings.displayName);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSection(initialSection);
    setDisplayName(settings.displayName);
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSection]);

  const connected = state.contacts.filter((c) => c.conn === 'connected').length;

  return (
    <Modal open={open} onClose={onClose} title="Settings" wide>
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={section === item.id}
            className={`tab ${section === item.id ? 'active' : ''}`}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="settings-content">
        {section === 'profile' ? (
          <section className="settings-section">
            <label className="field">
              <span>Your name</span>
              <input
                value={displayName}
                maxLength={40}
                placeholder="What friends see"
                onChange={(event) => {
                  setDisplayName(event.target.value);
                  setSaved(false);
                }}
              />
            </label>
            <div className="button-row">
              <button
                type="button"
                className="button primary"
                disabled={displayName.trim() === settings.displayName}
                onClick={() => {
                  updateSettings({ displayName: displayName.trim() });
                  void engine?.refreshOwnName(displayName);
                  setSaved(true);
                }}
              >
                <CheckIcon size={15} />
                Save
              </button>
            </div>
            {saved ? (
              <p className="status-text">Saved. Friends see this name on invites you share from now on.</p>
            ) : (
              <p className="muted small">Shown on your invite. There are no accounts: your identity lives on this device.</p>
            )}
          </section>
        ) : null}

        {section === 'appearance' ? (
          <section className="settings-section">
            <div className="setting-block">
              <span className="setting-label">Color theme</span>
              <div className="theme-grid" role="group" aria-label="Color theme">
                <button
                  type="button"
                  className={`theme-tile ${settings.palette === 'classic' ? 'active' : ''}`}
                  onClick={() => updateSettings({ palette: 'classic' })}
                  aria-pressed={settings.palette === 'classic'}
                >
                  <span className="theme-preview classic" aria-hidden="true" />
                  <span>Classic</span>
                </button>
                {THEMES.map((t) => {
                  const v = themeVars(t);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={`theme-tile ${settings.palette === t.id ? 'active' : ''}`}
                      onClick={() => updateSettings({ palette: t.id })}
                      aria-pressed={settings.palette === t.id}
                    >
                      <span className="theme-preview" style={{ background: t.bg, borderColor: v['--border-strong'] }} aria-hidden="true">
                        <span style={{ background: t.surface }} />
                        <span style={{ background: v['--accent-fill'] }} />
                      </span>
                      <span>{t.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {settings.palette === 'classic' ? (
              <>
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
                    {theme === 'system' ? 'Auto' : theme === 'dark' ? 'Dark' : 'Light'}
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
              </>
            ) : (
              <p className="muted small">The color theme sets the light or dark look and the accent color.</p>
            )}
            <Toggle
              label="Notifications"
              description="Show a system notification for new messages while the app is open."
              checked={settings.notificationsEnabled}
              onChange={(value) => {
                updateSettings({ notificationsEnabled: value });
                if (value) void ensureNotificationPermission();
              }}
            />
            <Toggle
              label="Show message text in notifications"
              description="Turn off to keep message text out of notifications."
              checked={settings.notificationPreviews}
              onChange={(value) => updateSettings({ notificationPreviews: value })}
              disabled={!settings.notificationsEnabled}
            />
          </section>
        ) : null}

        {section === 'connection' ? (
          <section className="settings-section">
            <div className="connection-summary">
              <span className={`connection-dot ${state.signaling === 'online' ? 'on' : ''}`} />
              <div>
                <strong>{SIGNALING_TEXT[state.signaling] ?? state.signaling}</strong>
                <p className="muted small">
                  {connected} of {state.contacts.length} friends connected
                  {state.queued > 0 ? ` · ${state.queued} message${state.queued === 1 ? '' : 's'} waiting` : ''}
                </p>
              </div>
            </div>
            <p className="muted small">
              Messages go straight from device to device. A device keeps at most {30} live connections, which
              is plenty for groups of a few dozen.
            </p>
            <details className="advanced">
              <summary>Advanced</summary>
              <NetworkSettings engine={engine} state={state} />
            </details>
          </section>
        ) : null}

        {section === 'security' ? (
          <section className="settings-section">
            <AppLockControl />
            <BackupControl engine={engine} />
            <Toggle
              label="Stay group-only with people I meet in groups"
              description="You still read and reply in the groups you share, but nobody you only know through a group can message you directly, and you cannot message them, unless you swap invites yourselves. It applies to people you meet from now on and to the ones you already have."
              checked={settings.groupOnly}
              onChange={(value) => {
                updateSettings({ groupOnly: value });
                engine?.setGroupOnly(value);
              }}
            />
            <Toggle
              label="Panic wipe"
              description="Press Ctrl+Shift+Backspace three times within two seconds and everything on this device is erased immediately, with no confirmation. Your 12 recovery words are the only way back, so keep them somewhere safe first."
              checked={settings.panicWipe}
              onChange={(value) => updateSettings({ panicWipe: value })}
            />
            <div className="card-box">
              <div className="card-title">
                <KeyIcon size={18} />
                <strong>Recovery phrase</strong>
              </div>
              <p className="muted small">
                Your 12 words recreate this identity on a new device or after a wipe. PrivCord never stores
                them, so they cannot be shown again.
              </p>
              <button
                type="button"
                className="button secondary small"
                onClick={() => {
                  onClose();
                  onOpenRecovery();
                }}
              >
                Restore from phrase
              </button>
            </div>
            <div className="card-box">
              <div className="card-title">
                <TrashIcon size={18} />
                <strong>Clear all chats</strong>
              </div>
              <p className="muted small">Deletes every message on this device. Friends and groups stay.</p>
              <button
                type="button"
                className="button secondary small"
                onClick={() => {
                  onClose();
                  onOpenClearChats();
                }}
              >
                Clear chats…
              </button>
            </div>
            <div className="emergency-block">
              <div>
                <strong>Erase everything</strong>
                <p className="muted small">
                  Deletes chats, friends, groups, keys and settings from this device and starts over. Other
                  people keep what they already received.
                </p>
              </div>
              <button
                type="button"
                className="button danger"
                onClick={() => {
                  onClose();
                  onOpenNuke();
                }}
              >
                <AlertIcon size={15} />
                Erase everything…
              </button>
            </div>
          </section>
        ) : null}

        {section === 'about' ? (
          <section className="settings-section">
            <p>
              <strong>PrivCord</strong> · version {config.appVersion}
            </p>
            <p className="muted small">
              Private chats and groups with no accounts and no cloud. Messages are end-to-end encrypted and go
              straight between devices.
            </p>
            <p className="muted small">
              Made by anandkrishna1900 · PrivCord Community &amp; Non-Commercial License ·{' '}
              <a href="https://x.com/AnandKrishnaK1" target="_blank" rel="noreferrer">
                x.com/AnandKrishnaK1
              </a>
            </p>
            <dl className="detail-grid">
              <div>
                <dt>Your ID</dt>
                <dd className="mono selectable">{state.uid}</dd>
              </div>
              <div>
                <dt>Storage</dt>
                <dd>{state.storageBackend === 'sqlite' ? 'Encrypted on this device' : 'Browser (development, not encrypted)'}</dd>
              </div>
            </dl>
          </section>
        ) : null}
      </div>
    </Modal>
  );
}
