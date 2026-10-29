import { useState, type FormEvent } from 'react';
import {
  AlertIcon,
  EyeIcon,
  EyeOffIcon,
  LinkIcon,
  LoaderIcon,
  LockIcon,
  ShieldIcon,
} from './Icons';

export function AuthScreen({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password || busy) return;
    await onSubmit(email, password);
  }

  return (
    <main className="auth-page">
      <section className="auth-brand">
        <div className="brand-lock">
          <ShieldIcon size={22} />
        </div>
        <p className="eyebrow">Private by design</p>
        <h1>DuoChat</h1>
        <p className="auth-lede">
          One conversation. Two people. Cloud delivery normally, direct
          peer-to-peer delivery when the cloud is unavailable.
        </p>
        <ul className="feature-list">
          <li>
            <LockIcon size={17} />
            Two-account allowlist enforced by server rules
          </li>
          <li>
            <LinkIcon size={17} />
            WebRTC direct messaging across networks
          </li>
          <li>
            <ShieldIcon size={17} />
            Encrypted local storage and verified peer identities
          </li>
        </ul>
        <p className="auth-footnote">
          No public registration. Accounts are created by the conversation owner
          in Firebase Authentication.
        </p>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <header>
            <p className="eyebrow">Sign in</p>
            <h2>Your private conversation</h2>
            <p className="muted">
              Use the email and password configured for one of the two approved
              accounts.
            </p>
          </header>

          <form onSubmit={submit} className="auth-form">
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                autoFocus
                required
                disabled={busy}
                placeholder="you@example.com"
              />
            </label>
            <label className="field">
              <span>Password</span>
              <div className="input-with-action">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                  disabled={busy}
                  placeholder="Your password"
                />
                <button
                  type="button"
                  className="icon-button subtle"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
                </button>
              </div>
            </label>

            {error ? (
              <div className="inline-error" role="alert">
                <AlertIcon size={16} />
                <span>{error}</span>
              </div>
            ) : null}

            <button type="submit" className="button primary wide" disabled={busy}>
              {busy ? <LoaderIcon size={17} className="spin" /> : null}
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="auth-secure-note">
            <LockIcon size={14} />
            Sessions use Firebase Authentication. Access is denied to any account
            outside the two-member allowlist.
          </p>
        </div>
      </section>
    </main>
  );
}
