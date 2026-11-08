/**
 * Generates docs/e2ee-vectors.json: X3DH, Double Ratchet, envelope and group-message data made by the TypeScript
 * implementation (packages/protocol/src/e2ee), so the Rust port can be checked against it. Keys that the code would pick
 * at random are fixed here (from fixed scalars) so the file stays small and meaningful; the ratchet's own later keys
 * are random, which is fine because the file is committed, not re-derived.
 * Run from packages/protocol: `npx vite-node scripts/gen-e2ee-vectors.ts`. Test keys only.
 */
import { createECDH } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  GroupSessionManager,
  SIGNED_PREKEY_PREFIX,
  acceptInitialEnvelope,
  associatedDataFor,
  canonicalJson,
  createBundle,
  decryptEnvelope,
  deriveIdentityFromPhrase,
  ecdsaSign,
  encryptToEnvelope,
  envelopeDigest,
  initiateSession,
  initiateX3dh,
  respondX3dh,
  restoreSession,
  serializeSession,
  thumbJwk,
  toB64Url,
  validateBundle,
  validateEnvelope,
  type DuoEnvelope,
  type EcdhKeypair,
  type IdentityKeyPair,
  type OneTimePrekey,
  type PrekeyInventory,
  type SignedPrekey,
} from '../src';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function fixedKey(seed: number): EcdhKeypair {
  const d = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 1) d[i] = (seed * 31 + i * 7 + 1) & 0xff;
  d[0] = 0x11; // well below the curve order
  const e = createECDH('prime256v1');
  e.setPrivateKey(d);
  const pub = e.getPublicKey();
  const x = toB64Url(pub.subarray(1, 33));
  const y = toB64Url(pub.subarray(33, 65));
  return {
    privJwk: { kty: 'EC', crv: 'P-256', x, y, d: toB64Url(d), ext: true, key_ops: ['deriveBits'] },
    pubJwk: { kty: 'EC', crv: 'P-256', x, y },
  };
}

async function person(i: number): Promise<{ phrase: string; identity: IdentityKeyPair }> {
  const phrase = entropyToMnemonic(new Uint8Array(16).fill(0x90 + i), wordlist);
  const { identity } = await deriveIdentityFromPhrase(phrase);
  return { phrase, identity: identity as unknown as IdentityKeyPair };
}

const alice = await person(0);
const bob = await person(1);

const spkKey = fixedKey(1);
const signedPrekey: SignedPrekey = {
  id: 7, key: spkKey, createdAt: 1_700_000_000_000,
  signature: toB64Url(await ecdsaSign(bob.identity.signKey.privJwk, enc(SIGNED_PREKEY_PREFIX + canonicalJson(thumbJwk(spkKey.pubJwk))))),
};
const oneTimePrekey: OneTimePrekey = { id: 101, key: fixedKey(2) };
const bundle = createBundle(bob.identity, signedPrekey, oneTimePrekey);
const bundleNoOtk = createBundle(bob.identity, signedPrekey);
const inventory: PrekeyInventory = {
  getSignedPrekey: (id) => (id === signedPrekey.id ? signedPrekey : null),
  getOneTimePrekey: (id) => (id === oneTimePrekey.id ? oneTimePrekey : null),
};

