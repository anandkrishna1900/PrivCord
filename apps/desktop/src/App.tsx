import { useCallback, useEffect, useState } from 'react';
import { useChatEngine } from './hooks/useChatEngine';
import { LockScreen } from './components/LockScreen';
import { RELOCK_AFTER_MS, isLockEnabled } from './lib/appLock';
import { useSettings } from './hooks/useSettings';
import { ChatLayout } from './components/ChatLayout';
import { RecoveryDialog } from './components/RecoveryDialogs';
import { ShieldIcon } from './components/Icons';

export default function App() {
  const { settings, update } = useSettings();
  const { state, engine, fatal, needsIdentity, reload } = useChatEngine();
  const [locked, setLocked] = useState(() => isLockEnabled());
  const unlocked = useCallback(() => setLocked(false), []);

  // Lock again when the window has been out of sight for a while, and on request (Settings > Security).
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > RELOCK_AFTER_MS && isLockEnabled()) setLocked(true);
    };
    const onLockNow = () => {
      if (isLockEnabled()) setLocked(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('privcord:lock', onLockNow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('privcord:lock', onLockNow);
    };
  }, []);

  if (needsIdentity) {
    return (
      <main className="loading-page">
        <div className="splash">
          <div className="brand-lock large">
            <ShieldIcon size={26} />
          </div>
          <h1>PrivCord</h1>
          <p className="muted">Create your private identity to begin.</p>
        </div>
        <RecoveryDialog open required mode="backup" onClose={() => undefined} onIdentityReady={reload} />
      </main>
    );
  }

  return (
    <>
      <ChatLayout
        state={state}
        engine={engine}
        settings={settings}
        updateSettings={update}
        fatal={fatal}
      />
      {locked ? <LockScreen onUnlocked={unlocked} /> : null}
    </>
  );
}
