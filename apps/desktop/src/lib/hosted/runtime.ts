/**
 * The page-side adapters for the hosted Rust engine: WebRTC links and the relay (Nostr) sockets. The engine decides who to
 * talk to and what to say; this file opens the radios and does it. It mirrors the Android `RustChatEngine` adapter, including
 * what that one learned the hard way:
 *
 *  - frames go OUT per friend in order, waiting while the data channel's buffer is full (a photo is hundreds of frames);
 *  - frames come IN to the engine strictly in order (see `HostedEngine`);
 *  - a relay `put` waits for a socket that is online instead of failing while the sockets are still opening;
 *  - a dial that could not have worked (relays not online yet) does not use up the engine's retry delay, and the dial is
 *    repeated the moment the relays come online.
 */
import {
  classifyPath,
  decodeBlob,
  encodeBlob,
  mailboxFor,
  selectedPairFromStats,
  type NetworkConfig,
} from '@duochat/protocol';
import { HostedEngine, type PathName } from '../engineBridge';
import { BleTransport, type BleHandlers } from '../ble';
import { getBleBridge } from '../bleLink';
import { PeerTransport, type PeerTransportHandlers } from '../p2p';
import { SignalingHub, transportsFor } from '../signaling/hub';
import type { SignalingStatus } from '../signaling/types';
import type { LinkFacts } from './shape';

/** What the runtime needs from a WebRTC link (`PeerTransport` is one; tests use a fake). */
export interface LinkTransport {
  readonly isOpen: boolean;
  candidates: { host: number; srflx: number; relay: number } | null;
  iceState: string | null;
  createOffer(): Promise<string>;
  acceptOffer(sdp: string): Promise<string>;
  applyAnswer(sdp: string): Promise<void>;
  sendText(text: string): boolean;
  drain(highWater?: number, timeoutMs?: number): Promise<boolean>;
  getStats(): Promise<RTCStatsReport | null>;
  close(): void;
}

/** What the runtime needs from a Bluetooth link (`BleTransport` is one; tests use a fake). */
export interface BleLike {
  readonly isOpen: boolean;
  connect(secret: Uint8Array, timeoutSecs?: number): Promise<void>;
  sendText(text: string): boolean;
  close(): void;
}

/** What the runtime needs from the relay sockets of one mailbox (`SignalingHub` is one). */
export interface RelayHub {
  start(mailbox: string, onBlob: (blob: ReturnType<typeof decodeBlob> & object) => void): void;
  put(mailbox: string, blob: ReturnType<typeof decodeBlob> & object, opts: { kind: 'sig' | 'msg'; ttlSec: number }): Promise<void>;
  status(): SignalingStatus;
  stop(): void;
}

export interface RuntimeOptions {
  engine: HostedEngine;
  network: () => NetworkConfig;
  rtcConfig: () => RTCConfiguration;
  /** Something changed that the screens show: build the state again. */
  changed: () => void;
  createTransport?: (rtc: RTCConfiguration, handlers: PeerTransportHandlers) => LinkTransport;
  createHub?: (network: NetworkConfig) => RelayHub;
  /** A Bluetooth link, or null when this computer has no Bluetooth the app can use. */
  createBle?: (handlers: BleHandlers) => Promise<BleLike | null>;
  now?: () => number;
}

const OFFER_TIMEOUT_MS = 25_000;
const READY_GUARD_MS = 8_000;
const PUT_WAIT_MS = 30_000;
const PUT_RETRY_MS = 100;

