import { useEffect, useState } from 'react';
import type { ChatEngine, ChatState } from '../lib/engine';
import { contactCardOf } from '../lib/identity';
import { copyText } from '../lib/clipboard';
import { Modal } from './Modal';
import { CheckIcon, CopyIcon, ShieldIcon } from './Icons';

/**
 * Meet a friend: swap public contact cards (over any channel), compare the safety
 * number once, and the app reconnects to them automatically from then on.
 */
export function ContactDialog({
  open,
  onClose,
  engine,
  state,
}: {
  open: boolean;
  onClose: () => void;
  engine: ChatEngine | null;
  state: ChatState | null;
}) {
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPasted('');
    setError(null);
    setCopied(false);
  }, [open]);

  const card = engine ? contactCardOf(engine.identityDetails) : '';
  const pending = state?.pendingContact ?? null;

  function close() {
    engine?.cancelContact();
    onClose();
  }

  async function preview() {
    if (!engine) return;
    setBusy(true);
    setError(null);
    try {
      await engine.previewContact(pasted);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read this card.');
    } finally {
      setBusy(false);
    }
  }

  if (state?.paired && !pending) {
    return (
      <Modal open={open} onClose={close} eyebrow="Friend" title="You are paired">
        <div className="success-panel">
          <div className="success-icon">
            <CheckIcon size={22} />
          </div>
          <div>
            <h3>Friend saved</h3>
            <p className="muted">
              DuoChat reconnects to them automatically whenever you are both online. To pair with
              someone else, use Reset pairing in Settings.
            </p>
          </div>
        </div>
        <div className="button-row">
          <button type="button" className="button primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={close} eyebrow="Friend" title="Add your friend" wide>
      {pending ? (
        <div className="verify-panel">
          <ShieldIcon size={22} />
          <h3>Compare the safety number</h3>
          <p className="muted">
            Read these numbers to your friend over a separate channel (a call, in person). Confirm
            only if they match exactly on both devices.
          </p>
          <code className="safety-number selectable">{pending.safetyNumber}</code>
          <div className="button-row">
            <button
              type="button"
              className="button primary"
              onClick={() => {
                engine?.confirmContact();
                onClose();
              }}
            >
              <ShieldIcon size={16} />
              Numbers match, save friend
            </button>
            <button type="button" className="button ghost" onClick={() => engine?.cancelContact()}>
              They don&apos;t match
            </button>
          </div>
        </div>
      ) : (
        <ol className="manual-steps">
          <li>
            <div className="step-label">
              <span>1</span>
              <div>
                <strong>Send your contact card</strong>
                <p>It is public: it only lets your friend verify and message you. Share it any way you like.</p>
              </div>
            </div>
            <textarea className="code-area selectable" readOnly rows={3} value={card} aria-label="Your contact card" />
            <button
              type="button"
              className="button secondary small"
              onClick={async () => {
                setCopied(await copyText(card));
                window.setTimeout(() => setCopied(false), 1800);
              }}
            >
              {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
              {copied ? 'Copied' : 'Copy my card'}
            </button>
          </li>
          <li>
            <div className="step-label">
              <span>2</span>
              <div>
                <strong>Paste your friend&apos;s card</strong>
                <p>Then you will compare a safety number once.</p>
              </div>
            </div>
            <textarea
              className="code-area"
              rows={3}
              placeholder="DUOID1:…"
              aria-label="Friend's contact card"
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
              className="button primary small"
              disabled={busy || !pasted.trim()}
              onClick={() => void preview()}
            >
              Continue
            </button>
          </li>
        </ol>
      )}
    </Modal>
  );
}
