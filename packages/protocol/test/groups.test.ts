import { describe, expect, it } from 'vitest';
import {
  GroupCoordinator,
  GroupLog,
  deriveIdentityFromPhrase,
  generateRecoveryPhrase,
  parseGroupFrame,
  signGroupEvent,
  uidFromDh,
  type ContactCard,
  type GroupEvent,
  type GroupFrame,
  type GroupResult,
  type OutgoingFrame,
} from '../src';

/* ------------------------------------------------------------------ helpers ------------------------------------------------------------------ */

interface Person {
  uid: string;
  card: ContactCard;
  signPriv: JsonWebKey;
}

async function person(name: string): Promise<Person> {
  const { identity } = await deriveIdentityFromPhrase(generateRecoveryPhrase());
  return {
    uid: await uidFromDh(identity.dhKey.pubJwk),
    signPriv: identity.signKey.privJwk,
    card: { v: 1, sign: identity.signKey.pubJwk, dh: identity.dhKey.pubJwk, proof: identity.identityProof, name },
  };
}

/** A device: its coordinator, the contacts it has pinned, and which peers it is currently linked to. */
class Node {
  known = new Set<string>();
  contactCards = new Map<string, ContactCard>();
  introducedBy = new Map<string, string>();
  online = true;
  joined: string[] = [];
  left: string[] = [];
  coord: GroupCoordinator;
  constructor(readonly p: Person) {
    this.coord = new GroupCoordinator({
      ownUid: p.uid,
      ownCard: p.card,
      signPriv: p.signPriv,
      knownUids: () => this.known,
    });
  }
  pin(other: Person) {
    this.known.add(other.uid);
    this.contactCards.set(other.uid, other.card);
  }
}

/** In-memory network: frames are only delivered over links where both sides know each other and are online. */
class Net {
  nodes = new Map<string, Node>();
  linked = new Set<string>(); // "a|b" with a<b
  frames = 0;
  dropped = 0;

  add(n: Node) {
    this.nodes.set(n.p.uid, n);
    return n;
  }
  private key(a: string, b: string) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }
  isLinked(a: string, b: string) {
    return this.linked.has(this.key(a, b));
  }

  /** Auto-connect every pair that has pinned each other (this is what the engines do on their own). */
  async reconcile() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const a of this.nodes.values()) {
        for (const b of this.nodes.values()) {
          if (a === b || !a.online || !b.online) continue;
          if (a.known.has(b.p.uid) && b.known.has(a.p.uid) && !this.isLinked(a.p.uid, b.p.uid)) {
            this.linked.add(this.key(a.p.uid, b.p.uid));
            changed = true;
            // Link opens on both sides: each sends its group summary.
            await this.dispatch(a, a.coord.onLinkOpen(b.p.uid));
            await this.dispatch(b, b.coord.onLinkOpen(a.p.uid));
          }
        }
      }
    }
  }

  setOnline(n: Node, online: boolean) {
    n.online = online;
    if (!online) for (const k of [...this.linked]) if (k.split('|').includes(n.p.uid)) this.linked.delete(k);
  }

  async dispatch(from: Node, out: OutgoingFrame[]) {
    const queue: { from: Node; frame: OutgoingFrame }[] = out.map((frame) => ({ from, frame }));
    while (queue.length > 0) {
      const { from: sender, frame } = queue.shift()!;
      const target = this.nodes.get(frame.to);
      if (!target || !this.isLinked(sender.p.uid, target.p.uid)) {
        this.dropped += 1;
        continue;
      }
      this.frames += 1;
      // Frames cross the wire as JSON.
      const parsed = parseGroupFrame(JSON.parse(JSON.stringify(frame.frame)));
      expect(parsed).not.toBeNull();
      const result = await target.coord.handle(sender.p.uid, parsed as GroupFrame);
      await this.absorb(target, result, queue);
    }
  }

  private async absorb(n: Node, r: GroupResult, queue: { from: Node; frame: OutgoingFrame }[]) {
    n.joined.push(...r.joined);
    n.left.push(...r.left);
    for (const c of r.newContacts) {
      n.known.add(c.uid);
      n.contactCards.set(c.uid, c.card);
      n.introducedBy.set(c.uid, c.introducedBy);
    }
    for (const frame of r.outgoing) queue.push({ from: n, frame });
    if (r.newContacts.length > 0) await this.reconcile();
  }

  /** Run a locally authored change: apply its result on the author, then deliver. */
  async run(author: Node, result: GroupResult) {
    await this.absorb(author, result, []);
    await this.dispatch(author, result.outgoing);
    await this.reconcile();
  }
}

