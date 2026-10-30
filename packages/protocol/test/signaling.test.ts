import { describe, expect, it } from 'vitest';
import {
  createManualSignal,
  decodeManualSignal,
  deriveSafetyNumber,
  encodeManualSignal,
  isValidPublicJwk,
} from '../src';

const keyA = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
};

const keyB = {
  kty: 'EC',
  crv: 'P-256',
  x: 'kWjZ1FQZ8m8pQ8vJ0m8pQ8vJ0m8pQ8vJ0m8pQ8vJ0m8',
  y: 'Q8vJ0m8pQ8vJ0m8pQ8vJ0m8pQ8vJ0m8pQ8vJ0m8pQ8',
};

function offer() {
  return createManualSignal({
    kind: 'offer',
    conversationId: 'duo',
    fromUid: 'a',
    fromDeviceId: 'device-a',
    publicKeyJwk: keyA,
    dhJwk: keyB,
    identityProof: 'p'.repeat(64),
    sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n',
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: 123,
  });
}

describe('manual signaling', () => {
  it('round-trips a connection code', () => {
    const encoded = encodeManualSignal(offer());
    const decoded = decodeManualSignal(encoded, 'duo');
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.fromUid).toBe('a');
      expect(decoded.value.sdp).toContain('v=0');
    }
  });

  it('rejects wrong conversations, prefixes, tampering, and oversized input', () => {
    expect(decodeManualSignal('hello', 'duo').ok).toBe(false);
    expect(decodeManualSignal(encodeManualSignal(offer()), 'other').ok).toBe(false);
    expect(decodeManualSignal(`DUO1:${'a'.repeat(70000)}`, 'duo').ok).toBe(false);
    const encoded = encodeManualSignal(offer());
    const corrupted = `${encoded.slice(0, -8)}AAAAAAAA`;
    expect(decodeManualSignal(corrupted, 'duo').ok).toBe(false);
  });

  it('requires a P-256 public key', () => {
    expect(isValidPublicJwk(keyA)).toBe(true);
    expect(isValidPublicJwk({ kty: 'RSA' })).toBe(false);
  });

  it('generates a deterministic, symmetric safety number', async () => {
    const ab = await deriveSafetyNumber(keyA, keyB);
    const ba = await deriveSafetyNumber(keyB, keyA);
    expect(ab).toBe(ba);
    expect(ab).toMatch(/^\d{5}( \d{5}){5}$/);
    expect(ab).not.toBe(await deriveSafetyNumber(keyA, keyA));
  });
});
