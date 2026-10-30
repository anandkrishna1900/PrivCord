import { describe, expect, it } from 'vitest';
import {
  authChallenge,
  parsePeerFrame,
  publicKeysEqual,
  randomNonce,
} from '../src';

const key = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
};

describe('peer authentication', () => {
  it('builds an order-sensitive challenge', () => {
    const base = {
      conversationId: 'duo',
      uid: 'a',
      deviceId: 'd1',
      nonceSelf: '1111111111111111',
      noncePeer: '2222222222222222',
    };
    expect(authChallenge(base)).not.toBe(
      authChallenge({ ...base, nonceSelf: base.noncePeer, noncePeer: base.nonceSelf }),
    );
    expect(authChallenge(base)).toContain('duochat-peer-auth-v1');
  });

  it('generates distinct nonces', () => {
    expect(randomNonce()).not.toBe(randomNonce());
    expect(randomNonce()).toHaveLength(48);
  });

  it('compares public keys structurally', () => {
    expect(publicKeysEqual(key, { ...key })).toBe(true);
    expect(publicKeysEqual(key, { ...key, x: `${key.x}AA` })).toBe(false);
    expect(publicKeysEqual(null, key)).toBe(false);
  });

  it('parses valid control frames and rejects invalid ones', () => {
    expect(
      parsePeerFrame({ v: 1, kind: 'hello', uid: 'a', deviceId: 'd', publicKeyJwk: key, dhJwk: key, identityProof: 'p'.repeat(64), nonce: '1234567890abcdef' })
        ?.kind,
    ).toBe('hello');
    expect(
      parsePeerFrame({ v: 1, kind: 'hello', uid: 'a', deviceId: 'd', publicKeyJwk: key, nonce: '1234567890abcdef' }),
    ).toBeNull();
    expect(parsePeerFrame({ v: 2, kind: 'hello' })).toBeNull();
    expect(parsePeerFrame({ v: 1, kind: 'ack', messageId: 'm', state: 'BOGUS', at: 1 })).toBeNull();
    expect(parsePeerFrame({ v: 1, kind: 'ping', at: 5 })?.kind).toBe('ping');
    expect(parsePeerFrame({ v: 1, kind: 'pong', at: 5 })?.kind).toBe('pong');
    expect(parsePeerFrame({ v: 1, kind: 'ping' })).toBeNull();
    expect(parsePeerFrame({ v: 1, kind: 'read', lastReadMessageId: 'm', at: 1 })?.kind).toBe('read');
  });
});
