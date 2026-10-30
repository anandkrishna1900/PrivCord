import type { NetworkConfig, SealedBlob } from '@duochat/protocol';
import { NostrTransport } from './nostr';
import { RelayClient } from './relayClient';
import type { PutOptions, SignalingStatus, SignalingTransport } from './types';

export function transportsFor(config: NetworkConfig): SignalingTransport[] {
  return config.signaling.map((entry) =>
    entry.kind === 'nostr' ? new NostrTransport(entry.relays) : new RelayClient(entry.url),
  );
}

/** Runs every configured signaling transport at once; the first copy of a blob wins. */
export class SignalingHub {
  private seen = new Set<string>();

  constructor(private readonly transports: SignalingTransport[]) {}

  get enabled(): boolean {
    return this.transports.length > 0;
  }

  start(mailbox: string, onBlob: (blob: SealedBlob, id: string, via: SignalingTransport) => void): void {
    for (const transport of this.transports) {
      transport.start(mailbox, (blob, id) => {
        if (this.seen.has(blob.sig)) return;
        this.seen.add(blob.sig);
        if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value as string);
        onBlob(blob, id, transport);
      });
    }
  }

  /** Resolves if at least one transport accepted the blob. */
  async put(mailbox: string, blob: SealedBlob, opts: PutOptions): Promise<void> {
    if (this.transports.length === 0) throw new Error('No signaling is configured.');
    const results = await Promise.allSettled(this.transports.map((t) => t.put(mailbox, blob, opts)));
    if (!results.some((r) => r.status === 'fulfilled')) {
      const first = results[0];
      throw first?.status === 'rejected' ? first.reason : new Error('Signaling failed.');
    }
  }

  remove(via: SignalingTransport, mailbox: string, id: string): void {
    via.remove(mailbox, id);
  }

  status(): SignalingStatus {
    const states = this.transports.map((t) => t.status());
    if (states.includes('online')) return 'online';
    if (states.includes('connecting')) return 'connecting';
    return states.length === 0 ? 'idle' : 'error';
  }

  stop(): void {
    for (const t of this.transports) t.stop();
  }
}
