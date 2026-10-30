import { describe, expect, it } from 'vitest';
import {
  bytesToScalar,
  publicPointFromScalar,
  P256_ORDER,
  ScalarP256Error,
  scalarToBytes,
} from '../src/recovery/nistP256';
import { createEcdhKeypair, fromB64Url, randomBytes, toB64Url } from '../src/e2ee/primitives';
import {
  createBundle,
  createSignedPrekey,
  createOneTimePrekey,
  initiateSession,
  acceptInitialEnvelope,
  encryptToEnvelope,
  decryptEnvelope,
  verifyIdentityProof,
  type PrekeyInventory,
} from '../src/e2ee';
import {
  REQUIRED_WORDS,
  deriveIdentityFromPhrase,
  deriveKeyMaterial,
  deriveSeed,
  generateRecoveryPhrase,
  validateRecoveryPhrase,
} from '../src/recovery/identity';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const enc = (t: string) => new TextEncoder().encode(t);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/* --------------------------- curve math --------------------------- */

describe('P-256 scalar→point derivation', () => {
  // Generator point from NIST SP 800-186 §G.1.2 (independently confirmed;
  // the WebCrypto cross-check below validates the whole implementation).
  const GX_HEX = '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296';
  const GY_HEX = '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';

  it('maps scalar 1 to the curve generator', () => {
    const one = new Uint8Array(32);
    one[31] = 1;
    const point = publicPointFromScalar(one);
    expect(hex(point.x)).toBe(GX_HEX);
    expect(hex(point.y)).toBe(GY_HEX);
  });

  it('matches the WebCrypto implementation for random generated keys', async () => {
    // Ground truth: WebCrypto computes (x, y) = d·G by the same operation.
    for (let i = 0; i < 10; i += 1) {
      const pair = await createEcdhKeypair();
      const d = fromB64Url(pair.privJwk.d as string);
      const mine = publicPointFromScalar(d);
      expect(toB64Url(mine.x)).toBe(pair.pubJwk.x);
      expect(toB64Url(mine.y)).toBe(pair.pubJwk.y);
    }
  });

  it('handles the largest valid scalar and rejects out-of-range ones', () => {
    // d = n - 1 → the negation of the generator: y = p - Gy.
    const maxScalar = scalarToBytes(P256_ORDER - 1n);
    const minusG = publicPointFromScalar(maxScalar);
    expect(hex(minusG.x)).toBe(GX_HEX);
    expect(hex(minusG.y)).not.toBe(GY_HEX);

    expect(() => publicPointFromScalar(new Uint8Array(32))).toThrow(ScalarP256Error);
    expect(() => publicPointFromScalar(scalarToBytes(P256_ORDER))).toThrow(ScalarP256Error);
    expect(() => publicPointFromScalar(new Uint8Array(31))).toThrow(ScalarP256Error);
  });

  it('round-trips scalars through the byte encoding', () => {
    const bytes = randomBytes(32);
    expect(hex(scalarToBytes(bytesToScalar(bytes)))).toBe(hex(bytes));
  });
});

/* --------------------------- mnemonics ----------------------------- */

