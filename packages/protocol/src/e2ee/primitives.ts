/**
 * Standard cryptographic primitives for the DuoChat E2EE core.
 *
 * Rules (see docs/E2EE_PROTOCOL.md):
 * - Only standardized, reviewed primitives are used: P-256 ECDH, HKDF-SHA-256,
 *   AES-256-GCM, SHA-256, ECDSA P-256 (with SHA-256).
 * - No custom crypto math is implemented here; all operations delegate to
 *   WebCrypto (`globalThis.crypto.subtle`), which is backed by OpenSSL in Node
 *   and by platform stores in browsers.
 * - All serialized keys are JWKs so that session state is JSON-persistable.
 *   Callers are responsible for storing private JWKs in secure storage; nothing
 *   in this module writes keys to disk.
 */

export type PublicJwk = JsonWebKey;
export type PrivateJwk = JsonWebKey;

export interface EcdhKeypair {
  pubJwk: PublicJwk;
  privJwk: PrivateJwk;
}

export interface EcdsaKeypair {
  pubJwk: PublicJwk;
  privJwk: PrivateJwk;
}

export class E2eeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'E2eeError';
  }
}

function getSubtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) {
    throw new E2eeError('WebCrypto is unavailable in this environment.');
  }
  return c.subtle;
}

/* ------------------------------------------------------------------ */
/* Encoding helpers                                                    */
/* ------------------------------------------------------------------ */

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toB64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    out += B64URL_ALPHABET[b0 >> 2]!;
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += has1 ? B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]! : '';
    out += has2 ? B64URL_ALPHABET[b2 & 0x3f]! : '';
  }
  return out;
}

export function fromB64Url(value: string): Uint8Array {
  if (typeof value !== 'string') throw new E2eeError('Not a base64url string.');
  let remainder = 0;
  let remainderBits = 0;
  const out: number[] = [];
  for (const ch of value) {
    const idx = B64URL_ALPHABET.indexOf(ch);
    if (idx < 0) throw new E2eeError('Invalid base64url character.');
    remainder = (remainder << 6) | idx;
    remainderBits += 6;
    if (remainderBits >= 8) {
      remainderBits -= 8;
      out.push((remainder >> remainderBits) & 0xff);
      remainder &= (1 << remainderBits) - 1;
    }
  }
  if (remainderBits >= 6 && remainder !== 0) {
    // Non-zero trailing bits mean the string is not canonically padded.
    throw new E2eeError('Invalid base64url padding.');
  }
  return new Uint8Array(out);
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0 || length > 1 << 24) {
    throw new E2eeError('Invalid random length.');
  }
  const out = new Uint8Array(length);
  getGlobalCrypto().getRandomValues(out);
  return out;
}

function getGlobalCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c) throw new E2eeError('WebCrypto is unavailable in this environment.');
  return c;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function zeroBytes(length: number): Uint8Array {
  return new Uint8Array(length);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/** Stable JSON with sorted top-level keys; used for hashing/signing structures. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value) ?? 'null';
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new E2eeError('Unsupported value for canonical JSON.');
}

/* ------------------------------------------------------------------ */
/* Hash / KDF                                                          */
/* ------------------------------------------------------------------ */

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await getSubtle().digest('SHA-256', asBuffer(data));
  return new Uint8Array(digest);
}

/**
 * HKDF-SHA-256 (RFC 5869) via WebCrypto.
 */
export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  if (!Number.isInteger(lengthBytes) || lengthBytes <= 0 || lengthBytes > 8160) {
    throw new E2eeError('Invalid HKDF output length.');
  }
  const key = await getSubtle().importKey(
    'raw',
    asBuffer(ikm),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await getSubtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: asBuffer(salt), info: asBuffer(info) },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/* ------------------------------------------------------------------ */
/* Key generation                                                      */
/* ------------------------------------------------------------------ */