interface Link {
  transport: LinkTransport;
  startedAt: number;
  /** Frames the engine wants sent, in order. */
  outbound: string[];
  writing: boolean;
  closing: boolean;
  /** Made by hand (manual connection codes): automatic dialing leaves it alone while it waits for the other side. */
  manual: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const STALLED_INCOMING_MS = 90_000;

const PATH_NAMES: Record<string, PathName> = {
  'direct-lan': 'direct_lan',
  'direct-nat': 'direct_nat',
  relayed: 'relayed',
  bluetooth: 'bluetooth',
  unknown: 'unknown',
};

export class HostedRuntime {
  private readonly links = new Map<string, Link>();
  private readonly hubs = new Map<string, RelayHub>();
  private readonly attempts = new Map<string, number>();
  private readonly heard = new Set<string>();
  private readonly ble = new Map<string, BleLike>();
  private bleBusy = false;
  private readonly bleNext = new Map<string, { at: number; attempt: number }>();
  private readonly unsubscribe: (() => void)[] = [];
  private ownUid = '';
  private stopped = false;
  private wasOnline = false;
  private watcher: ReturnType<typeof setInterval> | null = null;

  /** 0..1 for files being sent or received, by message id (read by the state shaper). */
  readonly progress = new Map<string, number>();
  readonly incoming = new Map<string, { conversation: string; sender: string; name: string; size: number; since: number; moved: number }>();
  /** Per outgoing file transfer: how many frames it is, and the queued-frame count at which it is complete. */
  private readonly sending = new Map<string, { peer: string; frames: number; end: number }>();
  private readonly written = new Map<string, number>();
  private readonly queuedTotal = new Map<string, number>();

  constructor(private readonly o: RuntimeOptions) {}

  setOwnUid(uid: string): void {
    if (uid && uid !== this.ownUid) void this.listenOnOwnMailbox(uid);
    this.ownUid = uid;
  }

