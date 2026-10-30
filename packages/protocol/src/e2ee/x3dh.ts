/**
 * X3DH (Extended Triple Diffie-Hellman) key agreement, following the Signal
 * protocol specification ("The X3DH Key Agreement Protocol", sections 3-4),
 * adapted to NIST P-256 because the implementation relies on WebCrypto and
 * platform keystores that natively support P-256 only.
 *
 * Identity model (documented deviation, see docs/E2EE_PROTOCOL.md §Identity):
 * WebCrypto does not allow a single key pair to both sign and agree, so an
 * identity is a *pair* of keys: an ECDSA signing key (binds the bundle, is
 * cross-checkable via QR / safety number) and an ECDH identity key (used in the
 * DH chain). The ECDH identity public key is bound to the signing key by a
 * self-signature created at identity creation time.
 *
 * Shared secret construction (as in the spec, with F = 32×0xFF):
 *   DH1 = DH(IKa, SPKb)  DH2 = DH(EKa, IKb)  DH3 = DH(EKa, SPKb)
 *   DH4 = DH(EKa, OPKb)  (when a one-time prekey is present)
 *   SK     = HKDF(F || DH1 || DH2 || DH3 || [DH4], salt = 0, info = "DuoChat-X3DH-v1")
 *   AD     = SHA-256(TH(IKa) || 0x0A || TH(IKb))   (identity-key-bound associated data)
 *
 * The response-side orientation (Bob's private keys on the left) yields the
 * same shared bytes because DH is commutative:
 *   DH1' = DH(SPKb, IKa)  DH2' = DH(IKb, EKa)  DH3' = DH(SPKb, EKa)  DH4' = DH(OPKb, EKa)
 */

import {
  E2eeError,
  canonicalJson,
  concatBytes,
  createEcdhKeypair,
  createEcdsaKeypair,
  ecdhAgree,
  ecdsaSign,
  ecdsaVerify,
  fromB64Url,
  hkdf,
  sha256,
  toB64Url,
  validatePublicJwk,
  type EcdhKeypair,
  type EcdsaKeypair,
  type PrivateJwk,
  type PublicJwk,
} from './primitives';

export const X3DH_INFO = 'DuoChat-X3DH-v1';
export const IDENTITY_PROOF_PREFIX = 'duochat-identity-proof-v1\n';
export const SIGNED_PREKEY_PREFIX = 'duochat-signed-prekey-v1\n';
export const BUNDLE_VERSION = 1 as const;

/* ------------------------------------------------------------------ */
/* Canonical public-key text                                           */
/* ------------------------------------------------------------------ */

/** Canonical subset of a JWK used in signatures, proofs, and fingerprints. */
export function thumbJwk(jwk: PublicJwk): {
  kty: string;
  crv: string;
  x: string;
  y: string;
} {
  if (!validatePublicJwk(jwk)) throw new E2eeError('Malformed public key.');
  return { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! };
}

