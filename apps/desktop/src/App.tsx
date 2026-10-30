import { useChatEngine } from './hooks/useChatEngine';
import { useSettings } from './hooks/useSettings';
import { ChatLayout } from './components/ChatLayout';
import { RecoveryDialog } from './components/RecoveryDialogs';
import { ShieldIcon } from './components/Icons';

export default function App() {
  const { settings, update } = useSettings();
  const { state, engine, fatal, needsIdentity, reload } = useChatEngine();

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
    <ChatLayout
      state={state}
      engine={engine}
      settings={settings}
      updateSettings={update}
      fatal={fatal}
    />
  );
}
