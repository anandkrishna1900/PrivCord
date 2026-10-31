import { describe, expect, it } from 'vitest';
import {
  MESH_MAX_TTL,
  MeshNode,
  deriveChannel,
  deriveIdentityFromPhrase,
  generateRecoveryPhrase,
  makeMeshPacket,
  normalizeChannelName,
  openChannelMessage,
  parseMeshPacket,
  sealChannelMessage,
  uidFromDh,
  type ContactCard,
  type Outgoing,
  type SealedBlob,
} from '../src';

async function person(name: string) {
  const { identity } = await deriveIdentityFromPhrase(generateRecoveryPhrase());
  const card: ContactCard = { v: 1, sign: identity.signKey.pubJwk, dh: identity.dhKey.pubJwk, proof: identity.identityProof, name };
  return { uid: await uidFromDh(identity.dhKey.pubJwk), card, signPriv: identity.signKey.privJwk };
}

describe('open channels', () => {
  it('normalizes names so #General, general and "General  " are one room', () => {
    expect(normalizeChannelName('#General')).toBe('general');
    expect(normalizeChannelName('  general  ')).toBe('general');
    expect(normalizeChannelName('Lagos Traffic!!')).toBe('lagos-traffic');
    expect(normalizeChannelName('кофе')).toBe('кофе');
    expect(normalizeChannelName('###')).toBeNull();
    expect(normalizeChannelName('')).toBeNull();
    expect(normalizeChannelName('x'.repeat(100))!.length).toBe(32);
  });

  it('a message is readable only in its channel, shows who really sent it, and cannot be forged', async () => {
    const [ann, mallory] = [await person('Ann'), await person('Mallory')];
    const general = await deriveChannel('general');
    const other = await deriveChannel('secret-club');
    expect(general.mailbox).not.toBe(other.mailbox);
    const blob = await sealChannelMessage({ channel: general, text: 'hello everyone', at: 1000, card: ann.card, uid: ann.uid, signPriv: ann.signPriv });
    const got = await openChannelMessage(general, blob);
    expect(got?.text).toBe('hello everyone');
    expect(got?.contact.uid).toBe(ann.uid);
    expect(got?.contact.card.name).toBe('Ann');
    expect(await openChannelMessage(other, blob)).toBeNull(); // wrong room
    // Mallory cannot sign as Ann, nor claim Ann's uid with her own card.
    const forged = await sealChannelMessage({ channel: general, text: 'I am Ann', at: 1000, card: ann.card, uid: ann.uid, signPriv: mallory.signPriv });
    expect(await openChannelMessage(general, forged)).toBeNull();
    const liar = await sealChannelMessage({ channel: general, text: 'I am Ann', at: 1000, card: mallory.card, uid: ann.uid, signPriv: mallory.signPriv });
    expect(await openChannelMessage(general, liar)).toBeNull();
    expect(await openChannelMessage(general, { ...blob, ct: blob.ct.slice(0, -4) + 'AAAA' })).toBeNull();
    await expect(sealChannelMessage({ channel: general, text: '   ', at: 1, card: ann.card, uid: ann.uid, signPriv: ann.signPriv })).rejects.toThrow();
  });
});

/* ---------------- the mesh, simulated ---------------- */

class Sim {
  nodes = new Map<string, MeshNode>();
  /** Everything each node accepted (the caller would try to open it). */
  got = new Map<string, SealedBlob[]>();
  sent = 0;
  now = 1_000_000;
  edges = new Set<string>();

  add(...ids: string[]) {
    for (const id of ids) {
      this.nodes.set(id, new MeshNode());
      this.got.set(id, []);
    }
  }
  private key(a: string, b: string) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }
  connect(a: string, b: string) {
    this.edges.add(this.key(a, b));
    this.deliver(a, this.nodes.get(a)!.linkUp(b, this.now));
    this.deliver(b, this.nodes.get(b)!.linkUp(a, this.now));
  }
  disconnect(a: string, b: string) {
    this.edges.delete(this.key(a, b));
    this.nodes.get(a)!.linkDown(b);
    this.nodes.get(b)!.linkDown(a);
  }
  /** `from` sends these packets to the neighbours named in them, and everything triggered by that. */
  deliver(from: string, outs: Outgoing[]) {
    const queue = outs.map((o) => ({ from, ...o }));
    while (queue.length > 0) {
      const { from: src, link, packet } = queue.shift()!;
      if (!this.edges.has(this.key(src, link))) continue;
      this.sent += 1;
      const r = this.nodes.get(link)!.handle(JSON.parse(JSON.stringify(packet)), src, this.now);
      if (r.accepted) this.got.get(link)!.push(r.accepted);
      for (const o of r.forward) queue.push({ from: link, ...o });
    }
  }
  send(origin: string, blob: SealedBlob) {
    this.deliver(origin, this.nodes.get(origin)!.inject(blob, this.now));
  }
}

async function message(text: string, who = 'Ann') {
  const p = await person(who);
  const ch = await deriveChannel('general');
  return { p, blob: await sealChannelMessage({ channel: ch, text, at: 1, card: p.card, uid: p.uid, signPriv: p.signPriv }) };
}

