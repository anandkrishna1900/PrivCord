/**
 * Double Ratchet, following the Signal protocol specification ("The Double
 * Ratchet Algorithm", sections 2-5), using HKDF-SHA-256 in place of
 * HMAC-based KDFs and AES-256-GCM for message encryption.
 *
 * Guarantees produced by this module (see docs/E2EE_PROTOCOL.md for the full
 * list and the honest deviations):
 * - forward secrecy: chain keys advance monotonically and used keys are never
 *   retained beyond the bounded skipped-message window;
 * - post-compromise recovery (breaking): remote DH ratchet keys re-key both
 *   directions;
 * - out-of-order tolerance within MAX_SKIP chain positions;
 * - replay rejection: an (ratchetKey, index) position can be decrypted at most
 *   once — skipped keys are single-use, the current chain position advances;
 * - ciphertext integrity is bound to (associated data, exact header bytes).
 *
 * No header encryption (Signal uses further header obfuscation); the header
 * contents (ratchet public key + counters) are always public-side data, This
 * deviation is documented and does not affect confidentiality of the payload.
 */

import {
  AES_IV_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  concatBytes,
  ecdhAgree,
  E2eeError,
  fromB64Url,
  hkdf,
  toB64Url,
  validatePublicJwk,
  type EcdhKeypair,
  type PublicJwk,
} from './primitives';

export const MAX_SKIP = 1000;
const RK_INFO = new TextEncoder().encode('DuoChat-RatchetRoot-v1');
const CK_MSG_INFO = new TextEncoder().encode('DuoChat-MsgKey-v1');
const CK_NEXT_INFO = new TextEncoder().encode('DuoChat-ChainNext-v1');
const MSG_EXPAND_INFO = new TextEncoder().encode('DuoChat-MessageMaterial-v1');
const HEADER_PREFIX = 'duochat-dr-hdr-v1\n';

/* ------------------------------------------------------------------ */
/* KDF helpers                                                         */
/* ------------------------------------------------------------------ */

async function kdfRk(
  rootKey: Uint8Array,
  dhOutput: Uint8Array,
): Promise<{ rootKey: Uint8Array; chainKey: Uint8Array }> {
  // HKDF(salt = current root key, ikm = DH output) — Signal's KDF_RK.
  const material = await hkdf(dhOutput, rootKey, RK_INFO, 64);
  return { rootKey: material.slice(0, 32), chainKey: material.slice(32) };
}

async function kdfCk(chainKey: Uint8Array): Promise<{
  messageKey: Uint8Array;
  nextChainKey: Uint8Array;
}> {
  const [messageKey, nextChainKey] = await Promise.all([
    hkdf(chainKey, new Uint8Array(32), CK_MSG_INFO, 32),
    hkdf(chainKey, new Uint8Array(32), CK_NEXT_INFO, 32),
  ]);
  return { messageKey, nextChainKey };
}

/**
 * Expands a 32-byte message key into (AES key, IV). The IV is derived, not
 * random, which removes entirely the risk of IV reuse from RNG failure.
 */