describe('12-word recovery phrase', () => {
  it('generates exactly 12 valid words', () => {
    for (let i = 0; i < 5; i += 1) {
      const phrase = generateRecoveryPhrase();
      const words = phrase.split(' ');
      expect(words.length).toBe(REQUIRED_WORDS);
      expect(validateRecoveryPhrase(phrase).ok).toBe(true);
    }
  });

  it('high entropy: two generated phrases differ', () => {
    expect(generateRecoveryPhrase()).not.toBe(generateRecoveryPhrase());
  });

  it('rejects wrong word count', () => {
    const phrase = generateRecoveryPhrase();
    const words = phrase.split(' ');
    expect(validateRecoveryPhrase(words.slice(0, 11).join(' ')).ok).toBe(false);
    expect(
      validateRecoveryPhrase(words.concat([words[0]!]).join(' ')).ok,
    ).toBe(false);
  });

  it('rejects non-wordlist words', () => {
    const words = generateRecoveryPhrase().split(' ');
    words[3] = 'notaword';
    const result = validateRecoveryPhrase(words.join(' '));
    expect(result.ok).toBe(false);
  });

  it('rejects words in the wrong order (checksum breaks)', () => {
    const words = generateRecoveryPhrase().split(' ');
    // A single swap can collide with the checksum by chance, so try every adjacent swap.
    const results = words.slice(0, -1).map((_, i) => {
      const swapped = words.slice();
      [swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
      return validateRecoveryPhrase(swapped.join(' ')).ok;
    });
    expect(results.filter((ok) => !ok).length).toBeGreaterThan(0);
  });

  it('rejects empty input', () => {
    expect(validateRecoveryPhrase('').ok).toBe(false);
    expect(validateRecoveryPhrase('   ').ok).toBe(false);
  });
});

/* -------------------------- derivation ----------------------------- */

describe('identity derivation', () => {
  it('derives independent key material per purpose (domain separation)', async () => {
    const phrase = generateRecoveryPhrase();
    const seed = await deriveSeed(phrase);
    const sign = await deriveKeyMaterial(seed, 'identity-sign');
    const agreement = await deriveKeyMaterial(seed, 'identity-agreement');
    expect(hex(sign)).not.toBe(hex(agreement));
    // Same input → same output (deterministic).
    const seed2 = await deriveSeed(phrase);
    expect(hex(await deriveKeyMaterial(seed2, 'identity-sign'))).toBe(hex(sign));
  });

  it('restores byte-identical identities across platforms/invocations', async () => {
    const phrase = generateRecoveryPhrase();
    const a = await deriveIdentityFromPhrase(phrase);
    const b = await deriveIdentityFromPhrase(phrase);
    expect(a.identity.dhKey.privJwk.d).toBe(b.identity.dhKey.privJwk.d);
    expect(a.identity.dhKey.pubJwk.x).toBe(b.identity.dhKey.pubJwk.x);
    expect(a.identity.signKey.privJwk.d).toBe(b.identity.signKey.privJwk.d);
    // ECDSA signatures are randomized, so raw proof bytes differ; both proofs
    // must be valid self-signatures binding the same key pair.
    expect(
      await verifyIdentityProof(a.identity.signKey.pubJwk, a.identity.dhKey.pubJwk, b.identity.identityProof),
    ).toBe(true);
    expect(
      await verifyIdentityProof(b.identity.signKey.pubJwk, b.identity.dhKey.pubJwk, a.identity.identityProof),
    ).toBe(true);
    expect(a.identityFingerprint).toBe(b.identityFingerprint);
  });

  it('different phrases derive different identities', async () => {
    const a = await deriveIdentityFromPhrase(generateRecoveryPhrase());
    const b = await deriveIdentityFromPhrase(generateRecoveryPhrase());
    expect(a.identity.dhKey.pubJwk.x).not.toBe(b.identity.dhKey.pubJwk.x);
  });

  it('an optional BIP-39 passphrase must not silently agree with no passphrase', async () => {
    const phrase = generateRecoveryPhrase();
    const without = await deriveIdentityFromPhrase(phrase);
    const withPassphrase = await deriveIdentityFromPhrase(phrase, 'hidden pepper');
    expect(without.identity.dhKey.pubJwk.x).not.toBe(withPassphrase.identity.dhKey.pubJwk.x);
    // The same passphrase restores the same identity.
    const again = await deriveIdentityFromPhrase(phrase, 'hidden pepper');
    expect(again.identity.dhKey.privJwk.d).toBe(withPassphrase.identity.dhKey.privJwk.d);
  });

  it('never leaks the mnemonic into the derived material', async () => {
    const phrase = generateRecoveryPhrase();
    const words = phrase.split(' ');
    const derived = await deriveIdentityFromPhrase(phrase);
    const serialized = JSON.stringify(derived);
    for (const word of words) {
      expect(serialized.includes(word)).toBe(false);
    }
  });

  it('rejects invalid phrases before deriving anything', async () => {
    await expect(deriveIdentityFromPhrase('not a phrase at all')).rejects.toThrow();
    await expect(deriveIdentityFromPhrase(generateRecoveryPhrase().split(' ').slice(0, 11).join(' '))).rejects.toThrow();
  });
});

/* ------------- integration with the E2EE architecture -------------- */

describe('recovered identity interoperates with E2EE sessions', () => {
  it('a restored identity runs the same X3DH + Double Ratchet sessions', async () => {
    // "Old phone": phrase created an identity once.
    const phrase = generateRecoveryPhrase();
    const original = await deriveIdentityFromPhrase(phrase);
    // "New phone": same phrase restores the identical identity.
    const restored = await deriveIdentityFromPhrase(phrase);
    expect(restored.identity.dhKey.privJwk.d).toBe(original.identity.dhKey.privJwk.d);

    // A peer exposes a prekey bundle.
    const bob = await (async () => {
      const identity = await deriveIdentityFromPhrase(generateRecoveryPhrase());
      const signedPrekey = await createSignedPrekey(identity.identity, 1);
      const oneTimePrekey = await createOneTimePrekey(101);
      const inventory: PrekeyInventory = {
        getSignedPrekey: (id) => (id === signedPrekey.id ? signedPrekey : null),
        getOneTimePrekey: (id) => (oneTimePrekey && id === oneTimePrekey.id ? oneTimePrekey : null),
      };
      return {
        identity: identity.identity,
        inventory,
        bundle: createBundle(identity.identity, signedPrekey, oneTimePrekey),
      };
    })();

    for (const side of [original, restored]) {
      const start = await initiateSession(side.identity, bob.bundle, 'msg-intro', enc('restored hello'));
      const accepted = await acceptInitialEnvelope(bob.identity, bob.inventory, start.envelope);
      expect(dec(accepted.payload)).toBe('restored hello');
      const reply = await encryptToEnvelope(accepted.session, 'msg-back', enc('welcome back'));
      expect(dec(await decryptEnvelope(start.session, reply))).toBe('welcome back');
    }
  });
});