describe('mesh relaying', () => {
  it('crosses several phones to reach somebody out of the sender radio range', async () => {
    const sim = new Sim();
    sim.add('A', 'B', 'C', 'D', 'E');
    for (const [x, y] of [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E']] as const) sim.connect(x, y);
    const { blob } = await message('from A');
    sim.send('A', blob);
    for (const id of ['B', 'C', 'D', 'E']) expect(sim.got.get(id)).toHaveLength(1);
    expect(sim.got.get('A')).toHaveLength(0); // never echoed back to its author
  });

  it('stops after the hop limit', async () => {
    const sim = new Sim();
    const ids = Array.from({ length: 12 }, (_, i) => `N${i}`);
    sim.add(...ids);
    for (let i = 0; i < 11; i += 1) sim.connect(ids[i]!, ids[i + 1]!);
    const { blob } = await message('long way');
    sim.send('N0', blob);
    const reached = ids.filter((id) => (sim.got.get(id)?.length ?? 0) > 0).length;
    expect(reached).toBe(MESH_MAX_TTL); // N1..N7
    expect(sim.got.get('N8')).toHaveLength(0);
  });

  it('delivers once per phone even with loops, and does not flood endlessly', async () => {
    const sim = new Sim();
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
    sim.add(...ids);
    // a ring plus chords: lots of loops
    for (let i = 0; i < 6; i += 1) sim.connect(ids[i]!, ids[(i + 1) % 6]!);
    sim.connect('A', 'D');
    sim.connect('B', 'E');
    sim.connect('C', 'F');
    const { blob } = await message('loops');
    sim.send('A', blob);
    for (const id of ids.slice(1)) expect(sim.got.get(id)).toHaveLength(1);
    expect(sim.sent).toBeLessThanOrEqual(sim.edges.size * 2); // each link carries it at most once each way
  });

  it('carries a message for a phone that shows up later (store, carry, forward)', async () => {
    const sim = new Sim();
    sim.add('A', 'B', 'C');
    sim.connect('A', 'B');
    const { blob } = await message('wait for me');
    sim.send('A', blob);
    expect(sim.got.get('C')).toHaveLength(0);
    sim.now += 10 * 60_000;
    sim.disconnect('A', 'B');
    sim.connect('B', 'C'); // B walks into C's range
    expect(sim.got.get('C')).toHaveLength(1);
    // and it does not hand the same message to the same neighbour again
    sim.disconnect('B', 'C');
    sim.connect('B', 'C');
    expect(sim.got.get('C')).toHaveLength(1);
  });

  it('forgets carried messages after the carry time', async () => {
    const sim = new Sim();
    sim.add('A', 'B', 'C');
    sim.connect('A', 'B');
    sim.send('A', (await message('stale')).blob);
    sim.now += 31 * 60_000;
    sim.disconnect('A', 'B');
    sim.connect('B', 'C');
    expect(sim.got.get('C')).toHaveLength(0);
  });

  it('refuses a sender who floods the mesh', async () => {
    const node = new MeshNode({ perSenderPerMinute: 5 });
    node.linkUp('x', 0);
    const p = await person('Spammer');
    const ch = await deriveChannel('general');
    let accepted = 0;
    for (let i = 0; i < 12; i += 1) {
      const blob = await sealChannelMessage({ channel: ch, text: `spam ${i}`, at: i + 1, card: p.card, uid: p.uid, signPriv: p.signPriv });
      if (node.handle(makeMeshPacket(blob), 'x', 1000 + i).accepted) accepted += 1;
    }
    expect(accepted).toBe(5);
  });

  it('rejects garbage, tampered ids, and a ttl that tries to exceed the limit', async () => {
    const { blob } = await message('x');
    const good = makeMeshPacket(blob);
    expect(parseMeshPacket(good)).not.toBeNull();
    expect(parseMeshPacket({ ...good, id: 'something-else' })).toBeNull();
    expect(parseMeshPacket({ ...good, ttl: 0 })).toBeNull();
    expect(parseMeshPacket({ ...good, blob: { ...blob, to: 5 } })).toBeNull();
    expect(parseMeshPacket(null)).toBeNull();
    expect(parseMeshPacket({ ...good, ttl: 9999 })?.ttl).toBe(MESH_MAX_TTL);
    expect(parseMeshPacket({ ...good, blob: { ...blob, ct: 'A'.repeat(20_000) } })).toBeNull();
    const node = new MeshNode();
    expect(node.handle('nope', 'x', 1).accepted).toBeNull();
  });

  it('a random 30-phone network delivers a message to everyone it can reach within the hop limit', async () => {
    const sim = new Sim();
    const ids = Array.from({ length: 30 }, (_, i) => `P${i}`);
    sim.add(...ids);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 1; i < 30; i += 1) sim.connect(ids[i]!, ids[Math.floor(rnd() * i)]!); // a random tree: connected
    for (let k = 0; k < 15; k += 1) {
      const a = ids[Math.floor(rnd() * 30)]!;
      const b = ids[Math.floor(rnd() * 30)]!;
      if (a !== b) sim.connect(a, b);
    }
    // expected reach: BFS up to MESH_MAX_TTL hops
    const adj = new Map<string, string[]>();
    for (const e of sim.edges) {
      const [a, b] = e.split('|') as [string, string];
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
    }
    const dist = new Map([['P0', 0]]);
    for (const q = ['P0']; q.length; ) {
      const x = q.shift()!;
      for (const y of adj.get(x) ?? []) if (!dist.has(y)) { dist.set(y, dist.get(x)! + 1); q.push(y); }
    }
    sim.send('P0', (await message('everyone')).blob);
    for (const id of ids.slice(1)) {
      const reachable = (dist.get(id) ?? 99) <= MESH_MAX_TTL;
      expect(sim.got.get(id)!.length, `${id} at distance ${dist.get(id)}`).toBe(reachable ? 1 : 0);
    }
  });
});
