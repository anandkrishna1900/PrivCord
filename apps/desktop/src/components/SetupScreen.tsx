import { AlertIcon, LogOutIcon, ShieldIcon } from './Icons';

export function SetupScreen() {
  return (
    <main className="centered-page">
      <section className="setup-card">
        <div className="brand-lock large">
          <ShieldIcon size={28} />
        </div>
        <p className="eyebrow">First run</p>
        <h1> Firebase configuration required</h1>
        <p className="muted">
          DuoChat does not ship with credentials. Create a Firebase web app and
          copy the values into <code>apps/desktop/.env</code>.
        </p>
        <pre className="code-block">{`cp apps/desktop/.env.example apps/desktop/.env

VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_APP_ID=...`}</pre>
        <p className="muted">
          Then seed the two-user allowlist with{' '}
          <code>scripts/seed-firebase.mjs</code> and deploy{' '}
          <code>firestore.rules</code>. Full instructions are in{' '}
          <code>docs/DEPLOYMENT.md</code> and <code>README.md</code>.
        </p>
        <div className="callout">
          <AlertIcon size={17} />
          <p>
            Direct peer-to-peer messaging still needs a first signaling exchange.
            Configure the cloud backend before relying on automatic reconnection.
          </p>
        </div>
      </section>
    </main>
  );
}

export function DeniedScreen({
  reason,
  uid,
  email,
  onSignOut,
}: {
  reason: string;
  uid: string;
  email: string | null;
  onSignOut: () => Promise<void>;
}) {
  return (
    <main className="centered-page">
      <section className="setup-card">
        <div className="brand-lock large danger">
          <ShieldIcon size={28} />
        </div>
        <p className="eyebrow">Access denied</p>
        <h1>This account is not approved</h1>
        <p className="muted">{reason}</p>
        <dl className="detail-grid">
          <div>
            <dt>Email</dt>
            <dd>{email ?? 'Unknown'}</dd>
          </div>
          <div>
            <dt>User ID</dt>
            <dd className="mono selectable">{uid}</dd>
          </div>
        </dl>
        <p className="muted">
          The owner must add this exact user ID to <code>config/access</code> and
          the conversation member list, then redeploy or update the document.
        </p>
        <button type="button" className="button secondary" onClick={() => void onSignOut()}>
          <LogOutIcon size={16} />
          Sign out
        </button>
      </section>
    </main>
  );
}