// ---- bundle validation
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const tamperedSpk = clone(bundle); tamperedSpk.signedPrekey.dhJwk.y = (tamperedSpk.signedPrekey.dhJwk.y ?? '').slice(0, -2) + 'Q';
const swapped = { ...clone(bundle), identity: (await createBundle((await person(5)).identity, signedPrekey)).identity };
const badOtk = clone(bundle) as unknown as { oneTimePrekey: unknown }; badOtk.oneTimePrekey = { id: 1.5, dhJwk: oneTimePrekey.key.pubJwk };
const cases: Array<[string, unknown]> = [
  ['honest', bundle], ['honest without a one-time prekey', bundleNoOtk], ['tampered signed prekey', tamperedSpk],
  ['identity from another person', swapped], ['not an object', 'x'], ['wrong version', { ...clone(bundle), version: 2 }],
  ['malformed identity key', { ...clone(bundle), identity: { ...clone(bundle).identity, dhJwk: { kty: 'RSA' } } }],
  ['missing identity proof', { ...clone(bundle), identity: { ...clone(bundle).identity, identityProof: '' } }],
  ['bad signed prekey shape', { ...clone(bundle), signedPrekey: { id: 'seven' } }],
  ['missing signed prekey signature', { ...clone(bundle), signedPrekey: { ...clone(bundle).signedPrekey, signature: 5 } }],
  ['bad one-time prekey', badOtk],
];
const bundleCases = [];
for (const [name, b] of cases) bundleCases.push({ name, bundle: b, result: await validateBundle(b) });

// ---- raw X3DH
const init = await initiateX3dh(alice.identity, bundle);
const resp = await respondX3dh({ identity: bob.identity, peerIntro: { senderSignJwk: alice.identity.signKey.pubJwk, senderDhJwk: alice.identity.dhKey.pubJwk, senderIdentityProof: alice.identity.identityProof, ephemeralDhJwk: init.ephemeral.pubJwk, signedPrekeyId: init.usedSignedPrekeyId, ...(init.usedOneTimePrekeyId !== undefined ? { oneTimePrekeyId: init.usedOneTimePrekeyId } : {}) }, signedPrekey, oneTimePrekey });
const x3dh = {
  intro: { senderSignJwk: alice.identity.signKey.pubJwk, senderDhJwk: alice.identity.dhKey.pubJwk, senderIdentityProof: alice.identity.identityProof, ephemeralDhJwk: init.ephemeral.pubJwk, signedPrekeyId: init.usedSignedPrekeyId, oneTimePrekeyId: init.usedOneTimePrekeyId },
  rootKeyHex: hex(init.rootKey), associatedDataHex: hex(init.associatedData),
  responderRootKeyHex: hex(resp.rootKey), responderAssociatedDataHex: hex(resp.associatedData),
  ephemeral: init.ephemeral,
  adDirect: hex(await associatedDataFor(alice.identity.dhKey.pubJwk, bob.identity.dhKey.pubJwk)),
};

// ---- a session transcript: first message, replies, out of order, replay, tamper, wrong context
const t = { alice: await initiateSession(alice.identity, bundle, 'm-1', enc('hello Bob')), bob: undefined as unknown as Awaited<ReturnType<typeof acceptInitialEnvelope>> };
const aliceAfterInit = serializeSession(t.alice.session);
t.bob = await acceptInitialEnvelope(bob.identity, inventory, t.alice.envelope);
type Delivery = { envelope: DuoEnvelope; expect: string | null; note: string };
const send = async (from: 'alice' | 'bob', ctx: string, text: string) => encryptToEnvelope(from === 'alice' ? t.alice.session : t.bob.session, ctx, enc(text));
// Alice writes four more messages before she has seen Bob's reply (all on her first chain); Bob replies three times.
const m2 = await send('alice', 'm-3', 'how are you');
const m3 = await send('alice', 'm-4', 'second');
const m4 = await send('alice', 'm-5', 'third');
const m5 = await send('alice', 'm-6', 'fourth');
const r1 = await send('bob', 'm-2', 'hi Alice');
const r2 = await send('bob', 'm-7', 'doing fine');
const r3 = await send('bob', 'm-8', 'and you');
// Alice reads Bob's first reply (a DH ratchet step) and then writes on her new chain.
if (dec(await decryptEnvelope(t.alice.session, r1)) !== 'hi Alice') throw new Error('self-check');
const m6 = await send('alice', 'm-9', 'untouched');
const bobBeforeM6 = serializeSession(t.bob.session);
const flip = (b: string) => b.slice(0, b.length - 2) + (b[b.length - 2] === 'A' ? 'B' : 'A') + b.slice(b.length - 1);
const scenarios = [
  { name: 'Bob accepts the first message, then reads Alice\'s next four out of order and refuses a replay', start: 'accept', first: t.alice.envelope, firstExpect: 'hello Bob', deliveries: [
    { envelope: m5, expect: 'fourth', note: 'out of order: the last of the four arrives first' },
    { envelope: m2, expect: 'how are you', note: 'then the earliest' },
    { envelope: m4, expect: 'third', note: 'then the third' },
    { envelope: m3, expect: 'second', note: 'and the second' },
    { envelope: m3, expect: null, note: 'a replay of a used position fails' },
  ] as Delivery[] },
  { name: 'Alice reads Bob\'s replies, the later two out of order across a DH ratchet', start: 'alice', snapshot: aliceAfterInit, deliveries: [
    { envelope: r1, expect: 'hi Alice', note: 'the first reply runs Alice\'s DH ratchet' },
    { envelope: r3, expect: 'and you', note: 'out of order' },
    { envelope: r2, expect: 'doing fine', note: '' },
  ] as Delivery[] },
  { name: 'Bob after he replied: a changed byte, a rewritten context, then the real message', start: 'bob', snapshot: bobBeforeM6, deliveries: [
    { envelope: { ...m6, body: flip(m6.body) }, expect: null, note: 'a changed byte fails and changes nothing' },
    { envelope: { ...m6, ctx: 'm-XX' }, expect: null, note: 'a rewritten context fails' },
    { envelope: m6, expect: 'untouched', note: 'the real one still decrypts' },
  ] as Delivery[] },
];
void restoreSession;

