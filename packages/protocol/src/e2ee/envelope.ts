/**
 * `DuoEnvelope` — the transport-independent encrypted message container.
 *
 * One envelope type is used by *every* transport (relay mailbox, WebRTC
 * DataChannel, BLE packets, relay storage): a relay or signaling service that
 * handles an envelope sees only opaque ciphertext, routing counters, and
 * identity key material chosen for verification — never message plaintext.
 * It carries a `ctx` value (caller-chosen, e.g. the deduplication message id)
 * that is authenticated together with the payload, so a carrier cannot rewrite
 * a stored envelope's binding without failing decryption.
 */

import {
  canonicalJson,
  E2eeError,
  fromB64Url,
  sha256,
  toB64Url,
  validatePublicJwk,
  type PublicJwk,
} from './primitives';
import { DoubleRatchet, type RatchetHeader, type SerializedRatchetState } from './ratchet';
import {
  createPrekeyIntro,
  initiateX3dh,
  respondX3dh,
  validateBundle,
  verifyIdentityProof,
  type IdentityKeyPair,
  type OneTimePrekey,
  type PrekeyBundle,
  type PrekeyIntro,
  type SignedPrekey,
} from './x3dh';

export const ENVELOPE_VERSION = 1 as const;
export type EnvelopeKind = 'dr1';

export interface DuoEnvelope {
  v: typeof ENVELOPE_VERSION;
  kind: EnvelopeKind;
  /** Public deduplication id (digest of the full envelope). */
  id: string;
  /** Caller-chosen public context bound by the MAC (e.g. message id). */
  ctx: string;
  header: {
    dh: string;
    n: number;
    pn: number;
  };
  /** base64url AES-GCM ciphertext (128-bit included); the IV is derived from the message key, not transported. */
  body: string;
  /** Present only on the first envelope of a session (X3DH initiation). */
  prekey?: PrekeyIntro;
}

