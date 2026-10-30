import type { SealedBlob } from '@duochat/protocol';

export type SignalingStatus = 'idle' | 'connecting' | 'online' | 'error';

export interface PutOptions {
  /** `sig`: short-lived live signaling. `msg`: held for an offline contact. */
  kind: 'sig' | 'msg';
  ttlSec: number;
}

/**
 * A replaceable way to move sealed blobs between two contacts. It never sees
 * plaintext: blobs are encrypted to the recipient and signed by the sender.
 */
export interface SignalingTransport {
  readonly name: string;
  start(mailbox: string, onBlob: (blob: SealedBlob, id: string) => void): void;
  put(mailbox: string, blob: SealedBlob, opts: PutOptions): Promise<void>;
  /** Tell the relay a stored item was handled. No-op where the backend cannot delete. */
  remove(mailbox: string, id: string): void;
  status(): SignalingStatus;
  stop(): void;
}

export type WebSocketFactory = (url: string) => WebSocket;

export const defaultSocketFactory: WebSocketFactory = (url) => new WebSocket(url);

/** Reconnect delays for a dropped relay socket (ms). */
export function socketBackoff(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
}
