import { useEffect, useState } from 'react';
import type { ChatEngine, ChatState } from '../lib/engine';
import type { AppSettings, ThemeMode } from '../lib/settings';
import { ACCENTS } from '../lib/settings';
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
