/**
 * Generates docs/android-vectors.json: ground truth from the TypeScript protocol that the Android
 * (Kotlin) tests must reproduce byte for byte. Run: `npx vite-node scripts/gen-android-vectors.ts`
 * from packages/protocol. Phrases below are the public BIP-39 test vectors; never use them as real identities.
 */
import { writeFileSync } from 'node:fs';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  canonicalJson,
  deriveIdentityFromPhrase,
  deriveKeyMaterial,
  deriveSeed,
  deriveSafetyNumber,
  encodeBlob,
  encodeContactCard,
  identityFingerprintHex,
  importPublicJwk,
  mailboxFor,
  parseNetworkConfig,
  seal,
  toB64Url,
  uidFromDh,
  validateRecoveryPhrase,
} from '../src';
import { eventId, makeEvent, verifyEvent } from '../../../apps/desktop/src/lib/signaling/nostr';

const PHRASES = [
  { phrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', passphrase: '' },
  { phrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', passphrase: 'TREZOR' },
  { phrase: 'legal winner thank year wave sausage worth useful legal winner thank yellow', passphrase: '' },
  { phrase: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above', passphrase: 'pässword ✓' },
];

const hex = (b: Uint8Array) => bytesToHex(b);

async function person(phrase: string, passphrase: string) {
  const derived = await deriveIdentityFromPhrase(phrase, passphrase);
  const id = derived.identity;
  const uid = await uidFromDh(id.dhKey.pubJwk);
  return { derived, id, uid };
}

async function main() {
  const recovery = [];
  for (const { phrase, passphrase } of PHRASES) {
    const seed = await deriveSeed(phrase, passphrase);
    const { id, uid, derived } = await person(phrase, passphrase);
    recovery.push({
      phrase,
      passphrase,
      seedHex: hex(seed),
      signMaterialHex: hex(await deriveKeyMaterial(seed, 'identity-sign')),
      agreementMaterialHex: hex(await deriveKeyMaterial(seed, 'identity-agreement')),
      signPriv: id.signKey.privJwk,
      signPub: id.signKey.pubJwk,
      dhPriv: id.dhKey.privJwk,
      dhPub: id.dhKey.pubJwk,
      identityProof: id.identityProof,
      uid,
      recoveryFingerprint: derived.identityFingerprint,
    });
  }

  const entropy = [
    '00000000000000000000000000000000',
    '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
    'ffffffffffffffffffffffffffffffff',
    '0c1e24e5917779d297e14d45f14e1a1a',
  ].map((e) => ({ entropyHex: e, mnemonic: entropyToMnemonic(hexToBytes(e), wordlist) }));

  const invalidPhrases = [
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon',
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon',
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon notaword',
  ].map((p) => ({ phrase: p, valid: validateRecoveryPhrase(p).ok }));

  const ann = await person(PHRASES[0]!.phrase, '');
  const bob = await person(PHRASES[2]!.phrase, '');
  const cat = await person(PHRASES[3]!.phrase, PHRASES[3]!.passphrase);
  const cardOf = (p: Awaited<ReturnType<typeof person>>, name?: string) => ({
    v: 1 as const,
    sign: p.id.signKey.pubJwk,
    dh: p.id.dhKey.pubJwk,
    proof: p.id.identityProof,
    ...(name ? { name } : {}),
  });

  const cards = {
    ann: { uid: ann.uid, encoded: encodeContactCard(cardOf(ann, 'Ann ✓')) },
    bob: { uid: bob.uid, encoded: encodeContactCard(cardOf(bob)) },
    forged: encodeContactCard({ ...cardOf(ann), dh: bob.id.dhKey.pubJwk }),
  };

  const sealed = [];
  for (const [from, to, label, payload] of [
    [ann, bob, 'ann->bob offer', { t: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n' }],
    [bob, ann, 'bob->ann msg', { t: 'msg', id: 'm-1', text: 'héllo ✓ 😀', at: 1700000000000 }],
  ] as const) {
    const blob = await seal({ payload, fromUid: from.uid, toUid: to.uid, toDh: to.id.dhKey.pubJwk, signPriv: from.id.signKey.privJwk });
    sealed.push({
      label,
      fromUid: from.uid,
      toUid: to.uid,
      payload,
      wire: encodeBlob(blob),
      mailbox: await mailboxFor(to.uid),
    });
  }
  const flipped = sealed[0]!.wire.slice(0, -4) + (sealed[0]!.wire.endsWith('AAAA') ? 'BBBB' : 'AAAA');

  const canonical = [
    '{"b":1,"a":2}',
    '{"z":[3,2,{"y":null,"x":true}],"a":"s"}',
    '{"s":"quote\\" back\\\\ nl\\n tab\\t cr\\r bs\\b ff\\f nul\\u0000 us\\u001f del\\u007f"}',
    '{"u":"\\u00e9 \\u2028 \\u2029 😀 \\ud800 ✓"}',
    '{"k\\u00e9":1,"K":2,"a":3,"é":4}',
    '[]',
    '{}',
    '{"n":[0,-5,123456789012]}',
  ].map((json) => ({ json, expected: canonicalJson(JSON.parse(json)) }));

  const networkInputs: (string | null)[] = [
    null,
    '{nope',
    '[]',
    JSON.stringify({ stun: ['stun:a.example:3478', 'http://nope', ''], turn: [{ urls: ['turn:t.example:3478'], username: 'u', credential: 'p' }, { urls: ['stun:wrong'], username: 'u', credential: 'p' }], signaling: [{ kind: 'relay', url: 'wss://r.example' }, { kind: 'relay', url: 'https://not-ws' }, { kind: 'nostr', relays: ['wss://n.example', 'x'] }], storeForward: true, forceRelay: true, bluetooth: false }),
    JSON.stringify({ stun: [], turn: [], signaling: [] }),
    JSON.stringify({ storeForward: 'yes', bluetooth: 0 }),
    JSON.stringify({ turn: [{ urls: ['turns:t.example:5349', 'turn:t2.example'], username: 'u', credential: 'p' }], signaling: [{ kind: 'nostr', relays: [] }] }),
  ];
  const network = networkInputs.map((raw) => ({ raw, expected: parseNetworkConfig(raw) }));

  // Nostr / BIP-340. Aux randomness is fixed so the TypeScript signature is reproducible.
  const sk = hexToBytes('b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef');
  const base = {
    pubkey: hex(schnorr.getPublicKey(sk)),
    created_at: 1_700_000_000,
    kind: 21733,
    tags: [['t', 'mailbox-x'], ['d', 'fixed-d'], ['expiration', '1700000120']],
    content: sealed[0]!.wire,
  };
  const id = eventId(base);
  const fixedEvent = { ...base, id, sig: hex(schnorr.sign(hexToBytes(id), sk, new Uint8Array(32))) };
  const blobForEvent = sealed[0]!.wire;
  const randomEvent = makeEvent('mailbox-y', { v: 1 } as never, { kind: 'msg', ttlSec: 3600 }, 1_700_000_000);
  const nostr = {
    secretKeyHex: hex(sk),
    publicKeyHex: base.pubkey,
    fixedEvent,
    fixedEventValid: verifyEvent(fixedEvent),
    randomEvent,
    randomEventValid: verifyEvent(randomEvent),
    tamperedEvent: { ...fixedEvent, content: fixedEvent.content + 'x' },
    tamperedEventValid: verifyEvent({ ...fixedEvent, content: fixedEvent.content + 'x' }),
    note: `content of fixedEvent is the wire blob ${blobForEvent.length} chars`,
  };

  const safety = {
    ann_bob: await deriveSafetyNumber(importKeyless(ann.id.signKey.pubJwk), importKeyless(bob.id.signKey.pubJwk)),
  };

  writeFileSync(
    new URL('../../../docs/android-vectors.json', import.meta.url),
    JSON.stringify({ generatedBy: 'packages/protocol/scripts/gen-android-vectors.ts', recovery, entropy, invalidPhrases, cards, sealed, flippedWire: flipped, canonical, network, nostr, uids: { ann: ann.uid, bob: bob.uid, cat: cat.uid }, safety, toB64Url: toB64Url(new Uint8Array([251, 255, 254])) }, null, 2) + '\n',
  );
  console.log('wrote docs/android-vectors.json');
}

function importKeyless(jwk: JsonWebKey): JsonWebKey {
  return jwk;
}
void identityFingerprintHex;
void importPublicJwk;

main();
