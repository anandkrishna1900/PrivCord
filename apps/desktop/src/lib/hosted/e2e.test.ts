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
import { DEFAULT_NETWORK_CONFIG, deriveIdentityFromPhrase, uidFromDh, type SealedBlob } from '@duochat/protocol';
import { legacySecretsHex } from './legacyIdentity';
import type { EngineBridge } from '../engineBridge';
import type { PeerTransportHandlers } from '../p2p';
import { HostedChatEngine } from './hostedEngine';
import type { LinkTransport, RelayHub } from './runtime';

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
  constructor(private readonly bus: Bus) {
    bus.hubs.add(this);
  }
  start(mailbox: string, onBlob: (blob: SealedBlob) => void) {
    this.mailboxes.set(mailbox, onBlob);
  }
  async put(mailbox: string, blob: SealedBlob) {
    for (const hub of this.bus.hubs) if (hub !== this) setTimeout(() => hub.mailboxes.get(mailbox)?.(blob), 5);
  }
  status() {
    return 'online' as const;
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
  async createOffer() {
    this.id = `sdp-${this.wire.seq++}`;
    this.wire.offers.set(this.id, this);
    return this.id;
  }
  async acceptOffer(sdp: string) {
    const offerer = this.wire.offers.get(sdp);
    if (!offerer) throw new Error('unknown offer');
    this.remote = offerer;
    offerer.remote = this;
    setTimeout(() => {
      this.isOpen = true;
      offerer.isOpen = true;
      this.handlers.onOpen();
      offerer.handlers.onOpen();
    }, 5);
    return `answer-${sdp}`;
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

async function until<T>(what: string, check: () => T | undefined | false, ms = 25_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!present)('hosted engine end to end (real Rust engine, in-memory links)', () => {
  it('two people add each other, connect, and chat, send a file, and make a group, through the screens\' API', async () => {
    const bus = new Bus();
    const wire = new Wire();
    const sides = ['Ann', 'Bob'].map((name) => {
      const { bridge, kill } = stdioBridge();
      const engine = new HostedChatEngine({
        bridge,
        network: () => DEFAULT_NETWORK_CONFIG,
        rtcConfig: () => ({}),
        ownName: () => name,
        onNotify: () => undefined,
        persistStoreForward: () => undefined,
        deleteSecret: async () => undefined,
        runtimeOverrides: {
          createHub: () => new BusHub(bus),
          createTransport: (_rtc, handlers) => new FakeLink(wire, handlers),
        },
      });
      return { name, bridge, engine, kill };
    });
    const [ann, bob] = sides as [(typeof sides)[number], (typeof sides)[number]];
    try {
      for (const s of sides) {
        await s.bridge.start();
        await s.bridge.invoke('create_identity');
        await s.engine.start();
      }
      expect(ann.engine.getState().phase).toBe('ready');
      expect(ann.engine.myInvite()).toMatch(/^DUOID1:/);

      // Add each other by invite text.
      const bobUid = await ann.engine.addContact(bob.engine.myInvite());
      const annUid = await bob.engine.addContact(ann.engine.myInvite());
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

      // Reactions and delete work through the API.
      const target = bob.engine.getState().messages[annUid]!.find((m) => m.text === 'hello bob')!;
      bob.engine.react(target.messageId, '👍');
      await until('ann sees the reaction', () => ann.engine.getState().messages[bobUid]?.[0]?.reactionChips.length === 1);

      // A group with the friend.
      const groupId = await ann.engine.createGroup('Trip', [bobUid]);
      await until('bob is in the group', () => bob.engine.getState().groups.some((g) => g.groupId === groupId && g.status === 'member'));
      expect((await ann.engine.send(groupId, 'group hello')).ok).toBe(true);
      await until('bob has the group message', () => bob.engine.getState().messages[groupId]?.some((m) => m.text === 'group hello'));
    } finally {
      for (const s of sides) {
        s.engine.stop();
        s.kill();
      }
    }
  }, 90_000);
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
      const appUid = await uidFromDh(derived.identity.dhKey.pubJwk as never);
      expect(snapshot.own_uid).toBe(appUid);
      expect(appUid).toBe('bf9861c45fd771142637ca6a8ec6b22ba848e4f0758311f9b173bc546aae65de');
    } finally {
      kill();
    }
  });
});
