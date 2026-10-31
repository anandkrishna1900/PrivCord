import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  canonicalJson,
  createEcdhKeypair,
  E2eeError,
  ecdhAgree,
  ecdsaSign,
  ecdsaVerify,
  fromB64Url,
  hkdf,
  randomBytes,
  sha256,
  toB64Url,
  validatePublicJwk,
  type PrivateJwk,
  type PublicJwk,
} from '../e2ee';

/** A signed, encrypted payload addressed to one contact. Relays only ever see this. */
export interface SealedBlob {
  v: 1;
  to: string;
  from: string;
  epk: PublicJwk;
  iv: string;
  ct: string;
  sig: string;
}

export const MAX_SEALED_BLOB_BYTES = 64 * 1024;

const SEAL_SALT = 'duochat-seal-v1';
const MAILBOX_PREFIX = 'duochat-mailbox-v1|';

const enc = new TextEncoder();
const dec = new TextDecoder();

function signedPart(blob: Omit<SealedBlob, 'sig'>): Uint8Array {
  return enc.encode(
    canonicalJson({ v: blob.v, to: blob.to, from: blob.from, epk: blob.epk, iv: blob.iv, ct: blob.ct }),
  );
}

async function sealKey(secret: Uint8Array, to: string, from: string): Promise<Uint8Array> {
  return hkdf(secret, enc.encode(SEAL_SALT), enc.encode(`${to}|${from}`), 32);
}

/** Where a client publishes to / listens on. Hashing keeps the uid out of relay logs. */
export async function mailboxFor(uid: string): Promise<string> {
  const digest = await sha256(enc.encode(MAILBOX_PREFIX + uid));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SealInput {
  payload: unknown;
  fromUid: string;
  toUid: string;
  /** Recipient's ECDH identity public key. */
  toDh: PublicJwk;
  /** Sender's ECDSA identity signing key. */
  signPriv: PrivateJwk;
}

export async function seal(input: SealInput): Promise<SealedBlob> {
  const ephemeral = await createEcdhKeypair();
  const key = await sealKey(await ecdhAgree(ephemeral.privJwk, input.toDh), input.toUid, input.fromUid);
  const iv = randomBytes(12);
  const aad = enc.encode(`${input.toUid}|${input.fromUid}`);
  const ct = await aesGcmEncrypt(key, iv, enc.encode(JSON.stringify(input.payload)), aad);
  const unsigned = {
    v: 1 as const,
    to: input.toUid,
    from: input.fromUid,
    epk: { kty: ephemeral.pubJwk.kty, crv: ephemeral.pubJwk.crv, x: ephemeral.pubJwk.x, y: ephemeral.pubJwk.y },
    iv: toB64Url(iv),
    ct: toB64Url(ct),
  };
  const sig = toB64Url(await ecdsaSign(input.signPriv, signedPart(unsigned)));
  const blob: SealedBlob = { ...unsigned, sig };
  if (encodeBlob(blob).length > MAX_SEALED_BLOB_BYTES) throw new E2eeError('Payload too large to seal.');
  return blob;
}

/** Signs the parts of a blob that must not change. Used by blob kinds that are not ECDH-sealed (invite codes). */
export async function signBlob(unsigned: Omit<SealedBlob, 'sig'>, signPriv: PrivateJwk): Promise<string> {
  return toB64Url(await ecdsaSign(signPriv, signedPart(unsigned)));
}

export async function verifyBlobSignature(blob: SealedBlob, signPub: PublicJwk): Promise<boolean> {
  const { sig, ...unsigned } = blob;
  try {
    return await ecdsaVerify(signPub, fromB64Url(sig), signedPart(unsigned));
  } catch {
    return false;
  }
}

export interface OpenInput {
  blob: SealedBlob;
  ownUid: string;
  /** Own ECDH identity private key. */
  ownDhPriv: PrivateJwk;
  /** The sender's pinned ECDSA signing public key. */
  senderSign: PublicJwk;
  /** Expected sender uid (the pinned contact). */
  senderUid: string;
}

/** Returns the payload, or null for anything not addressed to us / not from the pinned sender / tampered. */
export async function open(input: OpenInput): Promise<unknown | null> {
  const { blob } = input;
  try {
    if (!validateBlob(blob)) return null;
    if (blob.to !== input.ownUid || blob.from !== input.senderUid) return null;
    const { sig, ...unsigned } = blob;
    if (!(await ecdsaVerify(input.senderSign, fromB64Url(sig), signedPart(unsigned)))) return null;
    const key = await sealKey(await ecdhAgree(input.ownDhPriv, blob.epk), blob.to, blob.from);
    const plain = await aesGcmDecrypt(
      key,
      fromB64Url(blob.iv),
      fromB64Url(blob.ct),
      enc.encode(`${blob.to}|${blob.from}`),
    );
    return JSON.parse(dec.decode(plain)) as unknown;
  } catch {
    return null;
  }
}

export function validateBlob(value: unknown): value is SealedBlob {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Record<string, unknown>;
  return (
    b.v === 1 &&
    typeof b.to === 'string' &&
    typeof b.from === 'string' &&
    validatePublicJwk(b.epk) &&
    typeof b.iv === 'string' &&
    typeof b.ct === 'string' &&
    typeof b.sig === 'string'
  );
}

export function encodeBlob(blob: SealedBlob): string {
  return toB64Url(enc.encode(JSON.stringify(blob)));
}

export function decodeBlob(text: string): SealedBlob | null {
  try {
    const parsed: unknown = JSON.parse(dec.decode(fromB64Url(text)));
    return validateBlob(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
