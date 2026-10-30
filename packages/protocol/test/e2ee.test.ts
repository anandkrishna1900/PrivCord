import { describe, expect, it } from 'vitest';
import {
  acceptInitialEnvelope,
  associatedDataFor,
  bytesEqual,
  createBundle,
  createIdentity,
  createOneTimePrekey,
  createSignedPrekey,
  decryptEnvelope,
  E2eeError,
  encryptToEnvelope,
  envelopeDigest,
  fromB64Url,
  initiateSession,
  MAX_SKIP,
  restoreSession,
  serializeSession,
  toB64Url,
  validateBundle,
  validateEnvelope,
  type DuoEnvelope,
  type IdentityKeyPair,
  type PrekeyInventory,
} from '../src/e2ee';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Builds a complete, honest peer side: identity + signed prekey (+ one-time). */
async function createPeer(withOneTime: boolean) {
  const identity = await createIdentity();
  const signedPrekey = await createSignedPrekey(identity, 1);
  const oneTimePrekey = withOneTime ? await createOneTimePrekey(101) : null;
  const bundle = createBundle(identity, signedPrekey, oneTimePrekey ?? undefined);
  const consumePromises = new Set<string>();
  const inventory: PrekeyInventory = {
    getSignedPrekey: (id) => {
      if (id !== signedPrekey.id || consumePromises.has(`spk#${id}`)) return null;
      return signedPrekey;
    },
    getOneTimePrekey: (id) => {
      if (!oneTimePrekey || id !== oneTimePrekey.id || consumePromises.has(`otk#${id}`)) return null;
      return oneTimePrekey;
    },
  };
  // Marking consumed stands for "the host removed the prekey after use".
  const marked = { consume: consumePromises };
  return Object.assign(
    { identity, inventory, bundle, signedPrekey, oneTimePrekey, marked },
    {},
  );
}

function markConsumed(peer: { marked: { consume: Set<string> } }, consumed: { signedPrekeyId: number; oneTimePrekeyId?: number }): void {
  peer.marked.consume.add(`spk#${consumed.signedPrekeyId}`);
  if (consumed.oneTimePrekeyId !== undefined) {
    peer.marked.consume.add(`otk#${consumed.oneTimePrekeyId}`);
  }
}

const CONTEXT = 'msg-0001';

describe('primitives fast checks', () => {
  it('base64url round-trips every boundary length', () => {
    for (let size = 0; size <= 8; size += 1) {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) bytes[i] = (i * 37 + 11) & 0xff;
      const encoded = toB64Url(bytes);
      expect(bytesEqual(fromB64Url(encoded), bytes)).toBe(true);
    }
  });

  it('rejects invalid base64url characters', () => {
    expect(() => fromB64Url('a+b/')).toThrow(E2eeError);
  });
});

