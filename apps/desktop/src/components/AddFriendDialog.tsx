import { useEffect, useState } from 'react';
import type { ChatEngine } from '../lib/engine';
import { copyText } from '../lib/clipboard';
import { Modal } from './Modal';
import { QrCode } from './QrCode';
import { CheckIcon, CopyIcon, ShieldIcon } from './Icons';

/**
 * Add a friend: show my invite, paste theirs. Checking the numbers is optional and can be done later.
 */
export function AddFriendDialog({
  open,
  onClose,
  engine,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  engine: ChatEngine | null;
  onAdded: (uid: string) => void;
}) {
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ name: string; safetyNumber: string; already: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    setPasted('');
    setError(null);
    setCopied(false);
    setFound(null);
  }, [open]);

  const invite = open && engine ? engine.myInvite() : '';

  async function next() {
    if (!engine) return;
    setBusy(true);
    setError(null);
    try {
      setFound(await engine.previewInvite(pasted));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read this invite.');
    } finally {
      setBusy(false);
    }
  }

  async function save(checked: boolean) {
    if (!engine) return;
    setBusy(true);
    try {
      const uid = await engine.addContact(pasted);
      if (checked) engine.setChecked(uid);
      onClose();
      onAdded(uid);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add this friend.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a friend" wide>
      {found ? (
        <div className="verify-panel">
          <ShieldIcon size={22} />
          <h3>Add {found.name}?</h3>
          <p className="muted">
            Optional: read these numbers to {found.name} on a call or in person. If they match what
            they see, nobody is in the middle.
          </p>
          <code className="safety-number selectable">{found.safetyNumber}</code>
          {error ? (
            <p className="status-text error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="button-row">
            <button type="button" className="button primary" disabled={busy} onClick={() => void save(true)}>
              <CheckIcon size={16} />
              Numbers match
            </button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => void save(false)}>
              Skip for now
            </button>
            <button type="button" className="button ghost" disabled={busy} onClick={() => setFound(null)}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="add-friend">
          <section className="add-card">
            <h3>1. Show your invite</h3>
            <p className="muted small">Your friend scans this or pastes the text. It is safe to share.</p>
            <QrCode value={invite} label="Your invite as a QR code" />
            <textarea className="code-area selectable" readOnly rows={2} value={invite} aria-label="Your invite" />
            <button
              type="button"
              className="button secondary small"
              onClick={async () => {
                setCopied(await copyText(invite));
                window.setTimeout(() => setCopied(false), 1800);
              }}
            >
              {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
              {copied ? 'Copied' : 'Copy invite'}
            </button>
          </section>
          <section className="add-card">
            <h3>2. Paste your friend&apos;s invite</h3>
            <p className="muted small">Ask them to open Add a friend and send you their invite.</p>
            <textarea
              className="code-area"
              rows={4}
              placeholder="Paste invite here"
              aria-label="Friend's invite"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
            />
            {error ? (
              <p className="status-text error" role="alert">
                {error}
              </p>
            ) : null}
            <button
              type="button"
              className="button primary"
              disabled={busy || !pasted.trim()}
              onClick={() => void next()}
            >
              Continue
            </button>
          </section>
        </div>
      )}
    </Modal>
  );
}