/** Full structural validation; does not attempt decryption. */
export function validateEnvelope(value: unknown): value is DuoEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as DuoEnvelope;
  if (e.v !== ENVELOPE_VERSION || e.kind !== 'dr1') return false;
  if (typeof e.id !== 'string' || e.id.length === 0 || e.id.length > 64) return false;
  if (typeof e.ctx !== 'string' || e.ctx.length === 0 || e.ctx.length > 128) return false;
  if (typeof e.body !== 'string' || e.body.length === 0) return false;
  if (
    !e.header ||
    typeof e.header.dh !== 'string' ||
    e.header.dh.length === 0 ||
    !Number.isInteger(e.header.n) ||
    !Number.isInteger(e.header.pn)
  ) {
    return false;
  }
  if (e.prekey !== undefined) {
    const p = e.prekey;
    if (
      !p ||
      !validatePublicJwk(p.senderSignJwk) ||
      !validatePublicJwk(p.senderDhJwk) ||
      !validatePublicJwk(p.ephemeralDhJwk) ||
      typeof p.senderIdentityProof !== 'string' ||
      typeof p.signedPrekeyId !== 'number'
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Digest of the canonical envelope content — used as the public dedup id.
 * 64 bytes of identity + 12 bytes IV + ciphertext all roll in.
 */
export async function envelopeDigest(
  parts: Pick<DuoEnvelope, 'kind' | 'ctx' | 'header' | 'body' | 'prekey'>,
): Promise<string> {
  return toB64Url(
    await sha256(
      new TextEncoder().encode(
        canonicalJson({
          kind: parts.kind,
          ctx: parts.ctx,
          header: parts.header,
          body: parts.body,
          prekey: parts.prekey ?? null,
        }),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Associated data                                                     */
/* ------------------------------------------------------------------ */

/**
 * Public AD binding both identity ECDH keys, computed identically by initiator
 * and responder (initiator's key first). SHA-256(TH(IKa) || 0x0A || TH(IKb)).
 */
export async function associatedDataFor(
  selfIdentityDhJwk: PublicJwk,
  peerIdentityDhJwk: PublicJwk,
): Promise<Uint8Array> {
  return sha256(
    new TextEncoder().encode(
      `${JSON.stringify(thumb(selfIdentityDhJwk))}\n${JSON.stringify(thumb(peerIdentityDhJwk))}`,
    ),
  );
}

function thumb(jwk: PublicJwk): { kty: string; crv: string; x: string; y: string } {
  if (!validatePublicJwk(jwk)) throw new E2eeError('Malformed public key.');
  return { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! };
}

/* ------------------------------------------------------------------ */
/* Contact identity                                                    */
/* ------------------------------------------------------------------ */

export interface DuoContactIdentity {
  signJwk: PublicJwk;
  dhJwk: PublicJwk;
  identityProof: string;
}

export async function contactFromBundleIdentity(
  identity: PrekeyBundle['identity'],
): Promise<DuoContactIdentity> {
  if (
    !validatePublicJwk(identity?.signJwk) ||
    !validatePublicJwk(identity?.dhJwk) ||
    typeof identity?.identityProof !== 'string'
  ) {
    throw new E2eeError('Malformed contact identity.');
  }
  if (!(await verifyIdentityProof(identity.signJwk, identity.dhJwk, identity.identityProof))) {
    throw new E2eeError('Contact identity proof is invalid.');
  }
  return {
    signJwk: identity.signJwk,
    dhJwk: identity.dhJwk,
    identityProof: identity.identityProof,
  };
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

export interface DuoSession {
  /** Verified peer identity this session is bound to. */
  contact: DuoContactIdentity;
  /** Public associated data (identity-key digest). Persistable. */
  associatedData: Uint8Array;
  ratchet: DoubleRatchet;
}

export interface SerializedDuoSession {
  contact: DuoContactIdentity;
  associatedData: string;
  ratchet: SerializedRatchetState;
}

export function serializeSession(session: DuoSession): SerializedDuoSession {
  return {
    contact: session.contact,
    associatedData: toB64Url(session.associatedData),
    ratchet: session.ratchet.serialize(),
  };
}

export function restoreSession(value: unknown): DuoSession {
  if (typeof value !== 'object' || value === null) throw new E2eeError('Malformed session snapshot.');
  const s = value as SerializedDuoSession;
  if (
    !validatePublicJwk(s?.contact?.signJwk) ||
    !validatePublicJwk(s?.contact?.dhJwk) ||
    typeof s?.associatedData !== 'string'
  ) {
    throw new E2eeError('Malformed session snapshot.');
  }
  return {
    contact: s.contact,
    associatedData: fromB64Url(s.associatedData),
    ratchet: DoubleRatchet.fromSerialized(s.ratchet),
  };
}

/* ------------------------------------------------------------------ */
/* Prekey inventory (host-app responsibility)                          */
/* ------------------------------------------------------------------ */

export interface PrekeyInventory {
  getSignedPrekey(id: number): SignedPrekey | null;
  getOneTimePrekey(id: number): OneTimePrekey | null;
}

/* ------------------------------------------------------------------ */
/* Session establishment                                               */
/* ------------------------------------------------------------------ */

export interface SessionStart {
  /** First envelope (carries the prekey intro) ready for any transport. */
  envelope: DuoEnvelope;
  /** Established session to keep for subsequent traffic. */
  session: DuoSession;
}

/**
 * Initiator side: create a session from a prekey bundle and immediately
 * produce the first envelope. The bundle must be fetched over a trustable
 * path and is cryptographically re-validated here in every case.
 */
export async function initiateSession(
  identity: IdentityKeyPair,
  bundle: PrekeyBundle,
  ctx: string,
  payload: Uint8Array,
): Promise<SessionStart> {
  const initiation = await initiateX3dh(identity, bundle);
  const associatedData = await associatedDataFor(
    identity.dhKey.pubJwk,
    bundle.identity.dhJwk,
  );
  const ratchet = await DoubleRatchet.initInitiator(
    initiation.rootKey,
    initiation.ephemeral,
    bundle.signedPrekey.dhJwk,
  );
  const { header, body } = await ratchet.encrypt(payload, associatedData, ctx);
  const prekey = createPrekeyIntro(identity, initiation);
  return {
    envelope: {
      v: ENVELOPE_VERSION,
      kind: 'dr1',
      id: await envelopeDigest({ kind: 'dr1', ctx, header, body, prekey }),
      ctx,
      header,
      body,
      prekey,
    },
    session: {
      contact: await contactFromBundleIdentity(bundle.identity),
      associatedData,
      ratchet,
    },
  };
}

export interface AcceptedSession {
  session: DuoSession;
  payload: Uint8Array;
  /** Prekeys to mark consumed (and eventually delete) in the inventory. */
  consumed: { signedPrekeyId: number; oneTimePrekeyId?: number };
}

/**
 * Responder side: consume the session-initializing envelope, decrypt the first
 * payload, and derive the session. The prekey inventory must still hold the
 * referenced signed (and one-time) prekeys; the caller should afterwards mark
 * them consumed so the same intro cannot be replayed into a fresh session.
 */
export async function acceptInitialEnvelope(
  identity: IdentityKeyPair,
  inventory: PrekeyInventory,
  envelope: DuoEnvelope,
): Promise<AcceptedSession> {
  if (!validateEnvelope(envelope)) throw new E2eeError('Malformed envelope.');
  if (!envelope.prekey) throw new E2eeError('Not a session-initializing envelope.');
  const intro: PrekeyIntro = envelope.prekey;
  if (!(await verifyIdentityProof(intro.senderSignJwk, intro.senderDhJwk, intro.senderIdentityProof))) {
    throw new E2eeError('Sender identity proof is invalid.');
  }
  const signedPrekey = inventory.getSignedPrekey(intro.signedPrekeyId);
  if (!signedPrekey) throw new E2eeError('Referenced signed prekey is unknown.');
  const oneTimePrekey =
    intro.oneTimePrekeyId === undefined
      ? undefined
      : inventory.getOneTimePrekey(intro.oneTimePrekeyId) ?? undefined;
  const { rootKey, associatedData } = await respondX3dh({
    identity,
    peerIntro: intro,
    signedPrekey,
    ...(oneTimePrekey ? { oneTimePrekey } : {}),
  });
  const ratchet = await DoubleRatchet.initResponder(
    rootKey,
    signedPrekey.key,
    intro.ephemeralDhJwk,
  );
  const payload = await ratchet.decrypt(envelope.header, envelope.body, associatedData, envelope.ctx);
  return {
    session: {
      contact: {
        signJwk: intro.senderSignJwk,
        dhJwk: intro.senderDhJwk,
        identityProof: intro.senderIdentityProof,
      },
      associatedData,
      ratchet,
    },
    payload,
    consumed: {
      signedPrekeyId: intro.signedPrekeyId,
      ...(intro.oneTimePrekeyId !== undefined ? { oneTimePrekeyId: intro.oneTimePrekeyId } : {}),
    },
  };
}

/** Encrypt the next outgoing message of an established session. */
export async function encryptToEnvelope(
  session: DuoSession,
  ctx: string,
  payload: Uint8Array,
): Promise<DuoEnvelope> {
  const { header, body } = await session.ratchet.encrypt(payload, session.associatedData, ctx);
  return {
    v: ENVELOPE_VERSION,
    kind: 'dr1',
    id: await envelopeDigest({ kind: 'dr1', ctx, header, body }),
    ctx,
    header,
    body,
  };
}

/**
 * Decrypt a follow-up envelope of an established session. Callers must dedup
 * by `id` before calling: presenting the same envelope twice is a replay. The
 * ratchet additionally rejects any position that has been consumed, and
 * rejects tampered bodies via AES-GCM authentication.
 */
export async function decryptEnvelope(
  session: DuoSession,
  envelope: DuoEnvelope,
): Promise<Uint8Array> {
  if (!validateEnvelope(envelope)) throw new E2eeError('Malformed envelope.');
  if (envelope.prekey) {
    throw new E2eeError('Prekey envelope belongs to a new session; accept it there.');
  }
  return session.ratchet.decrypt(
    envelope.header,
    envelope.body,
    session.associatedData,
    envelope.ctx,
  );
}
