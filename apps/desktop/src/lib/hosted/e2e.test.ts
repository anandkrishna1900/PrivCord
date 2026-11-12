/**
 * End to end: two `HostedChatEngine`s, each driving a REAL Rust engine in its own process (`host_stdio`, standing in for the
 * Tauri shell), connected by in-memory "WebRTC" links and an in-memory relay. Everything between the screens' API and the
 * engine is the real code: the JSON commands, the snapshot shaping, the runtime's dial / signal / frame handling.
 *
 * Needs the example built first (`cargo build -p privcord-desktop-host --example host_stdio`); skipped when it is not there.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NETWORK_CONFIG, deriveIdentityFromPhrase, uidFromKeys, type SealedBlob } from '@duochat/protocol';
import { legacySecretsHex } from './legacyIdentity';
import type { EngineBridge } from '../engineBridge';
import type { PeerTransportHandlers } from '../p2p';
import { HostedChatEngine, type HostedDeps } from './hostedEngine';
import type { BleLike, LinkTransport, RelayHub } from './runtime';
import type { BleHandlers } from '../ble';

const BIN = path.resolve(__dirname, '../../../../../target/debug/examples/host_stdio');
const present = existsSync(BIN);

/** The shell, as a child process. */
function stdioBridge(secretsHex?: string): { bridge: EngineBridge; kill: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'privcord-host-'));
  const child: ChildProcessByStdio<Writable, Readable, null> = spawn(BIN, [path.join(dir, 'engine.db'), ...(secretsHex ? [secretsHex] : [])], { stdio: ['pipe', 'pipe', 'inherit'] });
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const handlers = new Map<string, ((p: unknown) => void)[]>();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line) as { id?: number; ok?: unknown; err?: string; ev?: string; payload?: unknown };
    if (m.ev) {
      if (process.env.HOSTED_TRACE) console.log(path.basename(dir), m.ev, JSON.stringify(m.payload).slice(0, 140));
      for (const h of handlers.get(m.ev) ?? []) h(m.payload);
    } else if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.err !== undefined) p.reject(new Error(m.err));
      else p.resolve(m.ok);
    }
  });
  const call = (command: string, args: unknown = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, command, args })}\n`);
    });
  const bridge: EngineBridge = {
    start: async () => void (await call('engine_start')),
    stop: async () => void (await call('engine_stop')),
    invoke: (command, args = {}) => call('engine_invoke', { command, args }),
    on: async (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
  };
  return { bridge, kill: () => child.kill() };
}

/** An in-memory relay: a blob put on a mailbox reaches every other hub listening on it. */
class Bus {
  readonly hubs = new Set<BusHub>();
}
class BusHub implements RelayHub {
  private mailboxes = new Map<string, (blob: SealedBlob) => void>();
  /** `false`: sockets that never come online (no relay reachable), so friends only connect by hand or by Bluetooth. */
  constructor(private readonly bus: Bus, private readonly online = true) {
    bus.hubs.add(this);
  }
  start(mailbox: string, onBlob: (blob: SealedBlob) => void) {
    this.mailboxes.set(mailbox, onBlob);
  }
  async put(mailbox: string, blob: SealedBlob) {
    for (const hub of this.bus.hubs) if (hub !== this) setTimeout(() => hub.mailboxes.get(mailbox)?.(blob), 5);
  }
  status() {
    return this.online ? ('online' as const) : ('error' as const);
  }
  stop() {
    this.mailboxes.clear();
    this.bus.hubs.delete(this);
  }
}

/** In-memory data channels: `acceptOffer` connects the two ends. */
class Wire {
  readonly offers = new Map<string, FakeLink>();
  seq = 0;
}
class FakeLink implements LinkTransport {
  isOpen = false;
  candidates = { host: 1, srflx: 0, relay: 0 };
  iceState: string | null = 'connected';
  private remote: FakeLink | null = null;
  private id = '';
  constructor(private readonly wire: Wire, readonly handlers: PeerTransportHandlers) {}
  // The page validates session descriptions in manual codes, so these look like real ones and carry the link's id.
  async createOffer() {
    this.id = `sdp-${this.wire.seq++}`;
    this.wire.offers.set(this.id, this);
    return `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fake-offer:${this.id}\r\n`;
  }
  async acceptOffer(sdp: string) {
    const offerer = this.wire.offers.get(/a=fake-offer:(\S+)/.exec(sdp)?.[1] ?? '');
    if (!offerer) throw new Error('unknown offer');
    this.remote = offerer;
    offerer.remote = this;
    setTimeout(() => {
      this.isOpen = true;
      offerer.isOpen = true;
      this.handlers.onOpen();
      offerer.handlers.onOpen();
    }, 5);
    return `v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fake-answer\r\n`;
  }
  async applyAnswer() {
    // The link opens when the answerer accepted.
  }
  sendText(text: string) {
    if (!this.isOpen || !this.remote) return false;
    const to = this.remote;
    setTimeout(() => to.handlers.onFrame(text), 1);
    return true;
  }
  async drain() {
    return this.isOpen;
  }
  async getStats() {
    return null;
  }
  close() {
    this.isOpen = false;
  }
}

/** A Bluetooth radio between two computers: a search from each side that names the same secret finds the other. */
class Air {
  readonly waiting = new Map<string, FakeBle>();
}
class FakeBle implements BleLike {
  isOpen = false;
  private remote: FakeBle | null = null;
  constructor(private readonly air: Air, readonly handlers: BleHandlers) {}
  async connect(secret: Uint8Array) {
    const key = [...secret].join(',');
    const other = this.air.waiting.get(key);
    if (!other) {
      this.air.waiting.set(key, this);
      return;
    }
    this.air.waiting.delete(key);
    this.remote = other;
    other.remote = this;
    setTimeout(() => {
      this.isOpen = true;
      other.isOpen = true;
      this.handlers.onOpen();
      other.handlers.onOpen();
    }, 5);
  }
  sendText(text: string) {
    if (!this.isOpen || !this.remote) return false;
    const to = this.remote;
    setTimeout(() => to.handlers.onFrame(text), 1);
    return true;
  }
  close() {
    this.isOpen = false;
  }
}

async function until<T>(what: string, check: () => T | undefined | false, ms = 25_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const PHRASES = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
];

interface Options {
  /** Are the relay sockets up? Without them friends can only meet by hand or by Bluetooth. */
  relay: boolean;
  /** Give each side a real identity (from a recovery phrase), so manual connection codes can be made. */
  withIdentity?: boolean;
}

async function makeSides(opts: Options) {
  const bus = new Bus();
  const wire = new Wire();
  const air = new Air();
  const sides: { name: string; bridge: EngineBridge; engine: HostedChatEngine; kill: () => void }[] = [];
  for (const [index, name] of ['Ann', 'Bob'].entries()) {
    const { bridge, kill } = stdioBridge();
    let identity: HostedDeps['identity'];
    let phrase: string | null = null;
    if (opts.withIdentity) {
      phrase = PHRASES[index]!;
      const d = await deriveIdentityFromPhrase(phrase, '');
      identity = {
        uid: await uidFromKeys(d.identity.signKey.pubJwk, d.identity.dhKey.pubJwk as never),
        deviceId: `device-${name}`,
        publicJwk: d.identity.signKey.pubJwk as JsonWebKey,
        dhPublicJwk: d.identity.dhKey.pubJwk as JsonWebKey,
        identityProof: d.identity.identityProof,
      };
    }
    const engine = new HostedChatEngine({
      bridge,
      network: () => DEFAULT_NETWORK_CONFIG,
      rtcConfig: () => ({}),
      ownName: () => name,
      onNotify: () => undefined,
      persistStoreForward: () => undefined,
      deleteSecret: async () => undefined,
      identity,
      context: 'duo',
      runtimeOverrides: {
        createHub: () => new BusHub(bus, opts.relay),
        createTransport: (_rtc, handlers) => new FakeLink(wire, handlers),
        createBle: async (handlers) => new FakeBle(air, handlers),
      },
    });
    await bridge.start();
    if (phrase) await bridge.invoke('recover_identity', { phrase, passphrase: '' });
    else await bridge.invoke('create_identity');
    await engine.start();
    sides.push({ name, bridge, engine, kill });
  }
  return { sides, stop: () => sides.forEach((s) => { s.engine.stop(); s.kill(); }) };
}

const befriend = async (a: HostedChatEngine, b: HostedChatEngine) => {
  const bobUid = await a.addContact(b.myInvite());
  const annUid = await b.addContact(a.myInvite());
  return { annUid, bobUid };
};

describe.skipIf(!present)('hosted engine end to end (real Rust engine, in-memory links)', () => {
  it('two people add each other, connect, and chat, send a file, and make a group, through the screens\' API', async () => {
    const { sides, stop } = await makeSides({ relay: true });
    const [ann, bob] = sides as [(typeof sides)[number], (typeof sides)[number]];
    try {
      expect(ann.engine.getState().phase).toBe('ready');
      expect(ann.engine.myInvite()).toMatch(/^DUOID1:/);

      // Add each other by invite text.
      const { annUid, bobUid } = await befriend(ann.engine, bob.engine);
      expect(bobUid).not.toBe(annUid);

      // They find each other (relay signals), open a link, and the engine says connected.
      await until('both sides connected', () =>
        ann.engine.getState().contacts[0]?.conn === 'connected' && bob.engine.getState().contacts[0]?.conn === 'connected');
      expect(ann.engine.getState().contacts[0]!.name).toBe('Bob');

      // A text message.
      const sent = await ann.engine.send(bobUid, 'hello bob');
      expect(sent).toEqual({ ok: true });
      await until('bob has the message', () => bob.engine.getState().messages[annUid]?.some((m) => m.text === 'hello bob'));
      await until('ann sees it delivered', () => ann.engine.getState().messages[bobUid]?.[0]?.tick === 'DELIVERED' || ann.engine.getState().messages[bobUid]?.[0]?.tick === 'READ');

      // A file, byte for byte.
      const bytes = Uint8Array.from({ length: 50_000 }, (_, i) => i % 251);
      expect(await ann.engine.sendFile(bobUid, { name: 'data.bin', mime: 'application/octet-stream', bytes })).toEqual({ ok: true });
      const fileMessage = await until('bob has the file', () => bob.engine.getState().messages[annUid]?.find((m) => m.type === 'file' && m.progress === undefined));
      const got = await bob.engine.getFile(fileMessage.messageId);
      expect(got?.meta.name).toBe('data.bin');
      expect(new Uint8Array(await got!.blob.arrayBuffer())).toEqual(bytes);

      // Search sees text.
      expect(bob.engine.search('hello').length).toBe(1);

      // Reactions work through the API.
      const target = bob.engine.getState().messages[annUid]!.find((m) => m.text === 'hello bob')!;
      bob.engine.react(target.messageId, '👍');
      await until('ann sees the reaction', () => ann.engine.getState().messages[bobUid]?.[0]?.reactionChips.length === 1);

      // A group with the friend.
      const groupId = await ann.engine.createGroup('Trip', [bobUid]);
      await until('bob is in the group', () => bob.engine.getState().groups.some((g) => g.groupId === groupId && g.status === 'member'));
      expect((await ann.engine.send(groupId, 'group hello')).ok).toBe(true);
      await until('bob has the group message', () => bob.engine.getState().messages[groupId]?.some((m) => m.text === 'group hello'));
    } finally {
      stop();
    }
  }, 90_000);

  it('connects by hand with manual codes when no relay is reachable', async () => {
    const { sides, stop } = await makeSides({ relay: false, withIdentity: true });
    const [ann, bob] = sides as [(typeof sides)[number], (typeof sides)[number]];
    try {
      const { annUid, bobUid } = await befriend(ann.engine, bob.engine);
      expect(ann.engine.getState().signaling).not.toBe('online'); // nothing can find anything: only the codes will do

      const offer = await ann.engine.createManualOffer(bobUid);
      expect(offer).toMatch(/^DUO1:/); // the format the old engine and the classic Android app use
      // A code is only for the friend it is for, and an offer is not an answer.
      await expect(ann.engine.applyManualAnswer(offer)).rejects.toThrow();
      const answer = await bob.engine.acceptManualOffer(offer);
      await ann.engine.applyManualAnswer(answer);

      await until('both sides connected', () =>
        ann.engine.getState().contacts[0]?.conn === 'connected' && bob.engine.getState().contacts[0]?.conn === 'connected');
      expect((await ann.engine.send(bobUid, 'by hand')).ok).toBe(true);
      await until('bob has it', () => bob.engine.getState().messages[annUid]?.some((m) => m.text === 'by hand'));
    } finally {
      stop();
    }
  }, 60_000);

  it('connects over Bluetooth with the engine\'s own encrypted handshake when there is no internet', async () => {
    const { sides, stop } = await makeSides({ relay: false });
    const [ann, bob] = sides as [(typeof sides)[number], (typeof sides)[number]];
    try {
      expect(await ann.engine.bluetoothAvailable()).toBe(true);
      const { annUid, bobUid } = await befriend(ann.engine, bob.engine);
      // Each side searches; the radio finds the other; the engine runs the layered handshake over it.
      await Promise.all([ann.engine.connectBluetooth(bobUid), bob.engine.connectBluetooth(annUid)]);
      await until('both sides connected over Bluetooth', () => {
        const a = ann.engine.getState().contacts[0];
        const b = bob.engine.getState().contacts[0];
        return a?.conn === 'connected' && b?.conn === 'connected' && a.path?.kind === 'bluetooth';
      });
      expect((await ann.engine.send(bobUid, 'over the air')).ok).toBe(true);
      await until('bob has it', () => bob.engine.getState().messages[annUid]?.some((m) => m.text === 'over the air'));
      await until('ann sees it delivered', () => ['DELIVERED', 'READ'].includes(ann.engine.getState().messages[bobUid]?.[0]?.tick ?? ''));
    } finally {
      stop();
    }
  }, 60_000);
});

describe.skipIf(!present)('moving the existing identity to the engine', () => {
  it('an identity made by the page derives to the very same user id inside the Rust engine', async () => {
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const derived = await deriveIdentityFromPhrase(phrase, '');
    const hex = legacySecretsHex({ privateJwk: derived.identity.signKey.privJwk, dhPrivateJwk: derived.identity.dhKey.privJwk });
    expect(hex).toHaveLength(128);
    const { bridge, kill } = stdioBridge(hex);
    try {
      await bridge.start();
      const snapshot = (await bridge.invoke('snapshot')) as { own_uid: string | null };
      // The id the app itself shows for this identity (the user id, not the recovery fingerprint).
      const appUid = await uidFromKeys(derived.identity.signKey.pubJwk, derived.identity.dhKey.pubJwk as never);
      expect(snapshot.own_uid).toBe(appUid);
      expect(appUid).toBe('d2360f62fee1f1d2679278d1799927888ca4f8692d0e294918be14cae4d5798a');
    } finally {
      kill();
    }
  });
});