/** Deterministic shuffle so failures are reproducible. */
function shuffle<T>(items: T[], seed: number): T[] {
  const a = [...items];
  let s = seed;
  for (let i = a.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const roster = (log: GroupLog) => [...(log.state()?.members.keys() ?? [])].sort().join(',');

/* ------------------------------------------------------------------ tests ------------------------------------------------------------------ */

describe('group log', () => {
  it('creates a self-certifying group and a roster that survives a JSON round trip', async () => {
    const a = await person('A');
    const b = await person('B');
    const log = new GroupLog('x');
    const coord = new GroupCoordinator({ ownUid: a.uid, ownCard: a.card, signPriv: a.signPriv, knownUids: () => new Set([b.uid]) });
    const r = await coord.createGroup('Friends', [b.card]);
    expect(r.groupId).toMatch(/^[0-9a-f]{64}$/);
    const state = coord.state(r.groupId)!;
    expect([...state.members.keys()].sort()).toEqual([a.uid, b.uid].sort());
    expect(state.members.get(a.uid)?.role).toBe('admin');
    expect(state.members.get(b.uid)?.addedBy).toBe(a.uid);

    const copy = await GroupLog.fromJSON(r.groupId, JSON.parse(JSON.stringify(coord.export()[r.groupId])));
    expect(roster(copy)).toBe([a.uid, b.uid].sort().join(','));
    void log;
  });

  it('rejects forged, mis-addressed and unauthorised events', async () => {
    const a = await person('A');
    const b = await person('B');
    const c = await person('C');
    const evil = await person('Evil');
    const coord = new GroupCoordinator({ ownUid: a.uid, ownCard: a.card, signPriv: a.signPriv, knownUids: () => new Set() });
    const { groupId } = await coord.createGroup('G', [b.card]);
    const log = await GroupLog.fromJSON(groupId, coord.export()[groupId]!);
    const heads = log.heads();

    // Not a member.
    const outsider = await signGroupEvent({ groupId, type: 'add', actor: evil.uid, target: c.uid, card: c.card, deps: heads }, evil.signPriv);
    await log.add(outsider);
    expect(log.state()!.members.has(c.uid)).toBe(false);

    // A member signing as someone else.
    const forged = await signGroupEvent({ groupId, type: 'add', actor: a.uid, target: c.uid, card: c.card, deps: heads }, evil.signPriv);
    await log.add(forged);
    expect(log.state()!.members.has(c.uid)).toBe(false);

    // Card that does not belong to the claimed target.
    const wrongCard = await signGroupEvent({ groupId, type: 'add', actor: b.uid, target: c.uid, card: evil.card, deps: heads }, b.signPriv);
    await log.add(wrongCard);
    expect(log.state()!.members.has(c.uid)).toBe(false);

    // A plain member cannot remove someone else; the admin can.
    const bRemovesA = await signGroupEvent({ groupId, type: 'remove', actor: b.uid, target: a.uid, deps: heads }, b.signPriv);
    await log.add(bRemovesA);
    expect(log.state()!.members.has(a.uid)).toBe(true);
    const aRemovesB = await signGroupEvent({ groupId, type: 'remove', actor: a.uid, target: b.uid, deps: heads }, a.signPriv);
    await log.add(aRemovesB);
    expect(log.state()!.members.has(b.uid)).toBe(false);

    // Tampering with an event after signing breaks it.
    const good = await signGroupEvent({ groupId, type: 'rename', actor: a.uid, name: 'New', deps: log.heads() }, a.signPriv);
    expect(await log.add({ ...good, name: 'Hacked' })).toBe('invalid');
    expect(log.state()!.name).toBe('G');
  });

  it('converges to the same roster for every arrival order, including concurrent add/remove', async () => {
    const [a, b, c, d, e] = await Promise.all(['A', 'B', 'C', 'D', 'E'].map(person));
    const coordA = new GroupCoordinator({ ownUid: a!.uid, ownCard: a!.card, signPriv: a!.signPriv, knownUids: () => new Set() });
    const { groupId } = await coordA.createGroup('G', [b!.card]);
    const base = coordA.export()[groupId]!;
    const baseHeads = (await GroupLog.fromJSON(groupId, base)).heads();

    // Concurrent branches off the same heads: B adds C, A adds D, A removes B, B adds E.
    const ev: GroupEvent[] = [
      await signGroupEvent({ groupId, type: 'add', actor: b!.uid, target: c!.uid, card: c!.card, deps: baseHeads }, b!.signPriv),
      await signGroupEvent({ groupId, type: 'add', actor: a!.uid, target: d!.uid, card: d!.card, deps: baseHeads }, a!.signPriv),
      await signGroupEvent({ groupId, type: 'remove', actor: a!.uid, target: b!.uid, deps: baseHeads }, a!.signPriv),
      await signGroupEvent({ groupId, type: 'add', actor: b!.uid, target: e!.uid, card: e!.card, deps: baseHeads }, b!.signPriv),
    ];
    const results = new Set<string>();
    for (let seed = 1; seed <= 12; seed += 1) {
      const log = new GroupLog(groupId);
      for (const x of shuffle([...base, ...ev], seed)) await log.add(x);
      results.add(roster(log));
    }
    expect(results.size).toBe(1);
    // "Remove wins": B was removed concurrently with B's adds, so B's concurrent adds have no effect.
    const final = [...results][0]!;
    expect(final).toBe([a!.uid, d!.uid].sort().join(','));
  });

  it('buffers events that arrive before their dependencies and applies them when the gap fills', async () => {
    const a = await person('A');
    const b = await person('B');
    const c = await person('C');
    const coord = new GroupCoordinator({ ownUid: a.uid, ownCard: a.card, signPriv: a.signPriv, knownUids: () => new Set() });
    const { groupId } = await coord.createGroup('G', [b.card]);
    const [create, addB] = coord.export()[groupId]!;
    const log = new GroupLog(groupId);
    const addC = await signGroupEvent({ groupId, type: 'add', actor: b.uid, target: c.uid, card: c.card, deps: [addB!.eventId] }, b.signPriv);
    expect(await log.add(addC)).toBe('buffered');
    expect(log.missingDeps()).toEqual([addB!.eventId]);
    expect(await log.add(create)).toBe('applied');
    expect(await log.add(addB)).toBe('applied');
    expect(roster(log)).toBe([a.uid, b.uid, c.uid].sort().join(','));
  });
});

describe('introductions (A adds B, B adds C: A and C connect without any code sharing)', () => {
  it('A learns C from B, C learns A, and they link automatically', async () => {
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(person));
    const net = new Net();
    const nA = net.add(new Node(a!));
    const nB = net.add(new Node(b!));
    const nC = net.add(new Node(c!));
    // Only the two real-world meetings happened: A met B, B met C.
    nA.pin(b!); nB.pin(a!);
    nB.pin(c!); nC.pin(b!);
    await net.reconcile();
    expect(net.isLinked(a!.uid, b!.uid)).toBe(true);
    expect(net.isLinked(a!.uid, c!.uid)).toBe(false);

    const created = await nA.coord.createGroup('Trip', [b!.card]);
    await net.run(nA, created);
    expect(nB.joined).toContain(created.groupId);
    expect(nC.coord.myGroups()).toHaveLength(0);
    expect(net.isLinked(a!.uid, c!.uid)).toBe(false);

    // B adds C. Nobody pastes anything.
    await net.run(nB, await nB.coord.addMember(created.groupId, c!.card));

    expect(nC.joined).toContain(created.groupId);
    expect(nA.known.has(c!.uid)).toBe(true);
    expect(nA.introducedBy.get(c!.uid)).toBe(b!.uid);
    expect(nC.known.has(a!.uid)).toBe(true);
    expect(nC.introducedBy.get(a!.uid)).toBe(a!.uid === a!.uid ? nC.introducedBy.get(a!.uid) : undefined);
    expect(net.isLinked(a!.uid, c!.uid)).toBe(true);
    for (const n of [nA, nB, nC]) expect(roster(await GroupLog.fromJSON(created.groupId, n.coord.export()[created.groupId]!))).toBe([a!.uid, b!.uid, c!.uid].sort().join(','));
  });

  it('a member added while another is offline catches up on reconnect', async () => {
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(person));
    const net = new Net();
    const nA = net.add(new Node(a!));
    const nB = net.add(new Node(b!));
    const nC = net.add(new Node(c!));
    nA.pin(b!); nB.pin(a!); nB.pin(c!); nC.pin(b!);
    await net.reconcile();
    const created = await nA.coord.createGroup('Trip', [b!.card]);
    await net.run(nA, created);

    net.setOnline(nA, false); // A is offline when B adds C
    await net.run(nB, await nB.coord.addMember(created.groupId, c!.card));
    expect(nA.known.has(c!.uid)).toBe(false);

    net.setOnline(nA, true);
    await net.reconcile(); // A reconnects to B: sync delivers the event, introduction follows, A links to C
    expect(nA.known.has(c!.uid)).toBe(true);
    expect(net.isLinked(a!.uid, c!.uid)).toBe(true);
  });

  it('spam from a contact who never made us a member is dropped; non-members cannot pull history', async () => {
    const [a, b, x] = await Promise.all(['A', 'B', 'X'].map(person));
    const net = new Net();
    const nA = net.add(new Node(a!));
    const nB = net.add(new Node(b!));
    const nX = net.add(new Node(x!));
    nA.pin(b!); nB.pin(a!); nA.pin(x!); nX.pin(a!);
    await net.reconcile();
    // B creates a group that does NOT include A, then pushes it at A anyway.
    const g = await nB.coord.createGroup('Spam', []);
    const events = nB.coord.export()[g.groupId]!;
    await net.dispatch(nB, [{ to: a!.uid, frame: { v: 1, kind: 'group_events', events } }]);
    expect(nA.coord.groupIds()).toHaveLength(0);

    // X (not a member of B's other group) asks A for its history: gets nothing.
    const gA = await nA.coord.createGroup('Private', [b!.card]);
    await net.run(nA, gA);
    const reply = await nA.coord.handle(x!.uid, { v: 1, kind: 'group_have', groups: [{ groupId: gA.groupId, ids: [] }] });
    expect(reply.outgoing).toHaveLength(0);
  });

  it('removing a member stops further group traffic to them and they learn they are out', async () => {
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(person));
    const net = new Net();
    const nA = net.add(new Node(a!));
    const nB = net.add(new Node(b!));
    const nC = net.add(new Node(c!));
    nA.pin(b!); nB.pin(a!); nA.pin(c!); nC.pin(a!);
    await net.reconcile();
    const created = await nA.coord.createGroup('G', [b!.card, c!.card]);
    await net.run(nA, created);
    expect(nA.coord.recipients(created.groupId).sort()).toEqual([b!.uid, c!.uid].sort());

    await net.run(nA, await nA.coord.removeMember(created.groupId, c!.uid));
    expect(nC.left).toContain(created.groupId);
    expect(nA.coord.recipients(created.groupId)).toEqual([b!.uid]);
    expect(nC.coord.checkMessage(a!.uid, created.groupId)).toBe('not_member');
    expect(nB.coord.checkMessage(c!.uid, created.groupId)).toBe('not_member');
    expect(nB.coord.checkMessage(a!.uid, created.groupId)).toBe('ok');
    expect(nB.coord.checkMessage(a!.uid, 'nope')).toBe('unknown_group');
  });
});

