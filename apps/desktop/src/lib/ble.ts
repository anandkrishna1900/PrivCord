/**
 * Bluetooth LE transport for the desktop app (docs/BLE_TRANSPORT.md). UNTESTED on hardware.
 *
 * The desktop is central-only (btleplug cannot advertise or host GATT on Windows): it scans for the
 * paired phone's rotating tag, connects, and exchanges the same JSON frames as the WebRTC transport.
 * The native side (src-tauri/src/ble.rs) moves raw chunks; framing is done here.
 */
import { BleFramingError, Reassembler, bleAcceptTags, encodeJsonFrame } from './bleFraming';

/** Common shape of every transport (docs/CONNECTIVITY.md section 8). */
export interface MessageTransport {
  readonly kind: 'webrtc' | 'ble';
  readonly isOpen: boolean;
  sendJson(value: unknown): boolean;
  close(): void;
}

export type BleBridgeEvent =
  | { kind: 'open'; maxChunk: number }
  | { kind: 'chunk'; data: string }
  | { kind: 'close' }
  | { kind: 'error'; message: string };

/** Thin seam over the Tauri commands so the transport is testable without hardware. */
export interface BleBridge {
  capabilities(): Promise<{ central: boolean; peripheral: boolean; platform: string }>;
  connect(acceptTagsHex: string[], timeoutSecs: number): Promise<number>;
  write(chunkHex: string): Promise<void>;
  disconnect(): Promise<void>;
  onEvent(handler: (event: BleBridgeEvent) => void): Promise<() => void>;
}

export interface BleHandlers {
  onOpen(): void;
  onClose(): void;
  onFrame(data: string): void;
  onError(message: string): void;
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => Number.parseInt(h, 16));

export class BleTransport implements MessageTransport {
  readonly kind = 'ble' as const;
  private open = false;
  private maxChunk = 20;
  private writes: Promise<void> = Promise.resolve();
  private reassembler = new Reassembler();
  private unlisten: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly bridge: BleBridge,
    private readonly handlers: BleHandlers,
  ) {}

  get isOpen(): boolean {
    return this.open;
  }

  /** `secret` is the 32-byte ECDH secret shared with the pinned contact (never sent anywhere). */
  async connect(secret: Uint8Array, timeoutSecs = 30, nowMs = Date.now()): Promise<void> {
    const caps = await this.bridge.capabilities();
    if (!caps.central) throw new Error('Bluetooth is not available on this computer.');
    const tags = (await bleAcceptTags(secret, nowMs)).map(hex);
    this.closed = false;
    this.unlisten = await this.bridge.onEvent((event) => this.handleEvent(event));
    try {
      this.maxChunk = await this.bridge.connect(tags, timeoutSecs);
    } catch (error) {
      this.teardownListener();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private handleEvent(event: BleBridgeEvent): void {
    switch (event.kind) {
      case 'open':
        this.maxChunk = event.maxChunk;
        this.reassembler.reset();
        this.open = true;
        this.handlers.onOpen();
        return;
      case 'chunk':
        try {
          const message = this.reassembler.push(unhex(event.data));
          if (message) this.handlers.onFrame(new TextDecoder().decode(message));
        } catch (error) {
          if (error instanceof BleFramingError) this.handlers.onError(`Bluetooth framing error: ${error.message}`);
          else throw error;
        }
        return;
      case 'close':
        this.markClosed();
        return;
      case 'error':
        this.handlers.onError(event.message);
        return;
    }
  }

  /** Frames are chunked and written strictly in order; returns false if the link is not open or the frame is invalid. */
  sendJson(value: unknown): boolean {
    if (!this.open) return false;
    let chunks: Uint8Array[];
    try {
      chunks = encodeJsonFrame(value, this.maxChunk);
    } catch {
      return false;
    }
    for (const chunk of chunks) {
      this.writes = this.writes
        .then(() => (this.open ? this.bridge.write(hex(chunk)) : undefined))
        .catch((error) => {
          this.handlers.onError(`Bluetooth write failed: ${String(error)}`);
          this.close();
        });
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    void this.bridge.disconnect().catch(() => undefined);
    this.markClosed();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    const wasOpen = this.open;
    this.open = false;
    this.teardownListener();
    this.reassembler.reset();
    if (wasOpen) this.handlers.onClose();
  }

  private teardownListener(): void {
    this.unlisten?.();
    this.unlisten = null;
  }
}

/** Real bridge backed by the Tauri commands in src-tauri/src/lib.rs. Desktop (Tauri) only. */
export async function tauriBleBridge(): Promise<BleBridge> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  return {
    capabilities: () => invoke('ble_capabilities'),
    connect: (acceptTagsHex, timeoutSecs) => invoke('ble_connect', { acceptTagsHex, timeoutSecs }),
    write: (chunkHex) => invoke('ble_write', { chunkHex }),
    disconnect: () => invoke('ble_disconnect'),
    onEvent: (handler) => listen<BleBridgeEvent>('duochat://ble', (e) => handler(e.payload)),
  };
}
