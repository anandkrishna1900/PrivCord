import { useCallback, useEffect, useRef, useState } from 'react';
import { unlock } from '../lib/appLock';
import { LockIcon } from './Icons';

/** Covers the whole app until the user passes Windows Hello (or the device passkey prompt). */
export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);

  const ask = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (await unlock()) onUnlocked();
      else setError('That did not work. Try again.');
    } catch {
      setError('Unlocking was cancelled. Try again.');
    } finally {
      setBusy(false);
    }
  }, [onUnlocked]);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void ask();
  }, [ask]);

  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-label="PrivCord is locked">
      <div className="splash">
        <div className="brand-lock large">
          <LockIcon size={26} />
        </div>
        <h1>PrivCord is locked</h1>
        <p className="muted">Use Windows Hello (face, fingerprint or PIN) to open your chats.</p>
        <button type="button" className="button primary" onClick={() => void ask()} disabled={busy}>
          Unlock
        </button>
        {error ? (
          <p className="status-text error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
