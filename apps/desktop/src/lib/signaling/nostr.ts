import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeBlob, encodeBlob, type SealedBlob } from '@duochat/protocol';
import {
  defaultSocketFactory,
  socketBackoff,
  type PutOptions,
  type SignalingStatus,
  type SignalingTransport,
  type WebSocketFactory,
} from './types';

type Timer = ReturnType<typeof setTimeout>;

export const NOSTR_KIND_SIGNAL = 21733; // ephemeral range: relays do not store it
export const NOSTR_KIND_MESSAGE = 31733; // parameterized replaceable range: relays store it

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

const enc = new TextEncoder();

export function eventId(e: Omit<NostrEvent, 'id' | 'sig'>): string {
  return bytesToHex(sha256(enc.encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
}

/** Build an event signed with a fresh throwaway key, so events cannot be linked to the DuoChat identity. */
export function makeEvent(mailbox: string, blob: SealedBlob, opts: PutOptions, now = Math.floor(Date.now() / 1000)): NostrEvent {
  const sk = schnorr.utils.randomSecretKey();
  const base = {
    pubkey: bytesToHex(schnorr.getPublicKey(sk)),
    created_at: now,
    kind: opts.kind === 'sig' ? NOSTR_KIND_SIGNAL : NOSTR_KIND_MESSAGE,
    tags: [
      ['t', mailbox],
      // `d` makes every stored message its own addressable event instead of replacing the last one.
      ['d', crypto.randomUUID()],
      ['expiration', String(now + opts.ttlSec)],
    ],
    content: encodeBlob(blob),
  };
  const id = eventId(base);
  return { ...base, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
}

export function verifyEvent(e: NostrEvent): boolean {
  try {
    if (typeof e.content !== 'string' || !Array.isArray(e.tags)) return false;
    if (eventId(e) !== e.id) return false;
    return schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    return false;
  }
}

interface Link {
  socket: WebSocket | null;
  attempt: number;
  timer: Timer | undefined;
}

/** Signaling and mailboxes over public Nostr relays: decentralized, nothing to host. */
export class NostrTransport implements SignalingTransport {
  readonly name = 'nostr';
  private links = new Map<string, Link>();
  private mailbox: string | null = null;
  private onBlob: ((blob: SealedBlob, id: string) => void) | null = null;
  private stopped = true;
  private seen = new Set<string>();
  private subId = `duo-${Math.random().toString(36).slice(2, 10)}`;

  constructor(
    private readonly relays: string[],
    private readonly makeSocket: WebSocketFactory = defaultSocketFactory,
  ) {}

  start(mailbox: string, onBlob: (blob: SealedBlob, id: string) => void): void {
    this.mailbox = mailbox;
    this.onBlob = onBlob;
    this.stopped = false;
    for (const url of this.relays) {
      this.links.set(url, { socket: null, attempt: 0, timer: undefined });
      this.open(url);
    }
  }

  status(): SignalingStatus {
    if (this.stopped) return 'idle';
    let connecting = false;
    for (const link of this.links.values()) {
      if (link.socket?.readyState === WebSocket.OPEN) return 'online';
      if (link.socket?.readyState === WebSocket.CONNECTING) connecting = true;
    }
    return connecting ? 'connecting' : 'error';
  }

  private open(url: string): void {
    const link = this.links.get(url);
    if (!link || this.stopped) return;
    let socket: WebSocket;
    try {
      socket = this.makeSocket(url);
    } catch {
      this.retry(url);
      return;
    }
    link.socket = socket;
    socket.onopen = () => {
      link.attempt = 0;
      const since = Math.floor(Date.now() / 1000) - 120;
      socket.send(
        JSON.stringify(['REQ', this.subId, { kinds: [NOSTR_KIND_SIGNAL, NOSTR_KIND_MESSAGE], '#t': [this.mailbox], since }]),
      );
    };
    socket.onmessage = (event) => this.handle(String(event.data));
    socket.onclose = () => {
      link.socket = null;
      this.retry(url);
    };
    socket.onerror = () => undefined;
  }

  private retry(url: string): void {
    const link = this.links.get(url);
    if (!link || this.stopped) return;
    globalThis.clearTimeout(link.timer);
    link.timer = globalThis.setTimeout(() => this.open(url), socketBackoff(link.attempt++));
  }

  private handle(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || frame[0] !== 'EVENT' || frame[1] !== this.subId) return;
    const event = frame[2] as NostrEvent;
    if (!event || this.seen.has(event.id) || !verifyEvent(event)) return;
    if (!event.tags.some((t) => t[0] === 't' && t[1] === this.mailbox)) return;
    const expiry = event.tags.find((t) => t[0] === 'expiration')?.[1];
    if (expiry !== undefined && Number(expiry) < Date.now() / 1000) return;
    this.seen.add(event.id);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value as string);
    const blob = decodeBlob(event.content);
    if (blob) this.onBlob?.(blob, event.id);
  }

  async put(mailbox: string, blob: SealedBlob, opts: PutOptions): Promise<void> {
    const event = makeEvent(mailbox, blob, opts);
    const payload = JSON.stringify(['EVENT', event]);
    let sent = 0;
    for (const link of this.links.values()) {
      if (link.socket?.readyState === WebSocket.OPEN) {
        link.socket.send(payload);
        sent += 1;
      }
    }
    if (sent === 0) throw new Error('No Nostr relay is connected.');
  }

  remove(): void {
    // Nostr relays cannot delete on our behalf; the expiration tag bounds retention.
  }

  stop(): void {
    this.stopped = true;
    for (const link of this.links.values()) {
      globalThis.clearTimeout(link.timer);
      const socket = link.socket;
      link.socket = null;
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    }
    this.links.clear();
  }
}