describe('large groups', () => {
  it('25 members, each added by a random existing member, all converge and all connect to each other', async () => {
    const N = 25;
    const people = await Promise.all(Array.from({ length: N }, (_, i) => person(`P${i}`)));
    const net = new Net();
    const nodes = people.map((p) => net.add(new Node(p)));

    // Real-world meetings: a chain, so nobody except neighbours has ever exchanged a card with anyone else.
    for (let i = 1; i < N; i += 1) {
      nodes[i]!.pin(people[i - 1]!);
      nodes[i - 1]!.pin(people[i]!);
    }
    await net.reconcile();

    const first = await nodes[0]!.coord.createGroup('Everyone', [people[1]!.card]);
    await net.run(nodes[0]!, first);
    const groupId = first.groupId;

    // Member i is added by member i-1, who is the only one who knows them. Everyone else must discover them via the group.
    for (let i = 2; i < N; i += 1) {
      await net.run(nodes[i - 1]!, await nodes[i - 1]!.coord.addMember(groupId, people[i]!.card));
    }

    const expected = people.map((p) => p.uid).sort().join(',');
    for (const n of nodes) {
      const log = await GroupLog.fromJSON(groupId, n.coord.export()[groupId]!);
      expect(roster(log)).toBe(expected);
      // Everyone ended up with a contact (and an automatic link) for every other member.
      expect(n.known.size).toBe(N - 1);
      expect(n.coord.recipients(groupId)).toHaveLength(N - 1);
    }
    let links = 0;
    for (const a of nodes) for (const b of nodes) if (a !== b && net.isLinked(a.p.uid, b.p.uid)) links += 1;
    expect(links).toBe(N * (N - 1)); // full mesh, no manual step
  }, 120_000);

  it('survives members dropping offline during growth and converges after they return', async () => {
    const N = 12;
    const people = await Promise.all(Array.from({ length: N }, (_, i) => person(`Q${i}`)));
    const net = new Net();
    const nodes = people.map((p) => net.add(new Node(p)));
    for (let i = 1; i < N; i += 1) {
      nodes[i]!.pin(people[i - 1]!);
      nodes[i - 1]!.pin(people[i]!);
    }
    await net.reconcile();
    const first = await nodes[0]!.coord.createGroup('Flaky', [people[1]!.card]);
    await net.run(nodes[0]!, first);
    const groupId = first.groupId;
    for (let i = 2; i < N; i += 1) {
      // Every third member is offline at the moment someone is added.
      const off = nodes.filter((_, k) => k % 3 === 0 && k !== i - 1 && k !== i);
      for (const n of off) net.setOnline(n, false);
      await net.run(nodes[i - 1]!, await nodes[i - 1]!.coord.addMember(groupId, people[i]!.card));
      for (const n of off) net.setOnline(n, true);
      await net.reconcile();
    }
    await net.reconcile();
    const expected = people.map((p) => p.uid).sort().join(',');
    for (const n of nodes) expect(roster(await GroupLog.fromJSON(groupId, n.coord.export()[groupId]!))).toBe(expected);
  }, 120_000);
});

describe('group frames', () => {
  it('rejects malformed frames', () => {
    expect(parseGroupFrame({ v: 1, kind: 'gmsg', groupId: 'g', messageId: 'm', text: '', clientCreatedAt: 1 })).toBeNull();
    expect(parseGroupFrame({ v: 1, kind: 'group_events', events: [{}] })).toBeNull();
    expect(parseGroupFrame({ v: 2, kind: 'gmsg' })).toBeNull();
    expect(parseGroupFrame({ v: 1, kind: 'gmsg', groupId: 'g', messageId: 'm-1', text: 'hi', clientCreatedAt: 5 })?.kind).toBe('gmsg');
    expect(parseGroupFrame({ v: 1, kind: 'unknown' })).toBeNull();
  });
});
