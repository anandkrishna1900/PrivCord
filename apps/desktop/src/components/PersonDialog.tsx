import { useEffect, useState } from 'react';
import type { ChatEngine, ContactView } from '../lib/engine';
import { Modal } from './Modal';
import { Avatar } from './Avatar';
import { CheckIcon, ShieldIcon } from './Icons';

/** One friend: name, "check it's really them", and the rarely used extras. */
export function PersonDialog({
  open,
  onClose,
  engine,
  person,
  onManual,
  onRemoved,
}: {
  open: boolean;
  onClose: () => void;
  engine: ChatEngine | null;
  person: ContactView | null;
  onManual: (uid: string) => void;
  onRemoved: () => void;
}) {
  const [safety, setSafety] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [ble, setBle] = useState(false);
  const uid = person?.uid;

  useEffect(() => {
    if (!open || !engine || !uid) return;
    setError(null);
    setConfirmRemove(false);
    setSafety('');
    let live = true;
    void engine.safetyNumberFor(uid).then((n) => live && setSafety(n));
    void engine.bluetoothAvailable().then((ok) => live && setBle(ok));
    return () => {
      live = false;
    };
  }, [open, engine, uid]);

  useEffect(() => setName(person?.name ?? ''), [person?.name, open]);

  if (!person || !engine) return null;

  return (
    <Modal open={open} onClose={onClose} title={person.name}>
      <div className="profile-row">
        <Avatar name={person.name} size={52} online={person.conn === 'connected'} />
        <div>
          <strong>{person.name}</strong>
          <p className="muted small">{person.status}</p>
          {person.trust === 'introduced' ? (
            <p className="muted small">
              Introduced by {person.introducedByName ?? 'a friend'}
              {person.direct ? '' : ' · group only'}
            </p>
          ) : null}
          {!person.direct ? (
            <p className="muted small">
              You can talk in your shared groups, but not directly: one of you stays group-only. To message each
              other directly, both add each other with an invite (Add friend).
            </p>
          ) : null}
        </div>
      </div>
      <div className="field-row">
        <input value={name} maxLength={40} aria-label="Name" onChange={(event) => setName(event.target.value)} />
        <button
          type="button"
          className="button secondary small"
          disabled={!name.trim() || name.trim() === person.name}
          onClick={() => engine.setNickname(person.uid, name)}
        >
          Rename
        </button>
      </div>

      <section className="verify-panel">
        <ShieldIcon size={20} />
        <h3>{person.checked ? 'You checked these numbers' : "Check it's really them"}</h3>
        <p className="muted small">
          {person.trust === 'introduced'
            ? `${person.introducedByName ?? 'A friend'} introduced you, so this is only as safe as they are. `
            : ''}
          Read these numbers to {person.name} on a call or in person. If they match theirs, nobody is in the middle.
        </p>
        <code className="safety-number selectable">{safety}</code>
        {person.checked ? (
          <span className="muted small">
            <CheckIcon size={14} /> Verified
          </span>
        ) : (
          <button type="button" className="button primary small" onClick={() => engine.setChecked(person.uid)}>
            <CheckIcon size={15} />
            Numbers match
          </button>
        )}
      </section>

      <div className="button-row">
        <button
          type="button"
          className="button secondary small"
          onClick={() => {
            onClose();
            onManual(person.uid);
          }}
        >
          Connect without internet
        </button>
        {ble ? (
          <button
            type="button"
            className="button secondary small"
            onClick={() => engine.connectBluetooth(person.uid).catch((caught) => setError(String(caught?.message ?? caught)))}
          >
            Connect by Bluetooth
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="status-text error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="danger-zone">
        {confirmRemove ? (
          <div className="button-row">
            <button
              type="button"
              className="button danger"
              onClick={() => {
                try {
                  engine.removeContact(person.uid);
                  onClose();
                  onRemoved();
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : String(caught));
                  setConfirmRemove(false);
                }
              }}
            >
              Yes, remove friend
            </button>
            <button type="button" className="button ghost" onClick={() => setConfirmRemove(false)}>
              Keep
            </button>
          </div>
        ) : (
          <button type="button" className="button danger ghost" onClick={() => setConfirmRemove(true)}>
            Remove friend
          </button>
        )}
      </div>
    </Modal>
  );
}