const envelopeCases = [
  ['valid first', t.alice.envelope], ['valid follow-up', m2],
  ['wrong version', { ...m2, v: 2 }], ['wrong kind', { ...m2, kind: 'x' }], ['empty id', { ...m2, id: '' }], ['long id', { ...m2, id: 'a'.repeat(65) }],
  ['empty ctx', { ...m2, ctx: '' }], ['long ctx', { ...m2, ctx: 'c'.repeat(129) }], ['empty body', { ...m2, body: '' }],
  ['no header', { ...m2, header: undefined }], ['fractional counter', { ...m2, header: { ...m2.header, n: 1.5 } }],
  ['bad prekey', { ...t.alice.envelope, prekey: { ...t.alice.envelope.prekey, signedPrekeyId: 'x' } }],
].map(([name, e]) => ({ name, envelope: e, valid: validateEnvelope(e) }));
const digests = { first: await envelopeDigest(t.alice.envelope), firstExpect: t.alice.envelope.id, other: await envelopeDigest({ ...t.alice.envelope, ctx: 'other' }) };

// ---- group messages
const gm = new GroupSessionManager();
const epochKey = new Uint8Array(32).map((_, i) => (i * 5 + 9) & 0xff);
gm.setGroup({ groupId: 'g-1', name: 'Trip', createdBy: 'u1', createdAt: 1, epoch: 3, members: {} });
gm.setEpochKey('g-1', 3, epochKey);
const gmsg = await gm.encrypt('g-1', 'uid-ann', 42, { t: 'hello group', n: [1, 2] });
const group = { epochKeyHex: hex(epochKey), message: gmsg, payload: { t: 'hello group', n: [1, 2] } };

const out = {
  comment: 'Generated by packages/protocol/scripts/gen-e2ee-vectors.ts. Test keys only.',
  alice: { phrase: alice.phrase, uid: null }, bob: { phrase: bob.phrase },
  prekeys: { signed: { id: signedPrekey.id, key: spkKey, signature: signedPrekey.signature, createdAt: signedPrekey.createdAt }, oneTime: { id: oneTimePrekey.id, key: oneTimePrekey.key } },
  bundle, bundleCases, x3dh, scenarios, envelopeCases, digests, group,
};
writeFileSync(new URL('../../../docs/e2ee-vectors.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('wrote docs/e2ee-vectors.json');
