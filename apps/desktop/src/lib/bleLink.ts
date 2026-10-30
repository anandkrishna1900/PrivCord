import {
  SecureChannel,
  isScData,
  isScHello,
  type PublicJwk,
  type PrivateJwk,
} from '@duochat/protocol';
import { BleTransport, tauriBleBridge, type BleBridge, type MessageTransport } from './ble';
import { isTauri } from '../config';

declare global {
  interface Window {
    /** Test seam: lets automated tests replace the radio with a simulated one. */
    __duochatBleBridge?: BleBridge;
  }
}

/** The Bluetooth bridge, or null where this build cannot do Bluetooth (browser, no adapter). */
export async function getBleBridge(): Promise<BleBridge | null> {
  try {
    const bridge = window.__duochatBleBridge ?? (isTauri() ? await tauriBleBridge() : null);
    if (!bridge) return null;
    return (await bridge.capabilities()).central ? bridge : null;
  } catch {
    return null;
  }
}

export interface SecureLinkHandlers {
  onOpen(): void;
  onClose(): void;
  onFrame(data: string): void;
  onError(message: string): void;
}

/**
 * Bluetooth LE with the same JSON frames as WebRTC, plus authenticated forward-secret
 * encryption (BLE itself is not encrypted here). Opens only after the peer proved it is the
 * paired contact.
 */
export class SecureBleLink implements MessageTransport {
  readonly kind = 'ble' as const;
  private inner: BleTransport;
  private channel: SecureChannel | null = null;
  private channelReady: Promise<SecureChannel> | null = null;
  private ready = false;
  private queue: Promise<void> = Promise.resolve();
  /** Incoming frames are processed strictly in order, even while the handshake is still running. */
  private rx: Promise<void> = Promise.resolve();

  constructor(
    bridge: BleBridge,
    private readonly identity: { ownUid: string; peerUid: string; signPriv: PrivateJwk; peerSign: PublicJwk },
    private readonly handlers: SecureLinkHandlers,
  ) {
    this.inner = new BleTransport(bridge, {
      onOpen: () => this.begin(),
      onClose: () => {
        const was = this.ready;
        this.ready = false;
        if (was) this.handlers.onClose();
      },
      onFrame: (raw) => {
        this.rx = this.rx.then(() => this.receive(raw));
      },
      onError: (message) => this.handlers.onError(message),
    });
  }

  get isOpen(): boolean {
    return this.ready && this.inner.isOpen;
  }

  /** `secret` is the ECDH secret with the paired contact; it only selects which advertisements to accept. */
  connect(secret: Uint8Array, timeoutSecs = 20): Promise<void> {
    return this.inner.connect(secret, timeoutSecs);
  }

  private begin(): void {
    // Created synchronously: a hello from the peer can arrive before our own setup finishes.
    this.channelReady = SecureChannel.create(this.identity);
    this.channelReady.then(
      async (channel) => {
        this.channel = channel;
        this.inner.sendJson(await channel.hello());
      },
      (error: unknown) => {
        this.handlers.onError(`Bluetooth security setup failed: ${String(error)}`);
        this.close();
      },
    );
  }

  private async receive(raw: string): Promise<void> {
    if (!this.channelReady) return;
    try {
      const channel = await this.channelReady;
      const frame: unknown = JSON.parse(raw);
      if (!channel.ready) {
        if (!isScHello(frame)) return;
        await channel.accept(frame);
        this.ready = true;
        this.handlers.onOpen();
        return;
      }
      if (isScData(frame)) {
        this.handlers.onFrame(JSON.stringify(await channel.decrypt(frame)));
      }
    } catch (error) {
      this.handlers.onError(`Bluetooth link rejected: ${error instanceof Error ? error.message : String(error)}`);
      this.close();
    }
  }

  sendJson(value: unknown): boolean {
    const channel = this.channel;
    if (!this.isOpen || !channel) return false;
    // Encrypt and write strictly in order so counters never arrive out of sequence.
    this.queue = this.queue
      .then(async () => {
        if (!this.inner.sendJson(await channel.encrypt(value))) throw new Error('Bluetooth write refused.');
      })
      .catch((error) => {
        this.handlers.onError(String(error));
        this.close();
      });
    return true;
  }

  close(): void {
    this.ready = false;
    this.inner.close();
  }
}
