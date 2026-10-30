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

const PUT_TIMEOUT_MS = 8_000;

/** Talks to a self-hosted DuoChat relay (see /relay). */
export class RelayClient implements SignalingTransport {
  readonly name: string;
  private socket: WebSocket | null = null;
  private mailbox: string | null = null;
  private onBlob: ((blob: SealedBlob, id: string) => void) | null = null;
  private state: SignalingStatus = 'idle';
  private attempt = 0;
  private retryTimer: Timer | undefined;
  private stopped = true;
  private lastSeen = 0;
  private pending = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: Timer }>();

  constructor(
    private readonly url: string,
    private readonly makeSocket: WebSocketFactory = defaultSocketFactory,
  ) {
    this.name = `relay ${url}`;
  }

  start(mailbox: string, onBlob: (blob: SealedBlob, id: string) => void): void {
    this.mailbox = mailbox;
    this.onBlob = onBlob;
    this.stopped = false;
    this.connect();
  }

  status(): SignalingStatus {
    return this.state;
  }

  private connect(): void {
    if (this.stopped) return;
    this.state = 'connecting';
    let socket: WebSocket;
    try {
      socket = this.makeSocket(this.url);
    } catch {
      this.state = 'error';
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.state = 'online';
      socket.send(JSON.stringify({ op: 'sub', mailbox: this.mailbox, since: this.lastSeen }));
    };
    socket.onmessage = (event) => this.handle(String(event.data));
    socket.onerror = () => {
      this.state = 'error';
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.state = this.stopped ? 'idle' : 'error';
      this.failPending(new Error('Relay connection closed.'));
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    globalThis.clearTimeout(this.retryTimer);
    this.retryTimer = globalThis.setTimeout(() => this.connect(), socketBackoff(this.attempt++));
  }

  private handle(raw: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.op === 'event' && typeof frame.blob === 'string' && typeof frame.id === 'string') {
      const blob = decodeBlob(frame.blob);
      if (typeof frame.ts === 'number') this.lastSeen = Math.max(this.lastSeen, frame.ts);
      if (blob) this.onBlob?.(blob, frame.id);
      return;
    }
    if ((frame.op === 'ok' || frame.op === 'err') && typeof frame.id === 'string') {
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      globalThis.clearTimeout(waiter.timer);
      this.pending.delete(frame.id);
      if (frame.op === 'ok') waiter.resolve();
      else waiter.reject(new Error(String(frame.reason ?? 'Relay refused the message.')));
    }
  }

  private failPending(error: Error): void {
    for (const waiter of this.pending.values()) {
      globalThis.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  put(mailbox: string, blob: SealedBlob, opts: PutOptions): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Relay is not connected.'));
    }
    const id = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Relay did not answer.'));
      }, PUT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ op: 'put', mailbox, id, blob: encodeBlob(blob), ttl: opts.ttlSec, kind: opts.kind }));
    });
  }

  remove(mailbox: string, id: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ op: 'del', mailbox, id }));
    }
  }

  stop(): void {
    this.stopped = true;
    globalThis.clearTimeout(this.retryTimer);
    this.failPending(new Error('Stopped.'));
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    this.state = 'idle';
  }
}