  /**
   * The engine subscribes to our own mailbox as soon as it starts, which can be before the page is listening to its events
   * (an event nobody heard is gone). Everything friends send us arrives there, so the page opens it on its own, from the
   * same derivation the engine uses. Opening it again when the engine's event arrives is harmless.
   */
  private async listenOnOwnMailbox(uid: string): Promise<void> {
    const mailbox = await mailboxFor(uid);
    if (!this.stopped && !this.hubs.has(mailbox)) this.subscribe(mailbox);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Start listening to what the engine asks for. */
  async attach(): Promise<void> {
    const on = async (event: string, handler: (payload: never) => void) => {
      this.unsubscribe.push(await this.o.engine.on(event, handler as (payload: unknown) => void));
    };
    await on('event', (e: unknown) => this.onEngineEvent(e));
    await on('frame', (p: { peer: string; frame: string }) => this.onFrame(p.peer, p.frame));
    await on('close', (p: { peer: string }) => {
      this.closeLink(p.peer, true);
      this.ble.get(p.peer)?.close();
    });
    // Idempotent: the engine subscribes again whenever signaling comes back, and reopening a socket that is already open
    // would take it offline and start that over.
    await on('signal-subscribe', (p: { mailbox: string }) => {
      if (!this.hubs.has(p.mailbox)) this.subscribe(p.mailbox);
    });
    await on('signal-unsubscribe', (p: { mailbox: string }) => this.unsubscribeMailbox(p.mailbox));
    await on('signal-put', (p: { mailbox: string; blob: string; kind: string; ttlSec: number }) => void this.put(p));
    // Dial everyone the moment the relays come online instead of waiting out the engine's retry delay.
    this.watcher = setInterval(() => this.checkOnline(), 1_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.watcher) clearInterval(this.watcher);
    for (const off of this.unsubscribe.splice(0)) off();
    for (const link of this.links.values()) link.transport.close();
    this.links.clear();
    for (const b of this.ble.values()) b.close();
    this.ble.clear();
    for (const hub of this.hubs.values()) hub.stop();
    this.hubs.clear();
  }

  /* ------------------------------------------------------------------ what the screens ask about */

  signalingStatus(): SignalingStatus {
    const states = [...this.hubs.values()].map((h) => h.status());
    if (states.includes('online')) return 'online';
    if (states.includes('connecting')) return 'connecting';
    return states.length === 0 ? 'idle' : 'error';
  }

  factsFor(uid: string): LinkFacts | undefined {
    const attempts = this.attempts.get(uid);
    if (!attempts) return undefined;
    const link = this.links.get(uid);
    return {
      attempts,
      sawPeerReply: this.heard.has(uid),
      localCandidates: link?.transport.candidates ?? null,
      iceState: link?.transport.iceState ?? null,
    };
  }

  /** The network settings changed: reopen the relay sockets of every mailbox with the new settings. */
  reloadNetwork(): void {
    for (const mailbox of [...this.hubs.keys()]) this.subscribe(mailbox);
  }

  isOpen(uid: string): boolean {
    return this.links.get(uid)?.transport.isOpen === true;
  }

  /* ------------------------------------------------------------------ Bluetooth */

  async bluetoothAvailable(): Promise<boolean> {
    if (this.o.createBle) return (await this.o.createBle({ onOpen() {}, onClose() {}, onFrame() {}, onError() {} })) !== null;
    return (await getBleBridge()) !== null;
  }

  /** Search for one friend over Bluetooth (no internet needed, within radio range). The engine runs the encrypted handshake. */
  async connectBluetooth(peer: string): Promise<void> {
    if (this.isOpen(peer) || this.ble.get(peer)?.isOpen) return;
    if (this.bleBusy) throw new Error('Already searching over Bluetooth.');
    let link: BleLike | null = null;
    const handlers: BleHandlers = {
      onOpen: () => {
        if (!link) return;
        this.ble.set(peer, link);
        // Bluetooth is not encrypted: the engine does the secure-channel handshake itself ("layered").
        void this.o.engine.linkUp(peer, 'bluetooth', 'layered').catch(() => undefined);
        this.o.changed();
      },
      onClose: () => {
        if (this.ble.get(peer) !== link) return;
        this.ble.delete(peer);
        if (!this.stopped) void this.o.engine.linkDown(peer).catch(() => undefined);
        this.o.changed();
      },
      onFrame: (data) => void this.o.engine.frameReceived(peer, data).catch(() => undefined),
      onError: () => undefined,
    };
    link = this.o.createBle
      ? await this.o.createBle(handlers)
      : await getBleBridge().then((bridge) => (bridge ? new BleTransport(bridge, handlers) : null));
    if (!link) throw new Error('Bluetooth is not available in this build or on this computer.');
    this.bleBusy = true;
    try {
      const secretHex = await this.o.engine.call<string>('ble_secret', { peer });
      await link.connect(Uint8Array.from(secretHex.match(/../g) ?? [], (h) => Number.parseInt(h, 16)));
    } catch (error) {
      link.close();
      throw error;
    } finally {
      this.bleBusy = false;
    }
  }

  /** The engine asked for a dial: try Bluetooth too (one search at a time, backing off), as the old engine did. */
  private maybeBluetooth(peer: string): void {
    if (!this.o.network().bluetooth || this.bleBusy || this.ble.get(peer)?.isOpen || this.isOpen(peer)) return;
    const now = this.now();
    const next = this.bleNext.get(peer) ?? { at: 0, attempt: 0 };
    if (now < next.at) return;
    this.bleNext.set(peer, { at: now + Math.min(120_000, 15_000 * 2 ** Math.min(next.attempt, 3)), attempt: next.attempt + 1 });
    void this.connectBluetooth(peer).catch(() => undefined); // not in range / not available: the next try backs off further
  }

  /* ------------------------------------------------------------------ manual connection codes */

  /** Start a link by hand: the offer to send to the friend. */
  async manualOffer(peer: string): Promise<string> {
    const link = this.newLink(peer);
    link.manual = true;
    try {
      return await link.transport.createOffer();
    } catch (error) {
      this.closeLink(peer, false);
      throw error;
    }
  }

  /** The friend's offer, answered by hand: the answer to send back. */
  async manualAccept(peer: string, sdp: string): Promise<string> {
    const link = this.newLink(peer);
    link.manual = true;
    try {
      return await link.transport.acceptOffer(sdp);
    } catch (error) {
      this.closeLink(peer, false);
      throw error;
    }
  }

  /** The friend's answer to our offer. */
  async manualApply(peer: string, sdp: string): Promise<void> {
    const link = this.links.get(peer);
    if (!link) throw new Error('There is no offer waiting for that friend. Start again from "Make an offer".');
    await link.transport.applyAnswer(sdp);
  }

  cancelManual(): void {
    for (const [peer, link] of [...this.links]) if (link.manual && !link.transport.isOpen) this.closeLink(peer, false);
  }

  /* ------------------------------------------------------------------ engine events */

  /** Engine events are serde JSON: unit variants are strings (`"Ready"`), the others `{ Name: {..} }`. */
  private onEngineEvent(event: unknown): void {
    if (typeof event === 'object' && event !== null) {
      const e = event as Record<string, Record<string, unknown>>;
      if (e.DialRequested) void this.dial(String(e.DialRequested.peer), e.DialRequested.initiator === true);
      else if (e.SignalReceived) void this.onSignal(String(e.SignalReceived.peer), String(e.SignalReceived.kind), (e.SignalReceived.sdp as string | null) ?? null);
      else if (e.FileProgress) {
        const id = String(e.FileProgress.message_id);
        const percent = Number(e.FileProgress.percent);
        if (percent >= 100) {
          this.progress.delete(id);
          this.incoming.delete(id);
        } else {
          this.progress.set(id, percent / 100);
          // Still moving: a placeholder is only dropped when it has stalled (see checkOnline).
          const f = this.incoming.get(id);
          if (f) f.moved = this.now();
        }
      } else if (e.FileIncoming) {
        const id = String(e.FileIncoming.message_id);
        const conversation = String(e.FileIncoming.conversation);
        this.incoming.set(id, {
          conversation,
          sender: conversation.replace(/^chan:/, ''),
          name: String(e.FileIncoming.name),
          size: Number(e.FileIncoming.size),
          since: this.now(),
          moved: this.now(),
        });
        if (!this.progress.has(id)) this.progress.set(id, 0);
      } else if (e.FileQueued) {
        const peer = String(e.FileQueued.peer);
        const id = String(e.FileQueued.message_id);
        const frames = Math.max(1, Number(e.FileQueued.frames));
        this.sending.set(id, { peer, frames, end: this.queuedTotal.get(peer) ?? 0 });
        this.showSendProgress(id);
      } else if (e.MessageAdded) {
        // The last chunk is the file arriving whole: the real message replaces its bubble.
        this.incoming.delete(String(e.MessageAdded.message_id));
        this.progress.delete(String(e.MessageAdded.message_id));
      }
    }
    this.o.changed();
  }

  /* ------------------------------------------------------------------ WebRTC links */

  private isInitiator(peer: string): boolean {
    return this.ownUid < peer;
  }

  private hubsOnline(): boolean {
    return this.signalingStatus() === 'online';
  }

  private async dial(peer: string, initiator: boolean): Promise<void> {
    if (this.stopped) return;
    this.maybeBluetooth(peer);
    const waiting = this.links.get(peer);
    if (waiting?.manual && !waiting.transport.isOpen) return; // a code is out: leave it alone
    if (!this.hubsOnline()) {
      // The relays are not up yet, so this try could not have worked. Do not let it count against the retry delay: the
      // engine asks again at its next tick, and `checkOnline` dials the moment the relays are up.
      void this.o.engine.call('reset_dial_backoff', { peer }).catch(() => undefined);
      return;
    }
    const existing = this.links.get(peer);
    const now = this.now();
    if (existing && !existing.transport.isOpen && now - existing.startedAt < OFFER_TIMEOUT_MS) return;
    this.attempts.set(peer, (this.attempts.get(peer) ?? 0) + 1);
    if (initiator) await this.offer(peer);
    else await this.send_signal(peer, 'ready');
  }

  private async send_signal(peer: string, kind: 'ready' | 'offer' | 'answer', sdp?: string): Promise<void> {
    await this.o.engine.call('send_signal', { peer, kind, sdp }).catch(() => undefined);
  }

  private newLink(peer: string): Link {
    this.closeLink(peer, false);
    const handlers: PeerTransportHandlers = {
      onOpen: () => void this.opened(peer),
      onClose: () => this.closeLink(peer, true),
      onFrame: (data) => void this.o.engine.frameReceived(peer, data).catch(() => undefined),
      onStateChange: () => this.o.changed(),
      onError: () => undefined,
    };
    const rtc = this.o.rtcConfig();
    const transport = this.o.createTransport ? this.o.createTransport(rtc, handlers) : new PeerTransport(rtc, handlers);
    const link: Link = { transport, startedAt: this.now(), outbound: [], writing: false, closing: false, manual: false };
    this.links.set(peer, link);
    return link;
  }

  private async offer(peer: string): Promise<void> {
    const link = this.newLink(peer);
    try {
      const sdp = await link.transport.createOffer();
      await this.send_signal(peer, 'offer', sdp);
    } catch {
      this.closeLink(peer, false);
    }
  }

  private async onSignal(peer: string, kind: string, sdp: string | null): Promise<void> {
    this.heard.add(peer);
    const manual = this.links.get(peer);
    if (manual?.manual && !manual.transport.isOpen && kind !== 'Answer') return;
    if (kind === 'Ready') {
      // They are online right now: forget the retry delay for this friend and offer without waiting.
      void this.o.engine.call('reset_dial_backoff', { peer }).catch(() => undefined);
      const existing = this.links.get(peer);
      const busy = existing && !existing.transport.isOpen && this.now() - existing.startedAt < READY_GUARD_MS;
      if (this.isInitiator(peer) && !busy) await this.offer(peer);
    } else if (kind === 'Offer' && sdp) {
      const link = this.newLink(peer);
      try {
        await this.send_signal(peer, 'answer', await link.transport.acceptOffer(sdp));
      } catch {
        this.closeLink(peer, false);
      }
    } else if (kind === 'Answer' && sdp) {
      await this.links.get(peer)?.transport.applyAnswer(sdp).catch(() => undefined);
    }
  }

  private async opened(peer: string): Promise<void> {
    const link = this.links.get(peer);
    if (!link) return;
    this.attempts.delete(peer);
    link.manual = false;
    // Open the link in the engine at once; how it is routed (direct, relayed) is found out in the background.
    await this.o.engine.linkUp(peer, 'unknown', 'encrypted').catch(() => undefined);
    this.o.changed();
    void this.measurePath(peer, link);
  }

  private async measurePath(peer: string, link: Link): Promise<void> {
    try {
      const stats = await link.transport.getStats();
      const pair = stats ? selectedPairFromStats(stats as never) : null;
      const path = pair ? classifyPath(pair.local, pair.remote) : classifyPath('unknown', 'unknown');
      await this.o.engine.call('set_link_path', { peer, path: PATH_NAMES[path.kind] ?? 'unknown' });
      this.o.changed();
    } catch {
      // The path stays "unknown"; the link itself works.
    }
  }

  private closeLink(peer: string, tellEngine: boolean): void {
    const link = this.links.get(peer);
    if (!link || link.closing) return;
    link.closing = true;
    this.links.delete(peer);
    link.transport.close();
    // A transfer cut by the link going down is not coming back as it was: its half-file bubble goes.
    // Frames still queued for this friend are gone with the link: count them as done so later progress bars can reach 100%.
    this.queuedTotal.set(peer, this.written.get(peer) ?? 0);
    for (const [id, f] of this.incoming) if (f.conversation === peer) {
      this.incoming.delete(id);
      this.progress.delete(id);
    }
    for (const [id, s] of this.sending) if (s.peer === peer) {
      this.sending.delete(id);
      this.progress.delete(id);
    }
    if (tellEngine && !this.stopped) void this.o.engine.linkDown(peer).catch(() => undefined);
    this.o.changed();
  }

  /** A frame the engine wants sent: queued per friend and written in order, waiting while the channel's buffer is full. */
  private onFrame(peer: string, frame: string): void {
    const link = this.links.get(peer);
    const ble = this.ble.get(peer);
    if (ble?.isOpen && !link?.transport.isOpen) {
      // Bluetooth is the link that is up: the frame goes out in radio-sized chunks, in order.
      if (!ble.sendText(frame)) ble.close();
      return;
    }
    if (!link) return;
    link.outbound.push(frame);
    this.queuedTotal.set(peer, (this.queuedTotal.get(peer) ?? 0) + 1);
    void this.writeOut(peer, link);
  }

  private async writeOut(peer: string, link: Link): Promise<void> {
    if (link.writing) return;
    link.writing = true;
    try {
      while (link.outbound.length > 0 && !link.closing) {
        if (!(await link.transport.drain(1_000_000, 60_000))) {
          this.closeLink(peer, true);
          return;
        }
        const frame = link.outbound.shift() as string;
        if (!link.transport.sendText(frame)) {
          this.closeLink(peer, true);
          return;
        }
        this.written.set(peer, (this.written.get(peer) ?? 0) + 1);
        this.sendProgressFor(peer);
      }
    } finally {
      link.writing = false;
    }
  }

  private sendProgressFor(peer: string): void {
    for (const [id, s] of this.sending) if (s.peer === peer) this.showSendProgress(id);
  }

  private showSendProgress(id: string): void {
    const s = this.sending.get(id);
    if (!s) return;
    const left = Math.max(0, s.end - (this.written.get(s.peer) ?? 0));
    if (left === 0) {
      this.sending.delete(id);
      this.progress.delete(id);
    } else this.progress.set(id, Math.min(0.99, (s.frames - left) / s.frames));
    this.o.changed();
  }

  /* ------------------------------------------------------------------ relay sockets (one hub per mailbox) */

  private subscribe(mailbox: string): void {
    this.hubs.get(mailbox)?.stop();
    const net = this.o.network();
    const hub = this.o.createHub ? this.o.createHub(net) : (new SignalingHub(transportsFor(net)) as unknown as RelayHub);
    this.hubs.set(mailbox, hub);
    hub.start(mailbox, (blob) => void this.o.engine.signalBlob(mailbox, encodeBlob(blob as never)).catch(() => undefined));
    this.o.changed();
  }

  private unsubscribeMailbox(mailbox: string): void {
    this.hubs.get(mailbox)?.stop();
    this.hubs.delete(mailbox);
  }

  /** Publish a blob: right after start (or a network change) the sockets are still opening, so wait for one that is online. */
  private async put(p: { mailbox: string; blob: string; kind: string; ttlSec: number }): Promise<void> {
    const blob = decodeBlob(p.blob);
    if (!blob) return;
    const deadline = this.now() + PUT_WAIT_MS;
    const opts = { kind: p.kind === 'stored' ? ('msg' as const) : ('sig' as const), ttlSec: p.ttlSec };
    while (!this.stopped && this.now() < deadline) {
      const hub = this.hubs.get(p.mailbox) ?? [...this.hubs.values()].find((h) => h.status() === 'online');
      if (hub && hub.status() === 'online') {
        try {
          await hub.put(p.mailbox, blob as never, opts);
          return;
        } catch {
          // Try again until the deadline.
        }
      }
      await sleep(PUT_RETRY_MS);
    }
  }

  private checkOnline(): void {
    // A file that stopped arriving (its sender's link dropped; for a group file the event does not say who that was) leaves
    // no half-finished bubble behind: a placeholder with no progress for this long goes.
    let dropped = false;
    for (const [id, f] of this.incoming) {
      if (this.now() - f.moved > STALLED_INCOMING_MS) {
        this.incoming.delete(id);
        this.progress.delete(id);
        dropped = true;
      }
    }
    if (dropped) this.o.changed();
    const online = this.hubsOnline();
    if (online && !this.wasOnline) {
      void this.o.engine.call('reset_dial_backoff', {}).catch(() => undefined);
      this.o.changed();
    }
    if (online !== this.wasOnline) {
      void this.o.engine.signalStatus(online).catch(() => undefined);
      this.o.changed();
    }
    this.wasOnline = online;
  }
}
