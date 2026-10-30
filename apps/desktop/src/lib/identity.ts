import {
  createPairingRecord,
  isPairingRecord,
  signatureToBase64,
  type ChatMessage,
  type PairingRecord,
} from '@duochat/protocol';
import { secretGet, secretSet } from './secureStore';

/** Fixed suffix for per-install secrets (the key itself defines who we are). */
export const LOCAL_ID = 'local';

export interface DeviceIdentity {
  uid: string;
  deviceId: string;
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

const DEVICE_KEY = 'duochat.device-id';

export function localDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/** Stable account id: a SHA-256 fingerprint of the public key. Nothing to register or sign in to. */
export async function uidFromPublicJwk(jwk: JsonWebKey): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${jwk.x ?? ''}.${jwk.y ?? ''}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `u${hex.slice(0, 32)}`;
}

export async function loadOrCreateIdentity(): Promise<DeviceIdentity> {
  const deviceId = localDeviceId();
  const secretKey = `ec-private-${LOCAL_ID}`;
  let privateJwk: JsonWebKey | null = null;
  const stored = await secretGet(secretKey);
  if (stored) {
    try {
      privateJwk = JSON.parse(stored) as JsonWebKey;
    } catch {
      privateJwk = null;
    }
  }
  if (!privateJwk || privateJwk.kty !== 'EC' || !privateJwk.d) {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const exported = await crypto.subtle.exportKey('jwk', pair.privateKey);
    privateJwk = exported;
    await secretSet(secretKey, JSON.stringify(exported));
  }
  const publicJwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: privateJwk.x,
    y: privateJwk.y,
  };
  return { uid: await uidFromPublicJwk(publicJwk), deviceId, privateJwk, publicJwk };
}

export async function signChallenge(
  identity: DeviceIdentity,
  challenge: string,
): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    identity.privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(challenge),
  );
  return signatureToBase64(signature);
}

const peerKeyCachePrefix = 'duochat.peer-key.';

/** The one pinned peer (this app is exactly two people), or null before first pairing. */
export function loadPairing(): PairingRecord | null {
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key?.startsWith(peerKeyCachePrefix)) continue;
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? '');
      if (isPairingRecord(value)) return value;
    } catch {
      // Ignore unreadable entries.
    }
  }
  return null;
}

export function savePairing(input: {
  peerUid: string;
  peerDeviceId: string;
  publicKeyJwk: JsonWebKey;
  safetyNumber: string;
}): PairingRecord {
  const previous = loadPairing();
  const record = createPairingRecord({ ...input, previous });
  purgePeerKeyCaches();
  localStorage.setItem(
    `${peerKeyCachePrefix}${record.peerUid}.${record.peerDeviceId}`,
    JSON.stringify(record),
  );
  return record;
}

export function isOwnMessage(message: ChatMessage, uid: string): boolean {
  return message.senderId === uid;
}

/**
 * Kill switch helper: drop locally cached peer device keys (trust records).
 * With an optional peer uid only that contact's entries are purged; without
 * one, every cached peer key is erased. Returns the number of removed entries.
 */
export function purgePeerKeyCaches(peerUid?: string): number {
  if (typeof localStorage === 'undefined') return 0;
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (!key.startsWith(peerKeyCachePrefix)) continue;
    if (peerUid && !key.startsWith(`${peerKeyCachePrefix}${peerUid}.`)) continue;
    doomed.push(key);
  }
  for (const key of doomed) localStorage.removeItem(key);
  return doomed.length;
}
