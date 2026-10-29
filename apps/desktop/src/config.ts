import { DEFAULT_STUN_URLS } from '@duochat/protocol';

const env = import.meta.env;

function value(name: keyof ImportMetaEnv): string {
  return (env[name] ?? '').trim();
}

const firebaseConfig = {
  apiKey: value('VITE_FIREBASE_API_KEY'),
  authDomain: value('VITE_FIREBASE_AUTH_DOMAIN'),
  projectId: value('VITE_FIREBASE_PROJECT_ID'),
  appId: value('VITE_FIREBASE_APP_ID'),
  messagingSenderId: value('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  storageBucket: value('VITE_FIREBASE_STORAGE_BUCKET'),
};

const requiredFirebaseFields = [
  firebaseConfig.apiKey,
  firebaseConfig.authDomain,
  firebaseConfig.projectId,
  firebaseConfig.appId,
];

const stunUrls = value('VITE_STUN_URLS')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

const turnUrl = value('VITE_TURN_URL');
const turnUsername = value('VITE_TURN_USERNAME');
const turnCredential = value('VITE_TURN_CREDENTIAL');

export const config = {
  firebase: firebaseConfig,
  isFirebaseConfigured: requiredFirebaseFields.every(Boolean),
  emulatorHost: value('VITE_FIREBASE_EMULATOR_HOST'),
  conversationId: value('VITE_CONVERSATION_ID') || 'duo',
  stunUrls: stunUrls.length > 0 ? stunUrls : DEFAULT_STUN_URLS,
  turn:
    turnUrl && turnUsername && turnCredential
      ? {
          urls: turnUrl.split(',').map((url) => url.trim()).filter(Boolean),
          username: turnUsername,
          credential: turnCredential,
        }
      : null,
  appVersion: '0.1.0',
} as const;

export function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: [...config.stunUrls] }];
  if (config.turn) servers.push(config.turn);
  return servers;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}
