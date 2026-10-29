import type { User } from 'firebase/auth';
import { useAuth } from './hooks/useAuth';
import { useChatEngine } from './hooks/useChatEngine';
import { useSettings } from './hooks/useSettings';
import { AuthScreen } from './components/AuthScreen';
import { ChatLayout } from './components/ChatLayout';
import { DeniedScreen, SetupScreen } from './components/SetupScreen';
import { LoaderIcon, ShieldIcon } from './components/Icons';
import type { AppSettings } from './lib/settings';

function SignedInView({
  user,
  peerUid,
  onSignOut,
  settings,
  updateSettings,
}: {
  user: User;
  peerUid: string;
  onSignOut: () => Promise<void>;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
}) {
  const { state, engine, fatal } = useChatEngine(user, peerUid);
  return (
    <ChatLayout
      user={user}
      state={state}
      engine={engine}
      settings={settings}
      updateSettings={updateSettings}
      onSignOut={onSignOut}
      fatal={fatal}
    />
  );
}

export default function App() {
  const auth = useAuth();
  const { settings, update } = useSettings();

  if (auth.view.status === 'unconfigured') return <SetupScreen />;

  if (auth.view.status === 'signedOut') {
    return (
      <AuthScreen busy={auth.busy} error={auth.error} onSubmit={auth.signIn} />
    );
  }

  if (auth.view.status === 'denied') {
    return (
      <DeniedScreen
        reason={auth.view.reason}
        uid={auth.view.user.uid}
        email={auth.view.user.email}
        onSignOut={auth.signOut}
      />
    );
  }

  if (auth.view.status === 'loading') {
    return (
      <main className="loading-page">
        <div className="splash">
          <div className="brand-lock large">
            <LoaderIcon size={26} className="spin" />
          </div>
          <h1>DuoChat</h1>
          <p className="muted">Verifying the two-person allowlist…</p>
          {auth.view.user?.email ? (
            <p className="muted small">{auth.view.user.email}</p>
          ) : null}
          <button type="button" className="button ghost small" onClick={() => void auth.signOut()}>
            Sign out
          </button>
        </div>
      </main>
    );
  }

  return (
    <SignedInView
      key={auth.view.user.uid}
      user={auth.view.user}
      peerUid={auth.view.peerUid}
      onSignOut={auth.signOut}
      settings={settings}
      updateSettings={update}
    />
  );
}
