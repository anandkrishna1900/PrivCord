import {
  createPairingRecord,
  deriveIdentityFromPhrase,
  encodeContactCard,
  isPairingRecord,
  signatureToBase64,
  uidFromDh,
  verifyIdentityProof,
  type ChatMessage,
  type PairingRecord,
} from '@duochat/protocol';
import { secretGet, secretSet } from './secureStore';

/** Fixed suffix for per-install secrets (the key itself defines who we are). */
export const LOCAL_ID = 'local';

export interface DeviceIdentity {
  /** Fingerprint of the ECDH identity key; identical on every device restored from the same phrase. */
  uid: string;
  deviceId: string;
  /** ECDSA signing key: signs challenges and sealed blobs. */
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
  /** ECDH identity key: receives sealed blobs. */
  dhPrivateJwk: JsonWebKey;
  dhPublicJwk: JsonWebKey;
  /** Self-signature binding the two public keys. */
  identityProof: string;
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

const SECRET_SIGN = `ec-private-${LOCAL_ID}`;
const SECRET_DH = `ec-dh-private-${LOCAL_ID}`;
const SECRET_PROOF = `ec-proof-${LOCAL_ID}`;

function slimPublic(jwk: JsonWebKey): JsonWebKey {
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/**
 * Create (or replace) the identity from a 12-word phrase. The phrase itself is never stored;
 * only the derived private keys go into the OS secure store.
 */
export async function createIdentityFromPhrase(phrase: string, passphrase = ''): Promise<string> {
  const derived = await deriveIdentityFromPhrase(phrase.trim().toLowerCase(), passphrase);
  await secretSet(SECRET_SIGN, JSON.stringify(derived.identity.signKey.privJwk));
  await secretSet(SECRET_DH, JSON.stringify(derived.identity.dhKey.privJwk));
  await secretSet(SECRET_PROOF, derived.identity.identityProof);
  return derived.identityFingerprint;
}

async function readJwk(key: string): Promise<JsonWebKey | null> {
  const raw = await secretGet(key);
  if (!raw) return null;
  try {
    const jwk = JSON.parse(raw) as JsonWebKey;
    return jwk.kty === 'EC' && jwk.d && jwk.x && jwk.y ? jwk : null;
  } catch {
    return null;
  }
}

/** The stored identity, or null on first run (the app then forces the 12-word phrase flow). */
export async function loadIdentity(): Promise<DeviceIdentity | null> {
  const [signPriv, dhPriv, identityProof] = await Promise.all([
    readJwk(SECRET_SIGN),
    readJwk(SECRET_DH),
    secretGet(SECRET_PROOF),
  ]);
  if (!signPriv || !dhPriv || !identityProof) return null;
  const dhPublicJwk = slimPublic(dhPriv);
  return {
    uid: await uidFromDh(dhPublicJwk),
    deviceId: localDeviceId(),
    privateJwk: signPriv,
    publicJwk: slimPublic(signPriv),
    dhPrivateJwk: dhPriv,
    dhPublicJwk,
    identityProof,
  };
}

export function contactCardOf(identity: DeviceIdentity, name?: string): string {
  return encodeContactCard({
    v: 1,
    sign: identity.publicJwk,
    dh: identity.dhPublicJwk,
    proof: identity.identityProof,
    ...(name ? { name } : {}),
  });
}

/** An id is only valid if it is the fingerprint of the key it comes with. */
export async function uidMatchesKeys(uid: string, dh: JsonWebKey, sign: JsonWebKey, proof: string): Promise<boolean> {
  return (await uidFromDh(dh)) === uid && (await verifyIdentityProof(sign, dh, proof));
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
  dhJwk?: JsonWebKey;
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
