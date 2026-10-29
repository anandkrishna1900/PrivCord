import { signatureToBase64, type ChatMessage } from '@duochat/protocol';
import { secretGet, secretSet } from './secureStore';
import { fetchPeerDeviceKey } from './cloud';

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

export async function loadOrCreateIdentity(uid: string): Promise<DeviceIdentity> {
  const deviceId = localDeviceId();
  const secretKey = `ec-private-${uid}`;
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
  return { uid, deviceId, privateJwk, publicJwk };
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

export function cachePeerDeviceKey(
  uid: string,
  deviceId: string,
  jwk: JsonWebKey,
): void {
  localStorage.setItem(
    `${peerKeyCachePrefix}${uid}.${deviceId}`,
    JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }),
  );
}

export function cachedPeerDeviceKey(
  uid: string,
  deviceId: string,
): JsonWebKey | null {
  const raw = localStorage.getItem(`${peerKeyCachePrefix}${uid}.${deviceId}`);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as JsonWebKey;
    if (typeof value.x === 'string' && typeof value.y === 'string') return value;
  } catch {
    // Fall through to null.
  }
  return null;
}

export async function resolvePeerDeviceKey(
  uid: string,
  deviceId: string,
): Promise<{ key: JsonWebKey; source: 'cloud' | 'cache' } | null> {
  try {
    const key = await fetchPeerDeviceKey(uid, deviceId);
    if (key) {
      cachePeerDeviceKey(uid, deviceId, key);
      return { key, source: 'cloud' };
    }
  } catch {
    // Offline: fall back to the last verified key.
  }
  const cached = cachedPeerDeviceKey(uid, deviceId);
  return cached ? { key: cached, source: 'cache' } : null;
}

export function isOwnMessage(message: ChatMessage, uid: string): boolean {
  return message.senderId === uid;
}
