import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NETWORK_CONFIG,
  classifyPath,
  decodeBlob,
  decodeContactCard,
  deriveIdentityFromPhrase,
  encodeBlob,
  encodeContactCard,
  generateRecoveryPhrase,
  iceServersFor,
  mailboxFor,
  open,
  parseNetworkConfig,
  seal,
  selectedPairFromStats,
  uidFromDh,
} from '../src';

async function person() {
  const phrase = generateRecoveryPhrase();
  const { identity } = await deriveIdentityFromPhrase(phrase);
  const uid = await uidFromDh(identity.dhKey.pubJwk);
  const card = {
    v: 1 as const,
    sign: identity.signKey.pubJwk,
    dh: identity.dhKey.pubJwk,
    proof: identity.identityProof,
  };
  return { phrase, identity, uid, card };
}

describe('contact cards', () => {
  it('round-trips and yields the same uid on both sides', async () => {
    const a = await person();
    const decoded = await decodeContactCard(encodeContactCard({ ...a.card, name: 'Ann' }));
    expect(decoded?.uid).toBe(a.uid);
    expect(decoded?.card.name).toBe('Ann');
  });

  it('the same phrase always gives the same uid (recovery)', async () => {
    const a = await person();
    const again = await deriveIdentityFromPhrase(a.phrase);
    expect(await uidFromDh(again.identity.dhKey.pubJwk)).toBe(a.uid);
  });

  it('rejects a card whose keys were swapped for another identity', async () => {
    const a = await person();
    const b = await person();
    const forged = encodeContactCard({ ...a.card, dh: b.card.dh });
    expect(await decodeContactCard(forged)).toBeNull();
    expect(await decodeContactCard('DUOID1:not-base64!!')).toBeNull();
    expect(await decodeContactCard('hello')).toBeNull();
  });
});

describe('sealed blobs', () => {
  async function pair() {
    const a = await person();
    const b = await person();
    return { a, b };
  }

  it('delivers a payload only the recipient can read, signed by the sender', async () => {
    const { a, b } = await pair();
    const blob = await seal({
      payload: { t: 'msg', text: 'hi' },
      fromUid: a.uid,
      toUid: b.uid,
      toDh: b.card.dh,
      signPriv: a.identity.signKey.privJwk,
    });
    const wire = decodeBlob(encodeBlob(blob));
    expect(wire).not.toBeNull();
    expect(JSON.stringify(wire)).not.toContain('hi');
    const opened = await open({
      blob: wire!,
      ownUid: b.uid,
      ownDhPriv: b.identity.dhKey.privJwk,
      senderSign: a.card.sign,
      senderUid: a.uid,
    });
    expect(opened).toEqual({ t: 'msg', text: 'hi' });
  });

  it('drops blobs for someone else, from someone else, or tampered', async () => {
    const { a, b } = await pair();
    const c = await person();
    const blob = await seal({
      payload: { t: 'offer' },
      fromUid: a.uid,
      toUid: b.uid,
      toDh: b.card.dh,
      signPriv: a.identity.signKey.privJwk,
    });
    const base = { ownUid: b.uid, ownDhPriv: b.identity.dhKey.privJwk, senderSign: a.card.sign, senderUid: a.uid };
    expect(await open({ ...base, blob })).not.toBeNull();
    // wrong recipient
    expect(await open({ ...base, ownUid: c.uid, ownDhPriv: c.identity.dhKey.privJwk, blob })).toBeNull();
    // impostor signs as a
    const forged = await seal({
      payload: { t: 'offer' },
      fromUid: a.uid,
      toUid: b.uid,
      toDh: b.card.dh,
      signPriv: c.identity.signKey.privJwk,
    });
    expect(await open({ ...base, blob: forged })).toBeNull();
    // flipped ciphertext
    const flipped = { ...blob, ct: blob.ct.slice(0, -2) + (blob.ct.endsWith('AA') ? 'BB' : 'AA') };
    expect(await open({ ...base, blob: flipped })).toBeNull();
    // header rewritten to another sender uid
    expect(await open({ ...base, blob: { ...blob, from: c.uid } })).toBeNull();
  });

  it('derives a stable mailbox that does not contain the uid', async () => {
    const a = await person();
    const m = await mailboxFor(a.uid);
    expect(m).toMatch(/^[0-9a-f]{64}$/);
    expect(m).not.toContain(a.uid.slice(0, 16));
    expect(await mailboxFor(a.uid)).toBe(m);
  });
});

