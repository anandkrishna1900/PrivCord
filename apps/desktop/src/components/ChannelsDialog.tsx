import { useEffect, useState } from 'react';
import type { ChannelView, ChatEngine } from '../lib/engine';
import { Modal } from './Modal';

const SUGGESTIONS = ['general', 'random', 'help', 'news', 'music', 'tech'];

/** Join a public channel by name, or leave one. Typing a name nobody used before creates it. */
export function ChannelsDialog({
  open,
  onClose,
  engine,
  channels,
  onJoined,
}: {
  open: boolean;
  onClose: () => void;
  engine: ChatEngine | null;
  channels: ChannelView[];
  onJoined: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setError(null);
  }, [open]);

  async function join(raw: string) {
    if (!engine) return;
    setBusy(true);
    setError(null);
    try {
      const id = await engine.joinChannel(raw);
      onClose();
      onJoined(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not join this channel.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Public channels">
      <p className="muted small">
        A channel is an open room. Anyone who types the same name joins the same room, and anyone who knows the name
        can read it. Messages show your name and a short ID. For a private room use a private chat or a group.
      </p>
      <label className="field">
        <span>Channel name</span>
        <input
          value={name}
          maxLength={40}
          placeholder="general"
          aria-label="Channel name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && name.trim() && !busy) void join(name);
          }}
        />
      </label>
      <div className="chip-row">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="chip chip-button" disabled={busy} onClick={() => void join(s)}>
            #{s}
          </button>
        ))}
      </div>
      {error ? (
        <p className="status-text error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row">
        <button type="button" className="button primary" disabled={busy || !name.trim()} onClick={() => void join(name)}>
          Join channel
        </button>
      </div>
      {channels.length > 0 ? (
        <>
          <h3 className="section-title">Your channels</h3>
          <ul className="member-list">
            {channels.map((c) => (
              <li key={c.id} className="member-row">
                <div className="member-main">
                  <strong>#{c.name}</strong>
                </div>
                <button
                  type="button"
                  className="button ghost small"
                  onClick={() => {
                    onClose();
                    onJoined(c.id);
                  }}
                >
                  Open
                </button>
                <button type="button" className="button ghost small danger" onClick={() => engine?.leaveChannel(c.id)}>
                  Leave
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Modal>
  );
}
