import { useCallback, useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { firebaseAuth } from '../lib/firebase';
import { loadAccess, type AccessInfo } from '../lib/cloud';
import { config } from '../config';

export type AuthView =
  | { status: 'unconfigured' }
  | { status: 'loading'; user?: User }
  | { status: 'signedOut' }
  | { status: 'signedIn'; user: User; access: AccessInfo; peerUid: string }
  | { status: 'denied'; user: User; reason: string };

export interface UseAuth {
  view: AuthView;
  error: string | null;
  busy: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

function friendlyAuthError(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Email or password is incorrect.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'auth/network-request-failed':
      return 'Network unavailable. Check your connection and try again.';
    case 'auth/operation-not-allowed':
      return 'Email/password sign-in is disabled in Firebase Authentication.';
    case 'auth/user-disabled':
      return 'This account has been disabled.';
    default:
      return error instanceof Error ? error.message : 'Sign-in failed.';
  }
}

export function useAuth(): UseAuth {
  const [view, setView] = useState<AuthView>(
    config.isFirebaseConfigured ? { status: 'loading' } : { status: 'unconfigured' },
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!config.isFirebaseConfigured) return;
    let active = true;
    const unsubscribe = onAuthStateChanged(firebaseAuth(), async (user) => {
      if (!active) return;
      if (!user) {
        setView({ status: 'signedOut' });
        setBusy(false);
        return;
      }
      setView((current) =>
        current.status === 'signedIn' && current.user.uid === user.uid
          ? current
          : { status: 'loading', user },
      );
      try {
        const access = await loadAccess(config.conversationId);
        if (!active) return;
        if (!access.memberIds.includes(user.uid)) {
          setView({
            status: 'denied',
            user,
            reason: 'This account is not one of the two approved conversation members.',
          });
          return;
        }
        const peerUid =
          access.memberIds[0] === user.uid ? access.memberIds[1] : access.memberIds[0];
        setView({ status: 'signedIn', user, access, peerUid });
        setError(null);
      } catch (caught) {
        if (!active) return;
        setView({
          status: 'denied',
          user,
          reason:
            caught instanceof Error
              ? caught.message
              : 'Could not verify access to the conversation.',
        });
      } finally {
        if (active) setBusy(false);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!config.isFirebaseConfigured) {
      setError('Firebase configuration is missing.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signInWithEmailAndPassword(firebaseAuth(), email.trim(), password);
    } catch (caught) {
      setError(friendlyAuthError(caught));
      setBusy(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      await firebaseSignOut(firebaseAuth());
      setError(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { view, error, busy, signIn, signOut, clearError };
}
