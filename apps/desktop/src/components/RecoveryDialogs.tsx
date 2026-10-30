import { useEffect, useState } from 'react';
import {
  generateRecoveryPhrase,
  validateRecoveryPhrase,
  deriveIdentityFromPhrase,
  REQUIRED_WORDS,
} from '@duochat/protocol';
import { secretSet, secretGet } from '../lib/secureStore';
import { Modal } from './Modal';
import {
  AlertIcon,
  CheckIcon,
  CopyIcon,
  KeyIcon,
  LoaderIcon,
  ShieldIcon,
  XIcon,
} from './Icons';
import { copyText } from '../lib/clipboard';

export interface RecoveryDialogProps {
  open: boolean;
  onClose: () => void;
  uid: string;
  mode?: 'backup' | 'restore';
  onRestored?: (fingerprint: string) => void;
}

export function RecoveryDialog({
  open,
  onClose,
  uid,
  mode = 'backup',
  onRestored,
}: RecoveryDialogProps) {
  const [currentMode, setCurrentMode] = useState<'backup' | 'restore'>(mode);
  
  // Backup state
  const [phrase, setPhrase] = useState('');
  const [words, setWords] = useState<string[]>([]);
  const [step, setStep] = useState<'generate' | 'verify' | 'confirmed'>('generate');
  const [testIndices, setTestIndices] = useState<[number, number]>([2, 8]);
  const [testInput1, setTestInput1] = useState('');
  const [testInput2, setTestInput2] = useState('');
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [showPassphraseInput, setShowPassphraseInput] = useState(false);

  // Restore state
  const [restorePhrase, setRestorePhrase] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreSuccess, setRestoreSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCurrentMode(mode);
    setRestorePhrase('');
    setRestorePassphrase('');
    setRestoreError(null);
    setRestoreSuccess(null);
    setRestoring(false);
    setStep('generate');
    setVerifyError(null);
    setCopied(false);
    setShowPassphraseInput(false);
    setPassphrase('');

    if (mode === 'backup') {
      const p = generateRecoveryPhrase();
      setPhrase(p);
      const w = p.split(' ');
      setWords(w);
      // Pick two random distinct indices between 0 and 11
      const idx1 = Math.floor(Math.random() * 6);
      const idx2 = 6 + Math.floor(Math.random() * 6);
      setTestIndices([idx1, idx2]);
      setTestInput1('');
      setTestInput2('');
    }
  }, [open, mode]);

  const handleVerify = async () => {
    setVerifyError(null);
    const expected1 = words[testIndices[0]]?.toLowerCase().trim();
    const expected2 = words[testIndices[1]]?.toLowerCase().trim();
    if (testInput1.toLowerCase().trim() !== expected1 || testInput2.toLowerCase().trim() !== expected2) {
      setVerifyError('One or both words do not match your phrase. Please check and try again.');
      return;
    }

    try {
      // Derive and save identity securely
      const derived = await deriveIdentityFromPhrase(phrase, passphrase);
      const secretKey = `ec-private-${uid}`;
      await secretSet(secretKey, JSON.stringify(derived.identity.signKey.privJwk));
      localStorage.setItem(`duochat.identity.fingerprint.${uid}`, derived.identityFingerprint);
      setStep('confirmed');
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Failed to derive identity from phrase.');
    }
  };

  const handleRestore = async () => {
    setRestoreError(null);
    const validation = validateRecoveryPhrase(restorePhrase);
    if (!validation.ok) {
      setRestoreError(validation.error || 'Invalid 12-word recovery phrase.');
      return;
    }

    setRestoring(true);
    try {
      const derived = await deriveIdentityFromPhrase(restorePhrase.trim().toLowerCase(), restorePassphrase);
      const secretKey = `ec-private-${uid}`;
      await secretSet(secretKey, JSON.stringify(derived.identity.signKey.privJwk));
      localStorage.setItem(`duochat.identity.fingerprint.${uid}`, derived.identityFingerprint);
      setRestoreSuccess(`Identity restored successfully! Fingerprint: ${derived.identityFingerprint.slice(0, 16)}…`);
      onRestored?.(derived.identityFingerprint);
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'Identity derivation failed. Verify your recovery words.');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={currentMode === 'backup' ? '12-Word Recovery Phrase' : 'Restore Identity'}
      eyebrow="Cryptographic Identity"
      wide
    >
      <div className="recovery-flow">
        {currentMode === 'backup' && (
          <>
            {step === 'generate' && (
              <div className="recovery-step">
                <div className="callout warning">
                  <AlertIcon size={18} />
                  <div>
                    <strong>Mandatory Identity Backup</strong>
                    <p>
                      DuoChat uses a 12-word cryptographic recovery phrase. If you lose access to this device or use the Emergency Kill Switch, this phrase is the <strong>only way</strong> to restore your cryptographic identity and paired contacts.
                    </p>
                  </div>
                </div>

                <p className="recovery-instructions">
                  Write down these 12 words in order and store them in a secure, offline location. Never share them with anyone.
                </p>

                <div className="phrase-grid">
                  {words.map((word, index) => (
                    <div key={index} className="phrase-word-box">
                      <span className="word-index">{index + 1}.</span>
                      <span className="word-text">{word}</span>
                    </div>
                  ))}
                </div>

                <div className="button-row" style={{ marginTop: '16px' }}>
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => {
                      copyText(phrase);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    <CopyIcon size={15} />
                    {copied ? 'Copied to clipboard' : 'Copy phrase'}
                  </button>
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => setShowPassphraseInput((v) => !v)}
                  >
                    <KeyIcon size={15} />
                    {showPassphraseInput ? 'Hide optional passphrase' : 'Add optional BIP-39 passphrase'}
                  </button>
                </div>

                {showPassphraseInput && (
                  <div className="passphrase-section" style={{ marginTop: '12px' }}>
                    <label className="input-label" htmlFor="bip39-passphrase">
                      Optional BIP-39 Passphrase (Advanced)
                    </label>
                    <input
                      id="bip39-passphrase"
                      type="password"
                      className="text-input"
                      value={passphrase}
                      placeholder="Enter optional passphrase"
                      onChange={(e) => setPassphrase(e.target.value)}
                    />
                    <p className="muted small" style={{ marginTop: '4px' }}>
                      Warning: If you set an optional passphrase, you will need both the 12 words AND this exact passphrase to restore your identity.
                    </p>
                  </div>
                )}

                <div className="modal-actions" style={{ marginTop: '24px', display: 'flex', justifyContent: 'space-between' }}>
                  <button
                    type="button"
                    className="button ghost"
                    onClick={() => setCurrentMode('restore')}
                  >
                    Already have a phrase? Restore
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => setStep('verify')}
                  >
                    I have saved my phrase →
                  </button>
                </div>
              </div>
            )}

            {step === 'verify' && (
              <div className="recovery-step">
                <h3>Verify your backup</h3>
                <p className="muted">
                  To ensure you saved your 12-word recovery phrase correctly, please enter the requested words:
                </p>

                <div className="verify-inputs" style={{ margin: '20px 0', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div>
                    <label className="input-label" htmlFor="verify-word-1">
                      Word #{testIndices[0] + 1}:
                    </label>
                    <input
                      id="verify-word-1"
                      type="text"
                      className="text-input"
                      placeholder={`Enter word #${testIndices[0] + 1}`}
                      value={testInput1}
                      onChange={(e) => setTestInput1(e.target.value)}
                      autoComplete="off"
                      autoCapitalize="none"
                    />
                  </div>
                  <div>
                    <label className="input-label" htmlFor="verify-word-2">
                      Word #{testIndices[1] + 1}:
                    </label>
                    <input
                      id="verify-word-2"
                      type="text"
                      className="text-input"
                      placeholder={`Enter word #${testIndices[1] + 1}`}
                      value={testInput2}
                      onChange={(e) => setTestInput2(e.target.value)}
                      autoComplete="off"
                      autoCapitalize="none"
                    />
                  </div>
                </div>

                {verifyError && (
                  <div className="banner error" style={{ marginBottom: '16px' }}>
                    <XIcon size={16} />
                    <span>{verifyError}</span>
                  </div>
                )}

                <div className="modal-actions" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <button
                    type="button"
                    className="button ghost"
                    onClick={() => setStep('generate')}
                  >
                    ← Back to phrase
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    onClick={handleVerify}
                    disabled={!testInput1.trim() || !testInput2.trim()}
                  >
                    Verify &amp; Confirm
                  </button>
                </div>
              </div>
            )}

            {step === 'confirmed' && (
              <div className="recovery-step" style={{ textAlign: 'center', padding: '20px 0' }}>
                <div style={{ display: 'inline-flex', padding: '16px', borderRadius: '50%', background: 'var(--color-success-bg, #059669)', color: '#fff', marginBottom: '16px' }}>
                  <CheckIcon size={36} />
                </div>
                <h3>Identity Backup Complete</h3>
                <p className="muted" style={{ maxWidth: '420px', margin: '0 auto 20px auto' }}>
                  Your cryptographic identity has been securely created and backed up. Remember: DuoChat never stores your recovery phrase in plaintext or on any server.
                </p>
                <button
                  type="button"
                  className="button primary"
                  onClick={onClose}
                >
                  Done
                </button>
              </div>
            )}
          </>
        )}

        {currentMode === 'restore' && (
          <div className="recovery-step">
            <p className="muted">
              Enter your 12-word recovery phrase to restore your identity keys and cryptographic trust records.
            </p>

            <div style={{ margin: '16px 0' }}>
              <label className="input-label" htmlFor="restore-phrase-input">
                12-word Recovery Phrase
              </label>
              <textarea
                id="restore-phrase-input"
                className="text-input"
                rows={3}
                placeholder="abandon ability able about above absent absorb abstract absurd abuse access accident"
                value={restorePhrase}
                onChange={(e) => setRestorePhrase(e.target.value)}
                style={{ fontFamily: 'var(--font-mono)', fontSize: '0.95rem' }}
              />
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label className="input-label" htmlFor="restore-passphrase-input">
                BIP-39 Passphrase (only if you set one during creation)
              </label>
              <input
                id="restore-passphrase-input"
                type="password"
                className="text-input"
                placeholder="Leave blank if none was used"
                value={restorePassphrase}
                onChange={(e) => setRestorePassphrase(e.target.value)}
              />
            </div>

            <div className="callout subtle" style={{ marginBottom: '16px' }}>
              <ShieldIcon size={16} />
              <p>
                Local conversation history permanently deleted with the Emergency Kill Switch cannot be restored by your phrase, as it was cryptographically erased on this device.
              </p>
            </div>

            {restoreError && (
              <div className="banner error" style={{ marginBottom: '16px' }}>
                <XIcon size={16} />
                <span>{restoreError}</span>
              </div>
            )}

            {restoreSuccess && (
              <div className="banner success" style={{ marginBottom: '16px' }}>
                <CheckIcon size={16} />
                <span>{restoreSuccess}</span>
              </div>
            )}

            <div className="modal-actions" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <button
                type="button"
                className="button ghost"
                onClick={() => setCurrentMode('backup')}
              >
                Back to Backup
              </button>
              <button
                type="button"
                className="button primary"
                onClick={handleRestore}
                disabled={restoring || !restorePhrase.trim()}
              >
                {restoring ? <LoaderIcon size={16} className="spin" /> : 'Restore Identity'}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

