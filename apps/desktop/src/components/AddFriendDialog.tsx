import { useEffect, useState } from 'react';
import type { ChatEngine, InviteAnswer } from '../lib/engine';
import { parseInviteWords } from '@duochat/protocol';
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
  answer,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  engine: ChatEngine | null;
  /** Whether our own invite reached the friend whose words we typed. */
  answer: InviteAnswer | null;
  onAdded: (uid: string) => void;
}) {
  const [done, setDone] = useState<{ uid: string; name: string } | null>(null);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ name: string; safetyNumber: string; already: boolean } | null>(null);
  const [words, setWords] = useState<string | null>(null);
  const [wordsError, setWordsError] = useState<string | null>(null);
  const [wordsCopied, setWordsCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPasted('');
    setError(null);
    setCopied(false);
    setFound(null);
    setDone(null);
    engine?.clearAnswer();
    setWords(null);
    setWordsError(null);
    if (!engine) return;
    let cancelled = false;
    engine
      .createInvite()
      .then((invite) => {
        if (!cancelled) setWords(invite.words);
      })
      .catch((caught) => {
        if (!cancelled) setWordsError(caught instanceof Error ? caught.message : 'Could not make a six-word invite.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, engine]);

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
      const typedWords = parseInviteWords(pasted) !== null;
      const uid = await engine.addContact(pasted);
      if (checked) engine.setChecked(uid);
      if (typedWords && found) {
        // Say plainly whether our own invite reached them; they confirm us on their side.
        setDone({ uid, name: found.name });
      } else {
        onClose();
        onAdded(uid);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add this friend.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a friend" wide>
      {done ? (
        <div className="verify-panel">
          <CheckIcon size={22} />
          <h3>{done.name} was added</h3>
          {!answer || answer.status === 'sending' ? (
            <p className="muted" role="status">
              Sending your invite to {done.name}…
            </p>
          ) : answer.status === 'sent' ? (
            <p className="muted" role="status">
              Your invite was sent to {done.name}. They will see a request to add you. As soon as they accept, you are
              connected.
            </p>
          ) : (
            <>
              <p className="status-text error" role="alert">
                Your invite did not reach {done.name}: {answer.error}
              </p>
              <p className="muted small">
                Try again, or show {done.name} your own six words{words ? `: ${words}` : ''} so they can add you.
              </p>
              <button type="button" className="button secondary" onClick={() => engine?.retryAnswer()}>
                Send it again
              </button>
            </>
          )}
          <div className="button-row">
            <button
              type="button"
              className="button primary"
              onClick={() => {
                onClose();
                onAdded(done.uid);
              }}
            >
              Open chat
            </button>
            <button type="button" className="button ghost" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : found ? (
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
            <p className="muted small">Your friend scans the QR code or types the six words. Safe to share.</p>
            <QrCode value={invite} label="Your invite as a QR code" />
            {words ? (
              <>
                <p className="invite-words selectable" aria-label="Your six invite words">
                  {words.split(' ').map((w, i) => (
                    <span key={i} className="invite-word">
                      {w}
                    </span>
                  ))}
                </p>
                <p className="muted small">The words work for 15 minutes while this app is open.</p>
                <button
                  type="button"
                  className="button secondary small"
                  onClick={async () => {
                    setWordsCopied(await copyText(words));
                    window.setTimeout(() => setWordsCopied(false), 1800);
                  }}
                >
                  {wordsCopied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
                  {wordsCopied ? 'Copied' : 'Copy the words'}
                </button>
              </>
            ) : wordsError ? (
              <p className="muted small" role="status">
                {wordsError}
              </p>
            ) : (
              <p className="muted small" role="status">
                Making your six words…
              </p>
            )}
            <details className="advanced">
              <summary>Full invite text (for pasting without the words)</summary>
              <textarea className="code-area selectable" readOnly rows={2} value={invite} aria-label="Your invite" />
              <button
                type="button"
                className="button ghost small"
                onClick={async () => {
                  setCopied(await copyText(invite));
                  window.setTimeout(() => setCopied(false), 1800);
                }}
              >
                {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
                {copied ? 'Copied' : 'Copy full text'}
              </button>
            </details>
          </section>
          <section className="add-card">
            <h3>2. Enter your friend&apos;s invite</h3>
            <p className="muted small">Type the six words they see in Add a friend (or paste their full invite text).</p>
            <textarea
              className="code-area"
              rows={3}
              placeholder="six words, like: apple river tiger moon cloud seven"
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
              {busy ? 'Looking…' : 'Continue'}
            </button>
          </section>
        </div>
      )}
    </Modal>
  );
}
