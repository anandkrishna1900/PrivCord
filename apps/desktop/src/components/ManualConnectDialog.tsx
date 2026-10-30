import { useEffect, useState } from 'react';
import type { ChatState } from '../lib/engine';
import type { ChatEngine } from '../lib/engine';
import { copyText } from '../lib/clipboard';
import { Modal } from './Modal';
import {
  AlertIcon,
  CheckIcon,
  CopyIcon,
  KeyIcon,
  LinkIcon,
  LoaderIcon,
  ShieldIcon,
} from './Icons';

type Mode = 'offer' | 'join' | null;

export function ManualConnectDialog({
  open,
  onClose,
  engine,
  state,
  uid,
}: {
  open: boolean;
  onClose: () => void;
  engine: ChatEngine | null;
  state: ChatState | null;
  /** The friend to connect to. */
  uid: string;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [offerCode, setOfferCode] = useState('');
  const [answerInput, setAnswerInput] = useState('');
  const [answerApplied, setAnswerApplied] = useState(false);
  const [joinInput, setJoinInput] = useState('');
  const [answerCode, setAnswerCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode(null);
    setOfferCode('');
    setAnswerInput('');
    setAnswerApplied(false);
    setJoinInput('');
    setAnswerCode('');
    setBusy(false);
    setError(null);
    setCopied(null);
  }, [open]);

  const connected = state?.contacts.find((c) => c.uid === uid)?.conn === 'connected';

  function close() {
    if (!connected && engine) engine.cancelManual();
    onClose();
  }

  function switchMode(next: Mode) {
    if (!engine) return;
    engine.cancelManual();
    setMode(next);
    setOfferCode('');
    setAnswerInput('');
    setAnswerApplied(false);
    setJoinInput('');
    setAnswerCode('');
    setError(null);
  }

  async function copy(value: string, label: string) {
    const ok = await copyText(value);
    setCopied(ok ? label : null);
    if (ok) window.setTimeout(() => setCopied(null), 1800);
  }

  async function generateOffer() {
    if (!engine) return;
    setBusy(true);
    setError(null);
    try {
      setOfferCode(await engine.createManualOffer(uid));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create a code.');
    } finally {
      setBusy(false);
    }
  }

  async function applyAnswer() {
    if (!engine) return;
    setBusy(true);
    setError(null);
    try {
      await engine.applyManualAnswer(answerInput.trim());
      setAnswerApplied(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not apply the answer.');
    } finally {
      setBusy(false);
    }
  }

  async function createAnswer() {
    if (!engine) return;
    setBusy(true);
    setError(null);
    try {
      setAnswerCode(await engine.acceptManualOffer(joinInput.trim()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create an answer.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      eyebrow="Direct connection"
      title="Connect without internet"
      wide
    >
      <div className="manual-intro">
        <KeyIcon size={20} />
        <p>
          There is no server, so you introduce your devices with codes: one of you
          creates a code, the other pastes it and sends back a reply. Codes only
          carry connection data. The first time, compare the safety number to be
          sure you are talking to the right device.
        </p>
      </div>

      {connected ? (
        <div className="success-panel">
          <div className="success-icon">
            <CheckIcon size={22} />
          </div>
          <div>
            <h3>Direct channel established</h3>
            <p className="muted">
              Messages now travel straight between your devices. If the
              connection drops, exchange a new code to reconnect.
            </p>
          </div>
        </div>
      ) : mode === null ? (
        <div className="manual-modes">
          <button type="button" className="choice-card" onClick={() => switchMode('offer')}>
            <LinkIcon size={22} />
            <strong>Create a connection code</strong>
            <span>
              You start the connection, send an offer, then paste the answer you
              receive.
            </span>
          </button>
          <button type="button" className="choice-card" onClick={() => switchMode('join')}>
            <KeyIcon size={22} />
            <strong>I received a code</strong>
            <span>
              Paste your friend's offer, then send them back the generated answer.
            </span>
          </button>
        </div>
      ) : mode === 'offer' ? (
        <div className="manual-steps">
          <div className="manual-heading">
            <h3>You start the connection</h3>
            <button type="button" className="button ghost small" onClick={() => switchMode(null)}>
              Change method
            </button>
          </div>
          <ol className="step-list">
            <li>
              <div className="step-label">
                <span>1</span>
                <div>
                  <strong>Create an offer</strong>
                  <p>Send this code to your friend using any separate channel.</p>
                </div>
              </div>
              {offerCode ? (
                <>
                  <textarea
                    className="code-area"
                    readOnly
                    value={offerCode}
                    onFocus={(event) => event.currentTarget.select()}
                    aria-label="Offer code"
                  />
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => void copy(offerCode, 'offer')}
                  >
                    {copied === 'offer' ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
                    {copied === 'offer' ? 'Copied' : 'Copy offer code'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button primary small"
                  onClick={() => void generateOffer()}
                  disabled={busy}
                >
                  {busy ? <LoaderIcon size={15} className="spin" /> : <LinkIcon size={15} />}
                  {busy ? 'Gathering connection data…' : 'Generate offer code'}
                </button>
              )}
            </li>
            <li>
              <div className="step-label">
                <span>2</span>
                <div>
                  <strong>Paste the answer</strong>
                  <p>Your friend generates a reply code from your offer.</p>
                </div>
              </div>
              <textarea
                className="code-area input"
                value={answerInput}
                onChange={(event) => setAnswerInput(event.target.value)}
                placeholder="DUO1:…"
                aria-label="Answer code"
                disabled={answerApplied}
              />
              <button
                type="button"
                className="button primary small"
                onClick={() => void applyAnswer()}
                disabled={busy || answerApplied || !answerInput.trim()}
              >
                {busy ? <LoaderIcon size={15} className="spin" /> : <CheckIcon size={15} />}
                {answerApplied ? 'Waiting for peer…' : 'Apply answer'}
              </button>
            </li>
          </ol>
        </div>
      ) : (
        <div className="manual-steps">
          <div className="manual-heading">
            <h3>Answer a connection code</h3>
            <button type="button" className="button ghost small" onClick={() => switchMode(null)}>
              Change method
            </button>
          </div>
          <ol className="step-list">
            <li>
              <div className="step-label">
                <span>1</span>
                <div>
                  <strong>Paste the offer</strong>
                  <p>Enter the code your friend sent you.</p>
                </div>
              </div>
              <textarea
                className="code-area input"
                value={joinInput}
                onChange={(event) => setJoinInput(event.target.value)}
                placeholder="DUO1:…"
                aria-label="Offer code to answer"
                disabled={Boolean(answerCode)}
              />
              <button
                type="button"
                className="button primary small"
                onClick={() => void createAnswer()}
                disabled={busy || Boolean(answerCode) || !joinInput.trim()}
              >
                {busy ? <LoaderIcon size={15} className="spin" /> : <KeyIcon size={15} />}
                {answerCode ? 'Answer generated' : 'Generate answer'}
              </button>
            </li>
            {answerCode ? (
              <li>
                <div className="step-label">
                  <span>2</span>
                  <div>
                    <strong>Send the answer back</strong>
                    <p>Your friend pastes this to complete the connection.</p>
                  </div>
                </div>
                <textarea
                  className="code-area"
                  readOnly
                  value={answerCode}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label="Answer code to send"
                />
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => void copy(answerCode, 'answer')}
                >
                  {copied === 'answer' ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
                  {copied === 'answer' ? 'Copied' : 'Copy answer code'}
                </button>
                <p className="waiting-note">
                  <LoaderIcon size={14} className="spin" />
                  Waiting for your friend to apply the answer…
                </p>
              </li>
            ) : null}
          </ol>
        </div>
      )}

      {error ? (
        <div className="inline-error" role="alert">
          <AlertIcon size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      <p className="manual-warning">
        Manual codes are temporary and are not proof of identity on their own.
        Never accept a code from someone who has not verified the safety number
        with you.
      </p>
    </Modal>
  );
}