function jwkCurveJwk(jwk: JsonWebKey): PublicJwk {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

export async function createEcdhKeypair(): Promise<EcdhKeypair> {
  const pair = await getSubtle().generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const priv = await getSubtle().exportKey('jwk', pair.privateKey);
  const pub = await getSubtle().exportKey('jwk', pair.publicKey);
  return { privJwk: priv as PrivateJwk, pubJwk: jwkCurveJwk(pub) };
}

export async function createEcdsaKeypair(): Promise<EcdsaKeypair> {
  const pair = await getSubtle().generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const priv = await getSubtle().exportKey('jwk', pair.privateKey);
  const pub = await getSubtle().exportKey('jwk', pair.publicKey);
  return { privJwk: priv as PrivateJwk, pubJwk: jwkCurveJwk(pub) };
}

export function validatePublicJwk(value: unknown): value is PublicJwk {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const jwk = value as JsonWebKey;
  return jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string';
}

/* ------------------------------------------------------------------ */
/* ECDH agreement                                                      */
/* ------------------------------------------------------------------ */

const ECDH_PRIV_USAGES: KeyUsage[] = ['deriveBits'];

async function importEcdhPriv(jwk: unknown): Promise<CryptoKey> {
  return getSubtle().importKey('jwk', jwk as JsonWebKey, { name: 'ECDH', namedCurve: 'P-256' }, false, ECDH_PRIV_USAGES);
}

async function importEcdhPub(jwk: unknown): Promise<CryptoKey> {
  return getSubtle().importKey('jwk', jwk as JsonWebKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

export async function ecdhAgree(
  priv: PrivateJwk,
  peerPublic: PublicJwk,
): Promise<Uint8Array> {
  if (!validatePublicJwk(peerPublic)) throw new E2eeError('Invalid peer public key.');
  const privKey = await importEcdhPriv(priv);
  const pubKey = await importEcdhPub(peerPublic);
  const bits = await getSubtle().deriveBits(
    { name: 'ECDH', public: pubKey },
    privKey,
    256,
  );
  return new Uint8Array(bits);
}

/* ------------------------------------------------------------------ */
/* ECDSA sign / verify                                                 */
/* ------------------------------------------------------------------ */

export async function ecdsaSign(priv: PrivateJwk, message: Uint8Array): Promise<Uint8Array> {
  const key = await getSubtle().importKey(
    'jwk',
    priv as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const sig = await getSubtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, asBuffer(message));
  return new Uint8Array(sig);
}

export async function ecdsaVerify(
  pub: PublicJwk,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  if (!validatePublicJwk(pub)) return false;
  let key: CryptoKey;
  try {
    key = await getSubtle().importKey(
      'jwk',
      pub as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch {
    return false;
  }
  try {
    return await getSubtle().verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      asBuffer(signature),
      asBuffer(message),
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* AES-256-GCM                                                         */
/* ------------------------------------------------------------------ */

export const AES_KEY_BYTES = 32;
export const AES_IV_BYTES = 12;

export async function aesGcmEncrypt(
  keyBytes: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (keyBytes.length !== AES_KEY_BYTES) throw new E2eeError('Message key must be 32 bytes.');
  if (iv.length !== AES_IV_BYTES) throw new E2eeError('IV must be 12 bytes.');
  const key = await getSubtle().importKey(
    'raw',
    asBuffer(keyBytes),
    'AES-GCM',
    false,
    ['encrypt'],
  );
  try {
    const ct = await getSubtle().encrypt(
      { name: 'AES-GCM', iv: asBuffer(iv), additionalData: asBuffer(aad), tagLength: 128 },
      key,
      asBuffer(plaintext),
    );
    return new Uint8Array(ct);
  } catch (error) {
    throw new E2eeError('Encryption rejected the inputs.', { cause: error as Error });
  }
}

export async function aesGcmDecrypt(
  keyBytes: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (keyBytes.length !== AES_KEY_BYTES) throw new E2eeError('Message key must be 32 bytes.');
  const key = await getSubtle().importKey(
    'raw',
    asBuffer(keyBytes),
    'AES-GCM',
    false,
    ['decrypt'],
  );
  try {
    const pt = await getSubtle().decrypt(
      { name: 'AES-GCM', iv: asBuffer(iv), additionalData: asBuffer(aad), tagLength: 128 },
      key,
      asBuffer(ciphertext),
    );
    return new Uint8Array(pt);
  } catch (error) {
    // Authentication failures (wrong key, wrong AAD, tampering, replays) all
    // surface here as the same error so callers cannot distinguish causes.
    throw new E2eeError('Message authentication failed.', { cause: error as Error });
  }
}

/**
 * WebCrypto accepts ArrayBuffer-backed views; copy into a fresh ArrayBuffer to
 * avoid SharedArrayBuffer typing and detached-buffer pitfalls.
 */
function asBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}
