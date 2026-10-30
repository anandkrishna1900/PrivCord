/**
 * Generates docs/group-vectors.json: ground truth from the TypeScript group core
 * (packages/protocol/src/groups) that the Android (Kotlin) port must reproduce:
 * event ids, signed events Kotlin must verify, rosters/ordering for concurrent events, rejections, frames.
 * Run: `npx vite-node scripts/gen-group-vectors.ts` from packages/protocol.
 * Phrases are made from fixed entropy and are TEST ONLY; never use them as real identities.
 */
import { writeFileSync } from 'node:fs';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  GroupCoordinator,
  GroupLog,
  deriveIdentityFromPhrase,
  signGroupEvent,
  uidFromDh,
  type ContactCard,
  type GroupEvent,
} from '../src';

const NAMES = ['Ann', 'Bob', 'Cat', 'Dan', 'Eve'];

async function person(i: number) {
  const phrase = entropyToMnemonic(new Uint8Array(16).fill(0x40 + i), wordlist);
  const { identity } = await deriveIdentityFromPhrase(phrase);
  // Eve has no display name, so cards with and without `name` are both covered.
  const card: ContactCard = {
    v: 1, sign: identity.signKey.pubJwk, dh: identity.dhKey.pubJwk, proof: identity.identityProof,
    ...(i === 4 ? {} : { name: NAMES[i]! }),
  };
  return { name: NAMES[i]!, phrase, uid: await uidFromDh(identity.dhKey.pubJwk), card, signPriv: identity.signKey.privJwk };
}

type P = Awaited<ReturnType<typeof person>>;
const roster = (log: GroupLog) => [...(log.state()?.members.keys() ?? [])].sort();

async function trace(groupId: string, events: GroupEvent[]) {
  const log = new GroupLog(groupId);
  const steps = [];
  for (const e of events) {
    const status = await log.add(e);
    steps.push({ eventId: e.eventId, status, effective: log.isEffective(e.eventId), roster: roster(log), name: log.state()?.name ?? null });
  }
  return { steps, order: log.all().map((e) => e.eventId), heads: log.heads(), roster: roster(log), name: log.state()?.name ?? null, effective: log.all().filter((e) => log.isEffective(e.eventId)).map((e) => e.eventId) };
}