describe('network config', () => {
  it('defaults to public STUN and Nostr signaling, no TURN, no store-and-forward', () => {
    const c = parseNetworkConfig(null);
    expect(c).toEqual(DEFAULT_NETWORK_CONFIG);
    expect(c.turn).toEqual([]);
    expect(c.storeForward).toBe(false);
  });

  it('keeps valid entries and drops bad ones', () => {
    const c = parseNetworkConfig(
      JSON.stringify({
        stun: ['stun:a.example:3478', 'http://nope', ''],
        turn: [
          { urls: ['turn:t.example:3478'], username: 'u', credential: 'p' },
          { urls: ['stun:wrong'], username: 'u', credential: 'p' },
        ],
        signaling: [
          { kind: 'relay', url: 'wss://r.example' },
          { kind: 'relay', url: 'https://not-ws' },
          { kind: 'nostr', relays: ['wss://n.example', 'x'] },
        ],
        storeForward: true,
        forceRelay: true,
      }),
    );
    expect(c.stun).toEqual(['stun:a.example:3478']);
    expect(c.turn).toHaveLength(1);
    expect(c.signaling).toEqual([
      { kind: 'relay', url: 'wss://r.example' },
      { kind: 'nostr', relays: ['wss://n.example'] },
    ]);
    expect(c.storeForward && c.forceRelay).toBe(true);
    expect(iceServersFor(c)).toHaveLength(2);
  });

  it('allows turning everything off (manual codes only)', () => {
    const c = parseNetworkConfig(JSON.stringify({ stun: [], turn: [], signaling: [] }));
    expect(c.stun).toEqual([]);
    expect(c.signaling).toEqual([]);
    expect(iceServersFor(c)).toEqual([]);
  });

  it('falls back to defaults on garbage', () => {
    expect(parseNetworkConfig('{nope')).toEqual(DEFAULT_NETWORK_CONFIG);
  });
});

describe('connection path', () => {
  it('classifies from candidate types, never from config', () => {
    expect(classifyPath('host', 'host').kind).toBe('direct-lan');
    expect(classifyPath('srflx', 'host').kind).toBe('direct-nat');
    expect(classifyPath('prflx', 'srflx').kind).toBe('direct-nat');
    expect(classifyPath('relay', 'srflx').kind).toBe('relayed');
    expect(classifyPath('host', 'relay').kind).toBe('relayed');
    expect(classifyPath('unknown', 'host').kind).toBe('unknown');
  });

  it('reads the selected pair out of getStats', () => {
    const reports = [
      { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
      { id: 'P', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' },
      { id: 'L', type: 'local-candidate', candidateType: 'relay' },
      { id: 'R', type: 'remote-candidate', candidateType: 'srflx' },
      { id: 'X', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'R', remoteCandidateId: 'R' },
    ];
    expect(selectedPairFromStats({ forEach: (cb) => reports.forEach(cb) })).toEqual({ local: 'relay', remote: 'srflx' });
    const fallback = [
      { id: 'P', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R' },
      { id: 'L', type: 'local-candidate', candidateType: 'host' },
      { id: 'R', type: 'remote-candidate', candidateType: 'host' },
    ];
    expect(selectedPairFromStats({ forEach: (cb) => fallback.forEach(cb) })).toEqual({ local: 'host', remote: 'host' });
    expect(selectedPairFromStats({ forEach: () => undefined })).toBeNull();
  });
});