export function identityFingerprintHex(identityDhPublic: PublicJwk): Promise<string> {
  const t = thumbJwk(identityDhPublic);
  return sha256(
    concatBytes(
      new TextEncoder().encode(`${t.kty}|${t.crv}|`),
      fromB64Url(t.x),
      new TextEncoder().encode('|'),
      fromB64Url(t.y),
    ),
  ).then((bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
}

function concatThumb(a: PublicJwk, b: PublicJwk): Uint8Array {
  return concatBytes(
    new TextEncoder().encode(`${JSON.stringify(thumbJwk(a))}\n${JSON.stringify(thumbJwk(b))}`),
  );
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export interface IdentityKeyPair {
  /** ECDSA P-256 — signs the bundle and prekeys. */
  signKey: EcdsaKeypair;
  /** ECDH P-256 — participates in all DH calculations. */
  dhKey: EcdhKeypair;
  /** base64url signature binding the ECDH identity key to the signing key. */
  identityProof: string;
}

function identityProofPayload(dhPublic: PublicJwk): Uint8Array {
  return new TextEncoder().encode(IDENTITY_PROOF_PREFIX + canonicalJson(thumbJwk(dhPublic)));
}

export async function createIdentity(): Promise<IdentityKeyPair> {
  const signKey = await createEcdsaKeypair();
  const dhKey = await createEcdhKeypair();
  const identityProof = toB64Url(
    await ecdsaSign(signKey.privJwk, identityProofPayload(dhKey.pubJwk)),
  );
  return { signKey, dhKey, identityProof };
}

export async function verifyIdentityProof(
  signJwk: PublicJwk,
  dhJwk: PublicJwk,
  identityProofB64: string,
): Promise<boolean> {
  return ecdsaVerify(
    signJwk,
    fromB64Url(identityProofB64),
    identityProofPayload(dhJwk),
  );
}

/**
 * Bind an ECDH identity key to an ECDSA signing key with a self-signature.
 * Used by generated identities and by deterministic recovery-derived keys alike.
 */
export async function createIdentityProof(
  signPrivateKey: PrivateJwk,
  dhPublic: PublicJwk,
): Promise<string> {
  return toB64Url(await ecdsaSign(signPrivateKey, identityProofPayload(dhPublic)));
}

/* ------------------------------------------------------------------ */
/* Prekeys and bundles                                                 */
/* ------------------------------------------------------------------ */

export interface SignedPrekey {
  id: number;
  key: EcdhKeypair;
  /** base64url ECDSA signature created by the identity signing key. */
  signature: string;
  createdAt: number;
}

export interface OneTimePrekey {
  id: number;
  key: EcdhKeypair;
}

export interface PrekeyBundle {
  version: typeof BUNDLE_VERSION;
  identity: {
    signJwk: PublicJwk;
    dhJwk: PublicJwk;
    identityProof: string;
  };
  signedPrekey: {
    id: number;
    dhJwk: PublicJwk;
    signature: string;
    createdAt: number;
  };
  oneTimePrekey?: {
    id: number;
    dhJwk: PublicJwk;
  };
}

function signedPrekeyPayload(dhPublic: PublicJwk): Uint8Array {
  return new TextEncoder().encode(SIGNED_PREKEY_PREFIX + canonicalJson(thumbJwk(dhPublic)));
}

export async function createSignedPrekey(
  identity: IdentityKeyPair,
  id: number,
  now = Date.now(),
): Promise<SignedPrekey> {
  if (!Number.isInteger(id) || id <= 0) {
    throw new E2eeError('Prekey id must be a positive integer.');
  }
  const key = await createEcdhKeypair();
  const signature = toB64Url(
    await ecdsaSign(identity.signKey.privJwk, signedPrekeyPayload(key.pubJwk)),
  );
  return { id, key, signature, createdAt: now };
}

export async function createOneTimePrekey(id: number): Promise<OneTimePrekey> {
  if (!Number.isInteger(id) || id <= 0) {
    throw new E2eeError('Prekey id must be a positive integer.');
  }
  return { id, key: await createEcdhKeypair() };
}

export function createBundle(
  identity: IdentityKeyPair,
  signedPrekey: SignedPrekey,
  oneTimePrekey?: OneTimePrekey,
): PrekeyBundle {
  return {
    version: BUNDLE_VERSION,
    identity: {
      signJwk: identity.signKey.pubJwk,
      dhJwk: identity.dhKey.pubJwk,
      identityProof: identity.identityProof,
    },
    signedPrekey: {
      id: signedPrekey.id,
      dhJwk: signedPrekey.key.pubJwk,
      signature: signedPrekey.signature,
      createdAt: signedPrekey.createdAt,
    },
    ...(oneTimePrekey
      ? { oneTimePrekey: { id: oneTimePrekey.id, dhJwk: oneTimePrekey.key.pubJwk } }
      : {}),
  };
}

export interface BundleValidation {
  ok: boolean;
  error?: string;
}

/**
 * Full structural + cryptographic validation of a fetched prekey bundle.
 * Callers must not trust a bundle that failed this check for anything.
 */
export async function validateBundle(bundle: unknown): Promise<BundleValidation> {
  if (typeof bundle !== 'object' || bundle === null) {
    return { ok: false, error: 'Malformed bundle.' };
  }
  const b = bundle as PrekeyBundle;
  if (b.version !== BUNDLE_VERSION) return { ok: false, error: 'Unsupported bundle version.' };
  if (!b.identity || !validatePublicJwk(b.identity.signJwk) || !validatePublicJwk(b.identity.dhJwk)) {
    return { ok: false, error: 'Bundle identity keys are malformed.' };
  }
  if (typeof b.identity.identityProof !== 'string' || b.identity.identityProof.length === 0) {
    return { ok: false, error: 'Bundle identity proof missing.' };
  }
  const spk = b.signedPrekey;
  if (!spk || !Number.isInteger(spk.id) || !validatePublicJwk(spk.dhJwk)) {
    return { ok: false, error: 'Signed prekey is malformed.' };
  }
  if (typeof spk.signature !== 'string' || !Number.isFinite(spk.createdAt)) {
    return { ok: false, error: 'Signed prekey signature missing.' };
  }
  if (b.oneTimePrekey !== undefined) {
    const opk = b.oneTimePrekey;
    if (!opk || !Number.isInteger(opk.id) || !validatePublicJwk(opk.dhJwk)) {
      return { ok: false, error: 'One-time prekey is malformed.' };
    }
  }
  if (!(await verifyIdentityProof(b.identity.signJwk, b.identity.dhJwk, b.identity.identityProof))) {
    return { ok: false, error: 'Identity proof is invalid.' };
  }
  const spkOk = await ecdsaVerify(
    b.identity.signJwk,
    fromB64Url(spk.signature),
    signedPrekeyPayload(spk.dhJwk),
  );
  if (!spkOk) return { ok: false, error: 'Signed prekey signature is invalid.' };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Agreement                                                           */
/* ------------------------------------------------------------------ */

const F_PREFIX = new Uint8Array(32).fill(0xff);

export interface X3dhResult {
  /** 32-byte initial root key for the Double Ratchet. */
  rootKey: Uint8Array;
  /** 32-byte associated data bound to both identity ECDH keys. */
  associatedData: Uint8Array;
}

async function computeSharedSecret(dhOutputs: Uint8Array[]): Promise<{
  rootKey: Uint8Array;
}> {
  const ikm = concatBytes(F_PREFIX, ...dhOutputs);
  return {
    rootKey: await hkdf(ikm, new Uint8Array(32), new TextEncoder().encode(X3DH_INFO), 32),
  };
}

export interface X3dhInitiation extends X3dhResult {
  /** Ephemeral keypair; its public half must reach the responder. */
  ephemeral: EcdhKeypair;
  usedSignedPrekeyId: number;
  usedOneTimePrekeyId?: number;
}

/**
 * Initiator (Alice): verify and consume a prekey bundle.
 * The bundle is re-validated here; never initiate against an unvalidated bundle.
 */
export async function initiateX3dh(
  identity: IdentityKeyPair,
  bundle: PrekeyBundle,
): Promise<X3dhInitiation> {
  const validation = await validateBundle(bundle);
  if (!validation.ok) {
    throw new E2eeError(`Prekey bundle rejected: ${validation.error}`);
  }
  const ephemeral = await createEcdhKeypair();
  const dh1 = await ecdhAgree(identity.dhKey.privJwk, bundle.signedPrekey.dhJwk);
  const dh2 = await ecdhAgree(ephemeral.privJwk, bundle.identity.dhJwk);
  const dh3 = await ecdhAgree(ephemeral.privJwk, bundle.signedPrekey.dhJwk);
  const dhOutputs: Uint8Array[] = [dh1, dh2, dh3];
  let usedOneTimePrekeyId: number | undefined;
  if (bundle.oneTimePrekey) {
    dhOutputs.push(await ecdhAgree(ephemeral.privJwk, bundle.oneTimePrekey.dhJwk));
    usedOneTimePrekeyId = bundle.oneTimePrekey.id;
  }
  const { rootKey } = await computeSharedSecret(dhOutputs);
  return {
    rootKey,
    // Spec-faithful associated data: a public digest of both identity keys,
    // computed identically on both sides (initiator's key first).
    associatedData: await sha256(concatThumb(identity.dhKey.pubJwk, bundle.identity.dhJwk)),
    ephemeral,
    usedSignedPrekeyId: bundle.signedPrekey.id,
    ...(usedOneTimePrekeyId !== undefined ? { usedOneTimePrekeyId } : {}),
  };
}

/**
 * Intro header carried inside the first envelope of a session. The responder
 * needs it to re-derive the identical shared secret.
 */
export interface PrekeyIntro {
  senderSignJwk: PublicJwk;
  senderDhJwk: PublicJwk;
  senderIdentityProof: string;
  ephemeralDhJwk: PublicJwk;
  signedPrekeyId: number;
  oneTimePrekeyId?: number;
}

export function createPrekeyIntro(
  identity: IdentityKeyPair,
  initiation: X3dhInitiation,
): PrekeyIntro {
  return {
    senderSignJwk: identity.signKey.pubJwk,
    senderDhJwk: identity.dhKey.pubJwk,
    senderIdentityProof: identity.identityProof,
    ephemeralDhJwk: initiation.ephemeral.pubJwk,
    signedPrekeyId: initiation.usedSignedPrekeyId,
    ...(initiation.usedOneTimePrekeyId !== undefined
      ? { oneTimePrekeyId: initiation.usedOneTimePrekeyId }
      : {}),
  };
}

export interface ResponderInput {
  identity: IdentityKeyPair;
  peerIntro: PrekeyIntro;
  signedPrekey: SignedPrekey;
  oneTimePrekey?: OneTimePrekey;
}

/**
 * Responder (Bob): re-derive the initiator's shared secret from an intro and
 * the loaded prekeys that match the intro's ids.
 */
export async function respondX3dh(input: ResponderInput): Promise<X3dhResult> {
  const intro = input.peerIntro;
  if (
    !validatePublicJwk(intro.senderDhJwk) ||
    !validatePublicJwk(intro.ephemeralDhJwk) ||
    !validatePublicJwk(intro.senderSignJwk)
  ) {
    throw new E2eeError('Intro carries malformed keys.');
  }
  if (input.signedPrekey.id !== intro.signedPrekeyId) {
    throw new E2eeError('Intro points at an unknown signed prekey.');
  }
  if (
    input.oneTimePrekey &&
    intro.oneTimePrekeyId !== undefined &&
    input.oneTimePrekey.id !== intro.oneTimePrekeyId
  ) {
    throw new E2eeError('Intro points at an unknown one-time prekey.');
  }
  // Response-side orientation mirrors the initiator's DH1..4 in reverse:
  //   DH1' = DH(SPKb, IKa)  DH2' = DH(IKb, EKa)  DH3' = DH(SPKb, EKa)  DH4' = DH(OPKb, EKa)
  const dh1 = await ecdhAgree(input.signedPrekey.key.privJwk, intro.senderDhJwk);
  const dh2 = await ecdhAgree(input.identity.dhKey.privJwk, intro.ephemeralDhJwk);
  const dh3 = await ecdhAgree(input.signedPrekey.key.privJwk, intro.ephemeralDhJwk);
  const dhOutputs: Uint8Array[] = [dh1, dh2, dh3];
  if (input.oneTimePrekey && intro.oneTimePrekeyId !== undefined) {
    dhOutputs.push(await ecdhAgree(input.oneTimePrekey.key.privJwk, intro.ephemeralDhJwk));
  }
  const { rootKey } = await computeSharedSecret(dhOutputs);
  return {
    rootKey,
    // Same value the initiator computed: SHA-256(TH(IKa) || "\n" || TH(IKb)),
    // with the initiator's identity key first.
    associatedData: await sha256(concatThumb(intro.senderDhJwk, input.identity.dhKey.pubJwk)),
  };
}