async function main() {
  const [a, b, c, d, e] = (await Promise.all([0, 1, 2, 3, 4].map(person))) as [P, P, P, P, P];
  const strange = 'Café ☕ "quoted" \\ back\u0001 😀';
  const coord = new GroupCoordinator({ ownUid: a.uid, ownCard: a.card, signPriv: a.signPriv, knownUids: () => new Set(), now: () => 1_700_000_000_000 });
  const { groupId } = await coord.createGroup(strange, [b.card]);
  const base = coord.export()[groupId]!;
  const heads = (await GroupLog.fromJSON(groupId, base)).heads();
  let t = 1_700_000_001_000;
  const sign = (x: Parameters<typeof signGroupEvent>[0], who: P) => signGroupEvent({ ts: (t += 1000), ...x }, who.signPriv);

  const concurrent = [
    await sign({ groupId, type: 'add', actor: b.uid, target: c.uid, card: c.card, deps: heads }, b),
    await sign({ groupId, type: 'add', actor: a.uid, target: d.uid, card: d.card, deps: heads }, a),
    await sign({ groupId, type: 'remove', actor: a.uid, target: b.uid, deps: heads }, a),
    await sign({ groupId, type: 'add', actor: b.uid, target: e.card.name === undefined ? e.uid : e.uid, card: e.card, deps: heads }, b),
  ];

  // A linear history with rename, leave and a later add by a member added by a member.
  const lin: GroupEvent[] = [...base];
  const push = async (x: Parameters<typeof signGroupEvent>[0], who: P) => {
    const log = await GroupLog.fromJSON(groupId, lin);
    const ev = await sign({ ...x, deps: log.heads() }, who);
    lin.push(ev);
    return ev;
  };
  await push({ groupId, type: 'add', actor: b.uid, target: c.uid, card: c.card }, b);
  await push({ groupId, type: 'add', actor: c.uid, target: e.uid, card: e.card }, c);
  await push({ groupId, type: 'rename', actor: a.uid, name: 'Renamed 🚀' }, a);
  await push({ groupId, type: 'remove', actor: c.uid, target: c.uid }, c); // C leaves
  await push({ groupId, type: 'rename', actor: b.uid, name: 'not admin' }, b); // ineffective

  // Rejections.
  const h = (await GroupLog.fromJSON(groupId, base)).heads();
  const rejects = {
    outsider: await sign({ groupId, type: 'add', actor: e.uid, target: c.uid, card: c.card, deps: h }, e),
    forged: await sign({ groupId, type: 'add', actor: a.uid, target: c.uid, card: c.card, deps: h }, e),
    wrongCard: await sign({ groupId, type: 'add', actor: b.uid, target: c.uid, card: e.card, deps: h }, b),
    memberRemovesAdmin: await sign({ groupId, type: 'remove', actor: b.uid, target: a.uid, deps: h }, b),
    tampered: { ...(await sign({ groupId, type: 'rename', actor: a.uid, name: 'New', deps: h }, a)), name: 'Hacked' },
    noDeps: await sign({ groupId, type: 'add', actor: a.uid, target: c.uid, card: c.card, deps: [] }, a),
    wrongGroup: { ...(await sign({ groupId, type: 'rename', actor: a.uid, name: 'x', deps: h }, a)), groupId: '0'.repeat(64) },
  };

  // Events whose dependencies arrive later.
  const addC = lin[2]!;
  const addEByC = lin[3]!;

  const frames = [
    { frame: { v: 1, kind: 'gmsg', groupId: 'g', messageId: 'm-1', text: 'hi', clientCreatedAt: 5 }, valid: true },
    { frame: { v: 1, kind: 'gmsg', groupId: 'g', messageId: 'm', text: '', clientCreatedAt: 1 }, valid: false },
    { frame: { v: 1, kind: 'gmsg', groupId: 'g', messageId: 'm', text: '   ', clientCreatedAt: 1 }, valid: false },
    { frame: { v: 1, kind: 'gmsg', groupId: 'g', messageId: 'm'.repeat(65), text: 'x', clientCreatedAt: 1 }, valid: false },
    { frame: { v: 1, kind: 'gmsg', groupId: 'g', messageId: 'm', text: 'x', clientCreatedAt: 0 }, valid: false },
    { frame: { v: 2, kind: 'gmsg' }, valid: false },
    { frame: { v: 1, kind: 'unknown' }, valid: false },
    { frame: { v: 1, kind: 'group_push', event: base[0] }, valid: true },
    { frame: { v: 1, kind: 'group_push', event: { ...base[0], eventId: 'zz' } }, valid: false },
    { frame: { v: 1, kind: 'group_events', events: base }, valid: true },
    { frame: { v: 1, kind: 'group_events', events: [{}] }, valid: false },
    { frame: { v: 1, kind: 'group_events', events: Array(41).fill(base[0]) }, valid: false },
    { frame: { v: 1, kind: 'group_have', groups: [{ groupId, ids: base.map((x) => x.eventId) }] }, valid: true },
    { frame: { v: 1, kind: 'group_have', groups: [{ groupId, ids: [1] }] }, valid: false },
    { frame: { v: 1, kind: 'relay_blob', hops: 3, blob: { v: 1, to: 'a', from: 'b', epk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, iv: 'i', ct: 'c', sig: 's' } }, valid: false },
    { frame: { v: 1, kind: 'relay_blob', hops: 1, blob: { v: 1, to: 'a', from: 'b', epk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, iv: 'i', ct: 'c', sig: 's' } }, valid: true },
    { frame: { v: 1, kind: 'relay_blob', hops: 1, blob: { v: 1, to: 'a' } }, valid: false },
  ];

  const out = {
    generatedBy: 'packages/protocol/scripts/gen-group-vectors.ts',
    people: [a, b, c, d, e].map((p) => ({ name: p.name, phrase: p.phrase, uid: p.uid, card: p.card })),
    groupId,
    groupName: strange,
    base,
    concurrent: { events: concurrent, expected: await trace(groupId, [...base, ...concurrent]) },
    linear: { events: lin, expected: await trace(groupId, lin) },
    rejects: await Promise.all(Object.entries(rejects).map(async ([label, event]) => ({ label, event, expected: await trace(groupId, [...base, event as GroupEvent]) }))),
    buffered: { events: [addEByC, addC], base, expected: await trace(groupId, [...base, addEByC, addC]) },
    frames,
  };
  writeFileSync(new URL('../../../docs/group-vectors.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log('wrote docs/group-vectors.json', out.concurrent.expected.roster.length, out.linear.expected.roster.length);
}

main();
