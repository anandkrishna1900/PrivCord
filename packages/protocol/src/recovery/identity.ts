/**
 * DuoChat identity recovery: a mandatory 12-word BIP-39 phrase restores the
 * same cryptographic identity on every platform.
 *
 * Design (documented in docs/IDENTITY_AND_RECOVERY.md):
 * - BIP-39, 128-bit entropy → exactly 12 words (never 24). Word handling is
 *   delegated to the maintained, audited `@scure/bip39` library — no custom
 *   mnemonic algorithm is implemented.
 * - The BIP-39 seed (PBKDF2-HMAC-SHA-512, 2048 iterations, optional
 *   passphrase) is fed into *versioned, domain-separated* HKDF-SHA-256
 *   derivations. The mnemonic (or its seed) is never used directly as a key.
 * - Independent key purposes ("identity-sign", "identity-agreement") get
 *   independent derived key material, so one key is never reused across
 *   signing and encryption.
 * - Derived scalars become P-256 EC keys via the deterministic
 *   scalar→public-point derivation in `nistP256.ts` (cross-checked against
 *   WebCrypto in tests), producing the exact same E2EE `IdentityKeyPair` shape
 *   used everywhere else in the architecture.
 * - This module never logs, persists, or transmits the mnemonic. Callers must
 *   keep the phrase in memory only until the user saves it offline.
 */

import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hkdf, E2eeError, sha256, toB64Url } from '../e2ee/primitives';
import { createIdentityProof, type IdentityKeyPair } from '../e2ee/x3dh';
import {
  publicPointFromScalar,
  bytesToScalar,
  scalarToBytes,
  P256_ORDER,
} from './nistP256';

export const RECOVERY_DERIVATION_VERSION = 1 as const;
export const REQUIRED_WORDS = 12 as const;

const DERIVE_SALT = 'DuoChat-Recovery-Trust-v1';
const DERIVE_PREFIX = 'duochat-derive-v1';

export type DerivationPurpose =
  | 'identity-sign'
  | 'identity-agreement';

/** 12-word recovery phrase generated with 128-bit masked entropy. */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 128);
}

export interface RecoveryWordValidation {
  ok: boolean;
  error?: string;
}

/** Structural + wordlist + checksum validation, without deriving anything. */
export function validateRecoveryPhrase(phrase: string): RecoveryWordValidation {
  if (typeof phrase !== 'string' || phrase.trim().length === 0) {
    return { ok: false, error: 'Enter your recovery phrase.' };
  }
  const words = phrase.trim().toLowerCase().split(/\s+/);
  if (words.length !== REQUIRED_WORDS) {
    return { ok: false, error: `A recovery phrase must be exactly ${REQUIRED_WORDS} words.` };
  }
  try {
    const valid = validateMnemonic(phrase.trim().toLowerCase(), wordlist);
    if (!valid) {
      return { ok: false, error: 'This phrase does not match the DuoChat word list or checksum.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'This phrase does not match the DuoChat word list or checksum.' };
  }
}

/**
 * BIP-39 seed for the phrase; identical across platforms for the same
 * (phrase, passphrase) pair. The optional passphrase is a BIP-39 feature whose
 * absence or presence changes the derived identity — callers must explain
 * this to the user; it is never silently required.
 */
export async function deriveSeed(
  phrase: string,
  passphrase = '',
): Promise<Uint8Array> {
  const validation = validateRecoveryPhrase(phrase);
  if (!validation.ok) throw new E2eeError(`Invalid recovery phrase: ${validation.error}`);
  const seed = await mnemonicToSeed(phrase.trim().toLowerCase(), passphrase);
  return new Uint8Array(seed);
}

/**
 * Purpose-scoped key material from the recovery seed. Identical output on
 * every platform for identical inputs; independent outputs for distinct
 * purposes (domain separation).
 */
export async function deriveKeyMaterial(
  seed: Uint8Array,
  purpose: DerivationPurpose,
): Promise<Uint8Array> {
  const info = new TextEncoder().encode(`${DERIVE_PREFIX}/${purpose}`);
  return hkdf(seed, new TextEncoder().encode(DERIVE_SALT), info, 32);
}

/** Deterministic private scalar for a purpose, clamped into the curve order. */
async function deriveScalar(
  seed: Uint8Array,
  purpose: DerivationPurpose,
): Promise<Uint8Array> {
  const material = await deriveKeyMaterial(seed, purpose);
  const scalar = bytesToScalar(material) % P256_ORDER;
  if (scalar === 0n) throw new E2eeError('Derived scalar was zero; regenerate a phrase.');
  return scalarToBytes(scalar);
}

interface ScalarPoint {
  x: Uint8Array;
  y: Uint8Array;
}

/** JWK from a derived scalar: private key `d` plus its public point x/y. */
function ecPrivateJwk(scalar: Uint8Array, point: ScalarPoint): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    d: toB64Url(scalar),
    x: toB64Url(point.x),
    y: toB64Url(point.y),
  };
}

export interface DerivedIdentity {
  /** E2EE-compatible identity keys; plug directly into session routines. */
  identity: IdentityKeyPair;
  derivationVersion: typeof RECOVERY_DERIVATION_VERSION;
  /** Display fingerprint of the restored identity (public data). */
  identityFingerprint: string;
}

/**
 * Derive the full identity from a recovery phrase. The same phrase and the
 * same optional passphrase always produce byte-identical keys on every
 * platform; nothing requires a network round-trip.
 */
export async function deriveIdentityFromPhrase(
  phrase: string,
  passphrase = '',
): Promise<DerivedIdentity> {
  const seed = await deriveSeed(phrase, passphrase);
  const signScalar = await deriveScalar(seed, 'identity-sign');
  const agreementScalar = await deriveScalar(seed, 'identity-agreement');

  const signPoint = publicPointFromScalar(signScalar);
  const dhPoint = publicPointFromScalar(agreementScalar);

  const signPrivJwk = ecPrivateJwk(signScalar, signPoint);
  const dhPrivJwk = ecPrivateJwk(agreementScalar, dhPoint);
  const dhPublic = { kty: 'EC', crv: 'P-256', x: dhPrivJwk.x, y: dhPrivJwk.y };
  const identityProof = await createIdentityProof(signPrivJwk, dhPublic);

  const identityFingerprint = await identityFingerprintHex(dhPublic);
  return {
    identity: {
      signKey: {
        pubJwk: { kty: 'EC', crv: 'P-256', x: signPrivJwk.x, y: signPrivJwk.y },
        privJwk: signPrivJwk,
      },
      dhKey: { pubJwk: dhPublic, privJwk: dhPrivJwk },
      identityProof,
    },
    derivationVersion: RECOVERY_DERIVATION_VERSION,
    identityFingerprint,
  };
}

async function identityFingerprintHex(dhPublic: JsonWebKey): Promise<string> {
  const digest = await sha256(
    new TextEncoder().encode(JSON.stringify({ kty: dhPublic.kty, crv: dhPublic.crv, x: dhPublic.x, y: dhPublic.y })),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