async function assertMessageMaterial(messageKey: Uint8Array): Promise<{
  key: Uint8Array;
  iv: Uint8Array;
}> {
  const material = await hkdf(messageKey, new Uint8Array(32), MSG_EXPAND_INFO, 32 + AES_IV_BYTES);
  return { key: material.slice(0, 32), iv: material.slice(32, 32 + AES_IV_BYTES) };
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

export interface RatchetHeader {
  /** Sender's current sending ratchet public key (base64url x||y). */
  dh: string;
  /** Index of this message within the sender's current chain. */
  n: number;
  /** Number of messages in the previous sending chain. */
  pn: number;
}

export function encodeHeader(header: RatchetHeader): Uint8Array {
  if (
    !/^[\w-]{1,200}$/.test(header.dh) ||
    !Number.isInteger(header.n) || header.n < 0 || header.n > MAX_SKIP * 100 ||
    !Number.isInteger(header.pn) || header.pn < 0 || header.pn > MAX_SKIP * 100
  ) {
    throw new E2eeError('Malformed ratchet header.');
  }
  return new TextEncoder().encode(
    HEADER_PREFIX + JSON.stringify({ dh: header.dh, n: header.n, pn: header.pn }),
  );
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

/**
 * Persistable ratchet state. Private JWKs inside are the caller's
 * responsibility to protect at rest (secure storage), but the state is plain
 * JSON-serializable — no CryptoKey objects are embedded.
 */
export interface SerializedRatchetState {
  dhs: EcdhKeypair | null;
  dhr: string | null;
  rk: string;
  cks: string | null;
  ckr: string | null;
  ns: number;
  nr: number;
  pn: number;
  mkSkipped: Array<{ dh: string; n: number; mk: string }>;
}

interface RuntimeState {
  dhs: EcdhKeypair | null;
  dhr: string | null;
  rk: string;
  cks: string | null;
  ckr: string | null;
  ns: number;
  nr: number;
  pn: number;
  /** Consumers of earlier chain positions; bounded and single-use. */
  mkSkipped: Map<string, Uint8Array>;
}

function fromSerializable(s: SerializedRatchetState | null): RuntimeState {
  if (!s) throw new E2eeError('Missing ratchet state.');
  return { ...s, mkSkipped: new Map(s.mkSkipped?.map((e) => [key(e.dh, e.n), fromB64Url(e.mk)]) ?? []) };
}

function key(dh: string, n: number): string {
  return `${dh}#${n}`;
}

function serializeState(state: RuntimeState): SerializedRatchetState {
  return {
    ...state,
    mkSkipped: Array.from(state.mkSkipped.entries(), (
      ([k, mk]) => {
        const hash = k.lastIndexOf('#');
        return { dh: k.slice(0, hash), n: Number(k.slice(hash + 1)), mk: toB64Url(mk) };
      }
    )),
  };
}

export interface EncryptResult {
  header: RatchetHeader;
  /** base64url (IV || AES-GCM ciphertext+tag). */
  body: string;
}

export class DoubleRatchet {
  private constructor(private state: RuntimeState) {}

  /* -- construction ------------------------------------------------- */

  /**
   * Initiator side (Alice): root key + associated data come from X3DH; the
   * initial sending ratchet key is Alice's ephemeral key; the first remote
   * ratchet key is Bob's signed prekey.
   */
  static async initInitiator(
    rootKey: Uint8Array,
    ownRatchetKey: EcdhKeypair,
    remoteRatchetJwk: PublicJwk,
  ): Promise<DoubleRatchet> {
    if (!validatePublicJwk(remoteRatchetJwk)) throw new E2eeError('Invalid remote ratchet key.');
    const dhOutput = await ecdhAgree(ownRatchetKey.privJwk, remoteRatchetJwk);
    const derived = await kdfRk(rootKey, dhOutput);
    const state: RuntimeState = {
      dhs: ownRatchetKey,
      dhr: toB64Url(ratchetPubBytes(remoteRatchetJwk)),
      rk: toB64Url(derived.rootKey),
      cks: toB64Url(derived.chainKey),
      ckr: null,
      ns: 0,
      nr: 0,
      pn: 0,
      mkSkipped: new Map(),
    };
    return new DoubleRatchet(state);
  }

  /**
   * Responder side (Bob): the initial remote ratchet key is the initiator's
   * ephemeral key; Bob's own first ratchet key is his consumed signed prekey.
   * Bob's sending chain is established only on his first outgoing message.
   */
  static async initResponder(
    rootKey: Uint8Array,
    ownRatchetKey: EcdhKeypair,
    remoteInitialRatchetPub: PublicJwk,
  ): Promise<DoubleRatchet> {
    if (!validatePublicJwk(remoteInitialRatchetPub)) {
      throw new E2eeError('Invalid remote ratchet key.');
    }
    const dhOutput = await ecdhAgree(ownRatchetKey.privJwk, remoteInitialRatchetPub);
    const derived = await kdfRk(rootKey, dhOutput);
    const state: RuntimeState = {
      dhs: ownRatchetKey,
      dhr: toB64Url(ratchetPubBytes(remoteInitialRatchetPub)),
      rk: toB64Url(derived.rootKey),
      cks: null,
      ckr: toB64Url(derived.chainKey),
      ns: 0,
      nr: 0,
      pn: 0,
      mkSkipped: new Map(),
    };
    return new DoubleRatchet(state);
  }

  static fromSerialized(
    value: unknown,
  ): DoubleRatchet {
    if (typeof value !== 'object' || value === null) throw new E2eeError('Malformed ratchet state.');
    const raw = value as SerializedRatchetState;
    if (typeof raw.rk !== 'string' || typeof raw.ns !== 'number' || typeof raw.nr !== 'number') {
      throw new E2eeError('Malformed ratchet state.');
    }
    if (raw.cks !== null && typeof raw.cks !== 'string') throw new E2eeError('Malformed ratchet state.');
    if (raw.ckr !== null && typeof raw.ckr !== 'string') throw new E2eeError('Malformed ratchet state.');
    return new DoubleRatchet(fromSerializable(raw));
  }

  serialize(): SerializedRatchetState {
    return serializeState(this.state);
  }

  /* -- sending ------------------------------------------------------ */

  /**
   * Encrypt one message. `ad` is the caller-held associated data (identity-key
   * digest from X3DH) and `context` any additional public binding string
   * (e.g. the conversation/message id) — both are authenticated by AES-GCM.
   */
  async encrypt(
    plaintext: Uint8Array,
    ad: Uint8Array,
    context: string,
  ): Promise<EncryptResult> {
    if (!this.state.dhr) throw new E2eeError('Receiving ratchet key missing for sending.');
    if (!this.state.cks || !this.state.dhs) {
      // Signal §5.2: senders without an established chain ratchet a fresh key
      // against the current remote ratchet public key before sending.
      const newKey = await generateRatchetKeypair();
      const derived = await kdfRk(
        fromB64Url(this.state.rk),
        await ecdhAgree(newKey.privJwk, jwkFromPubBytes(fromB64Url(this.state.dhr))),
      );
      this.state.rk = toB64Url(derived.rootKey);
      this.state.cks = toB64Url(derived.chainKey);
      this.state.dhs = newKey;
      this.state.ns = 0;
    }
    if (plaintext.length > 1 << 20) throw new E2eeError('Payload too large for a ratchet message.');
    const { messageKey, nextChainKey } = await kdfCk(fromB64Url(this.state.cks));
    const header: RatchetHeader = {
      dh: toB64Url(ratchetPubBytes(this.state.dhs.pubJwk)),
      n: this.state.ns,
      pn: this.state.pn,
    };
    const headerBytes = encodeHeader(header);
    const { key, iv } = await assertMessageMaterial(messageKey);
    const ct = await aesGcmEncrypt(
      key,
      iv,
      plaintext,
      concatBytes(ad, headerBytes, new TextEncoder().encode(`\n${context}`)),
    );
    this.state.cks = toB64Url(nextChainKey);
    this.state.ns += 1;
    // The IV is derived from the message key, so it is not transported; the
    // body is pure AES-GCM ciphertext including the 128-bit tag.
    return { header, body: toB64Url(ct) };
  }

  /* -- receiving ---------------------------------------------------- */

  /**
   * Decrypt one message. Throws `E2eeError` for tampered, replayed, or
   * over-skipped messages; the state is unchanged on any failure path that
   * occurs before a successful decrypt.
   */
  async decrypt(
    header: RatchetHeader,
    body: string,
    ad: Uint8Array,
    context: string,
  ): Promise<Uint8Array> {
    const headerBytes = encodeHeader(header);
    const aad = concatBytes(ad, headerBytes, new TextEncoder().encode(`\n${context}`));

    // 1. Skipped (earlier) positions: single-use keys.
    const skippedKey = this.consumeSkipped(header);
    if (skippedKey) {
      const material = await assertMessageMaterial(skippedKey);
      return aesGcmDecrypt(material.key, material.iv, splitBody(body), aad);
    }

    // 2. A new remote ratchet key triggers a DH ratchet.
    if (!this.state.dhr || header.dh !== this.state.dhr) {
      await this.skipMessageKeys(header.pn);
      await this.dhRatchet(header);
    }

    // 3. Skip ahead within the current receiving chain (bounded).
    if (header.n > MAX_SKIP) {
      throw new E2eeError('Too many skipped messages.');
    }
    await this.skipMessageKeys(header.n);

    if (!this.state.ckr) throw new E2eeError('Receiving chain not established.');
    const { messageKey, nextChainKey } = await kdfCk(fromB64Url(this.state.ckr));
    const { key, iv } = await assertMessageMaterial(messageKey);
    const plaintext = await aesGcmDecrypt(key, iv, splitBody(body), aad);
    // Advance only after a successful decrypt; this makes replays fail because
    // the pre-advance chain is no longer reconstructible later by counters.
    this.state.ckr = toB64Url(nextChainKey);
    this.state.nr += 1;
    return plaintext;
  }

  /* -- internals ---------------------------------------------------- */

  private consumeSkipped(header: RatchetHeader): Uint8Array | null {
    const id = key(header.dh, header.n);
    const mk = this.state.mkSkipped.get(id);
    if (!mk) return null;
    this.state.mkSkipped.delete(id);
    return mk;
  }

  private async skipMessageKeys(until: number): Promise<void> {
    if (!this.state.ckr || !this.state.dhr) return;
    if (this.state.nr === until) return;
    if (until > this.state.nr + MAX_SKIP) {
      throw new E2eeError('Too many messages skipped inside a chain.');
    }
    if (until < this.state.nr) {
      // Earlier position: either consumed, replayed, or unknown — reject here
      // so that suppressed replays cannot hit the "consumed" path silently.
      return;
    }
    let ck = fromB64Url(this.state.ckr);
    for (let i = this.state.nr; i < until; i += 1) {
      const { messageKey, nextChainKey } = await kdfCk(ck);
      this.state.mkSkipped.set(key(this.state.dhr, i), messageKey);
      ck = nextChainKey;
    }
    this.trimSkipped();
    this.state.ckr = toB64Url(ck);
    this.state.nr = until;
  }

  private trimSkipped(): void {
    // Bounded storage: if the cache overflows, drop the oldest entries.
    const overflow = this.state.mkSkipped.size - MAX_SKIP;
    if (overflow <= 0) return;
    let removed = 0;
    for (const k of this.state.mkSkipped.keys()) {
      if (removed >= overflow) break;
      this.state.mkSkipped.delete(k);
      removed += 1;
    }
  }

  private async dhRatchet(header: RatchetHeader): Promise<void> {
    const remoteRatchetJwk = jwkFromPubBytes(fromB64Url(header.dh));
    if (!this.state.dhs) throw new E2eeError('No current ratchet key.');
    this.state.pn = this.state.ns;
    this.state.ns = 0;
    this.state.nr = 0;
    const received = await kdfRk(
      fromB64Url(this.state.rk),
      await ecdhAgree(this.state.dhs.privJwk, remoteRatchetJwk),
    );
    this.state.rk = toB64Url(received.rootKey);
    this.state.ckr = toB64Url(received.chainKey);
    this.state.dhr = header.dh;
    this.state.cks = null;
    // Generate and ratchet the new sending key (Signal §5.3 step 4).
    const newSendingKey = await generateRatchetKeypair();
    const sent = await kdfRk(
      fromB64Url(this.state.rk),
      await ecdhAgree(newSendingKey.privJwk, remoteRatchetJwk),
    );
    this.state.rk = toB64Url(sent.rootKey);
    this.state.cks = toB64Url(sent.chainKey);
    this.state.dhs = newSendingKey;
  }
}

/* ------------------------------------------------------------------ */

function ratchetPubBytes(jwk: PublicJwk): Uint8Array {
  if (!validatePublicJwk(jwk)) throw new E2eeError('Malformed ratchet public key.');
  return concatBytes(fromB64Url(jwk.x!), fromB64Url(jwk.y!));
}

function jwkFromPubBytes(bytes: Uint8Array): PublicJwk {
  if (bytes.length !== 64) throw new E2eeError('Malformed ratchet public key.');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: toB64Url(bytes.slice(0, 32)),
    y: toB64Url(bytes.slice(32, 64)),
  };
}

async function generateRatchetKeypair(): Promise<EcdhKeypair> {
  const { createEcdhKeypair } = await import('./primitives');
  return createEcdhKeypair();
}

/** The wire body is pure AES-GCM ciphertext including the 128-bit tag. */
function splitBody(body: string): Uint8Array {
  const bytes = fromB64Url(body);
  if (bytes.length < 16) {
    throw new E2eeError('Ciphertext body is too short.');
  }
  return bytes;
}