describe('X3DH agreement', () => {
  it('rejects a bundle whose signed prekey was tampered with', async () => {
    const peer = await createPeer(true);
    const tampered = JSON.parse(JSON.stringify(peer.bundle)) as typeof peer.bundle;
    const { y } = tampered.signedPrekey.dhJwk;
    tampered.signedPrekey.dhJwk.y = (y ?? '').slice(0, -2) + 'Q';
    const result = await validateBundle(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('prekey');
  });

  it('rejects a bundle whose identity proof was swapped', async () => {
    const a = await createPeer(false);
    const b = await createPeer(false);
    const bad = { ...a.bundle, identity: b.bundle.identity } as typeof a.bundle;
    const result = await validateBundle(bad);
    expect(result.ok).toBe(false);
  });

  it('accepts an honest bundle', async () => {
    const peer = await createPeer(true);
    const result = await validateBundle(peer.bundle);
    expect(result.ok).toBe(true);
  });
});

describe('session establishment and messaging', () => {
  it('round-trips the first message and both directions after ratcheting', async () => {
    const alice = await createIdentity();
    const bob = await createPeer(true);
    const start = await initiateSession(alice, bob.bundle, CONTEXT, enc('hello theirs'));
    expect(validateEnvelope(start.envelope)).toBe(true);

    const accepted = await acceptInitialEnvelope(bob.identity, bob.inventory, start.envelope);
    markConsumed(bob, accepted.consumed);
    expect(dec(accepted.payload)).toBe('hello theirs');

    // Contact binding: each side holds the OTHER party's verified identity.
    expect(
      bytesEqual(
        fromB64Url(start.session.contact.dhJwk.x ?? ''),
        fromB64Url(bob.bundle.identity.dhJwk.x ?? ''),
      ),
    ).toBe(true);
    expect(
      bytesEqual(
        fromB64Url(accepted.session.contact.dhJwk.x ?? ''),
        fromB64Url(alice.dhKey.pubJwk.x ?? ''),
      ),
    ).toBe(true);

    // Bob replies; Alice reads it.
    const replyEnvelopes: DuoEnvelope[] = [];
    const reply = await encryptToEnvelope(accepted.session, 'msg-0002', enc('hi there'));
    replyEnvelopes.push(reply);
    const received = await decryptEnvelope(start.session, replyEnvelopes[0]!);
    expect(dec(received)).toBe('hi there');

    // Alice ratchets again (her turn after receiving a new remote key).
    const second = await encryptToEnvelope(start.session, 'msg-0003', enc('_followup'));
    expect(dec(await decryptEnvelope(accepted.session, second))).toBe('_followup');

    // And Bob answers along the ratcheted chain.
    const secondReply = await encryptToEnvelope(accepted.session, 'msg-0004', enc('ok'));
    expect(dec(await decryptEnvelope(start.session, secondReply))).toBe('ok');
  });

  it('rejects per-message context rewriting', async () => {
    const alice = await createIdentity();
    const bob = await createPeer(false);
    const start = await initiateSession(alice, bob.bundle, CONTEXT, enc('v0'));
    const accepted = await acceptInitialEnvelope(bob.identity, bob.inventory, start.envelope);
    markConsumed(bob, accepted.consumed);
    expect(dec(accepted.payload)).toBe('v0');

    const outgoing = await encryptToEnvelope(start.session, 'msg-0002', enc('secret'));
    // Carrier rewrites ctx (e.g. reuses a message id) — must fail authentication.
    await expect(decryptEnvelope(accepted.session, { ...outgoing, ctx: 'msg-XXXX' })).rejects.toThrow(
      E2eeError,
    );
  });

  it('detects ciphertext tampering byte-by-byte', async () => {
    const alice = await createIdentity();
    const bob = await createPeer(false);
    const start = await initiateSession(alice, bob.bundle, CONTEXT, enc('integrity'));
    const accepted = await acceptInitialEnvelope(bob.identity, bob.inventory, start.envelope);
    markConsumed(bob, accepted.consumed);
    const outgoing = await encryptToEnvelope(start.session, 'msg-0002', enc('unchanged'));
    const body = outgoing.body;
    const idx = body.length - 2;
    const flipped =
      body.slice(0, idx) +
      (body[idx] === 'A' ? 'B' : 'A') +
      body.slice(idx + 1);
    await expect(
      decryptEnvelope(accepted.session, { ...outgoing, body: flipped }),
    ).rejects.toThrow(E2eeError);
  });

  it('rejects a replayed follow-up envelope and stays healthy', async () => {
    const alice = await createIdentity();
    const bob = await createPeer(false);
    const start = await initiateSession(alice, bob.bundle, CONTEXT, enc('m1'));
    const accepted = await acceptInitialEnvelope(bob.identity, bob.inventory, start.envelope);
    markConsumed(bob, accepted.consumed);

    const outgoing = await encryptToEnvelope(start.session, 'msg-0002', enc('do-not-resend'));
    expect(dec(await decryptEnvelope(accepted.session, outgoing))).toBe('do-not-resend');
    // Same envelope delivered again — a network or malicious-relay replay.
    await expect(decryptEnvelope(accepted.session, outgoing)).rejects.toThrow(E2eeError);
    // The session is still usable afterwards.
    const next = await encryptToEnvelope(start.session, 'msg-0003', enc('still-alive'));
    expect(dec(await decryptEnvelope(accepted.session, next))).toBe('still-alive');
  });

  it('handles out-of-order delivery inside one chain', async () => {
    const alice = await createIdentity();
    const bob = await createPeer(false);
    const start = await initiateSession(alice, bob.bundle, 'msg-0000', enc('intro'));
    const accepted = await acceptInitialEnvelope(bob.identity, bob.inventory, start.envelope);
    markConsumed(bob, accepted.consumed);

    const sent = [
      await encryptToEnvelope(start.session, 'msg-0001', enc('one')),
      await encryptToEnvelope(start.session, 'msg-0002', enc('two')),
      await encryptToEnvelope(start.session, 'msg-0003', enc('three')),
    ];
    // Deliver last → first → second.
    expect(dec(await decryptEnvelope(accepted.session, sent[2]!))).toBe('three');
    expect(dec(await decryptEnvelope(accepted.session, sent[0]!))).toBe('one');
    expect(dec(await decryptEnvelope(accepted.session, sent[1]!))).toBe('two');
  });

  it('establishes derivation via the same associated data on both sides', async () => {
    const alice = await createIdentity();
    const bob = await createPeer(true);
    const start = await initiateSession(alice, bob.bundle, CONTEXT, enc('ad'));
    const accepted = await acceptInitialEnvelope(bob.identity, bob.inventory, start.envelope);
    markConsumed(bob, accepted.consumed);
    const recomputedByAlice = await associatedDataFor(alice.dhKey.pubJwk, bob.identity.dhKey.pubJwk);
    expect(bytesEqual(recomputedByAlice, accepted.session.associatedData)).toBe(true);
    expect(bytesEqual(start.session.associatedData, accepted.session.associatedData)).toBe(true);
  });

  it('surfaces envelope-digest differences', async () => {
    const alice = await createIdentity();
    const bob = await createPeer(false);
    const start = await initiateSession(alice, bob.bundle, CONTEXT, enc('a'));
    const idA = await envelopeDigest(start.envelope);
    const idB = await envelopeDigest({ ...start.envelope, ctx: 'other' });
    expect(idA).not.toBe(idB);
  });
});

describe('prekey consumption discipline', () => {
  it('consumed prekeys cannot mint a second session from a replayed intro', async () => {
    const alice = await createIdentity();
    const bob = await createPeer(true);
    const start = await initiateSession(alice, bob.bundle, CONTEXT, enc('first'));
    const first = await acceptInitialEnvelope(bob.identity, bob.inventory, start.envelope);
    markConsumed(bob, first.consumed);
    await expect(
      acceptInitialEnvelope(bob.identity, bob.inventory, start.envelope),
    ).rejects.toThrow(E2eeError);
  });
});

describe('skip limits', () => {
  it('caches the full out-of-order window and decrypts late messages', async () => {
    const alice = await createIdentity();
    const bob = await createPeer(false);
    const start = await initiateSession(alice, bob.bundle, 'msg-pre', enc('intro'));
    const accepted = await acceptInitialEnvelope(bob.identity, bob.inventory, start.envelope);
    markConsumed(bob, accepted.consumed);

    // Alice sends MAX_SKIP follow-ups (the prekey intro already occupies
    // position n=0 of her sending chain, so the last lands on n=MAX_SKIP,
    // which is exactly the allowed window).
    const count = MAX_SKIP;
    const envelopes: DuoEnvelope[] = [];
    for (let i = 1; i <= count; i += 1) {
      envelopes.push(await encryptToEnvelope(start.session, `msg-${i}`, enc(`payload-${i}`)));
    }
    // Delivering the last one first skips 1000 positions — exactly the window.
    const last = envelopes[count - 1]!;
    expect(dec(await decryptEnvelope(accepted.session, last))).toBe(`payload-${count}`);
    // The earliest position is still inside the bounded cache and decrypts.
    expect(dec(await decryptEnvelope(accepted.session, envelopes[0]!))).toBe('payload-1');
  });

  it('rejects a header requiring more than MAX_SKIP skips outright', async () => {
    const alice = await createIdentity();
    const bob = await createPeer(false);
    const start = await initiateSession(alice, bob.bundle, 'msg-pre', enc('intro'));
    const accepted = await acceptInitialEnvelope(bob.identity, bob.inventory, start.envelope);
    markConsumed(bob, accepted.consumed);
    const count = MAX_SKIP + 2; // last one becomes n = MAX_SKIP + 1 (> window)
    const envelopes: DuoEnvelope[] = [];
    for (let i = 1; i <= count; i += 1) {
      envelopes.push(await encryptToEnvelope(start.session, `msg-${i}`, enc(`payload-${i}`)));
    }
    await expect(decryptEnvelope(accepted.session, envelopes[count - 1]!)).rejects.toThrow(
      E2eeError,
    );
  });
}, 20_000);

describe('persistence across restarts', () => {
  it('serializes and restores both sides mid-session', async () => {
    const alice = await createIdentity();
    const bob = await createPeer(true);
    const start = await initiateSession(alice, bob.bundle, CONTEXT, enc('initial'));
    const accepted = await acceptInitialEnvelope(bob.identity, bob.inventory, start.envelope);
    markConsumed(bob, accepted.consumed);
    expect(dec(accepted.payload)).toBe('initial');

    // Restart both sides.
    const aliceSnapshot = JSON.parse(JSON.stringify(serializeSession(start.session)));
    const bobSnapshot = JSON.parse(JSON.stringify(serializeSession(accepted.session)));
    const aliceRestored = restoreSession(aliceSnapshot);
    const bobRestored = restoreSession(bobSnapshot);

    const nextFromAlice = await encryptToEnvelope(aliceRestored, 'msg-0002', enc('post-restart'));
    expect(dec(await decryptEnvelope(bobRestored, nextFromAlice))).toBe('post-restart');
    const nextFromBob = await encryptToEnvelope(bobRestored, 'msg-0003', enc('still-secure'));
    expect(dec(await decryptEnvelope(aliceRestored, nextFromBob))).toBe('still-secure');
  });
});
