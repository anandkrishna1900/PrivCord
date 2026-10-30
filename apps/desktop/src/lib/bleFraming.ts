/**
 * BLE chunking/reassembly for JSON frames (docs/BLE_TRANSPORT.md section 4).
 * Must stay byte-for-byte identical to the Kotlin BleFraming; both are tested
 * against docs/ble-vectors.json.
 *
 * Chunk = flags (1 byte) | seq (2 bytes, big-endian, 0-based within the message) | payload.
 * flags: bit0 START, bit1 END, other bits must be zero. GATT delivers writes and
 * notifications in order, so there are no acks or retransmits.
 */

export const BLE_HEADER_BYTES = 3;
export const BLE_MAX_MESSAGE_BYTES = 65_536;
/** Smallest usable chunk: header plus one payload byte. */
export const BLE_MIN_CHUNK_BYTES = BLE_HEADER_BYTES + 1;
export const FLAG_START = 0x01;
export const FLAG_END = 0x02;

export class BleFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BleFramingError';
  }
}

/** Split one message into chunks of at most `maxChunkBytes` (header included). */
export function chunkMessage(payload: Uint8Array, maxChunkBytes: number): Uint8Array[] {
  if (payload.length === 0) throw new BleFramingError('Empty message.');
  if (payload.length > BLE_MAX_MESSAGE_BYTES) throw new BleFramingError('Message too large.');
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < BLE_MIN_CHUNK_BYTES) {
    throw new BleFramingError('Chunk size too small.');
  }
  const body = maxChunkBytes - BLE_HEADER_BYTES;
  const chunks: Uint8Array[] = [];
  for (let offset = 0, seq = 0; offset < payload.length; offset += body, seq += 1) {
    const part = payload.subarray(offset, offset + body);
    const last = offset + body >= payload.length;
    const chunk = new Uint8Array(BLE_HEADER_BYTES + part.length);
    chunk[0] = (seq === 0 ? FLAG_START : 0) | (last ? FLAG_END : 0);
    chunk[1] = (seq >> 8) & 0xff;
    chunk[2] = seq & 0xff;
    chunk.set(part, BLE_HEADER_BYTES);
    chunks.push(chunk);
  }
  return chunks;
}

export function encodeJsonFrame(value: unknown, maxChunkBytes: number): Uint8Array[] {
  return chunkMessage(new TextEncoder().encode(JSON.stringify(value)), maxChunkBytes);
}

/** Stateful reassembler for one link direction. */
export class Reassembler {
  private parts: Uint8Array[] = [];
  private size = 0;
  private next = 0;
  private active = false;

  /** Returns the full message when the END chunk arrives, otherwise null. Throws (and resets) on a malformed stream. */
  push(chunk: Uint8Array): Uint8Array | null {
    if (chunk.length < BLE_MIN_CHUNK_BYTES) return this.fail('Chunk too short.');
    const flags = chunk[0]!;
    if ((flags & ~(FLAG_START | FLAG_END)) !== 0) return this.fail('Unknown flags.');
    const seq = (chunk[1]! << 8) | chunk[2]!;
    if (flags & FLAG_START) {
      // A new START always discards a half-received message (the sender restarted).
      this.reset();
      if (seq !== 0) return this.fail('START chunk must have seq 0.');
      this.active = true;
    } else if (!this.active) {
      return this.fail('Chunk without START.');
    }
    if (seq !== this.next) return this.fail('Chunk out of order.');
    this.size += chunk.length - BLE_HEADER_BYTES;
    if (this.size > BLE_MAX_MESSAGE_BYTES) return this.fail('Message too large.');
    this.parts.push(chunk.subarray(BLE_HEADER_BYTES));
    this.next = seq + 1;
    if (!(flags & FLAG_END)) return null;
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    this.reset();
    return out;
  }

  reset(): void {
    this.parts = [];
    this.size = 0;
    this.next = 0;
    this.active = false;
  }

  private fail(message: string): never {
    this.reset();
    throw new BleFramingError(message);
  }
}

/** Rotating advertisement tag (docs/BLE_TRANSPORT.md section 3). */
export const BLE_TAG_EPOCH_SECONDS = 900;
export const BLE_TAG_BYTES = 8;

export function bleEpoch(nowMs: number): number {
  return Math.floor(nowMs / 1000 / BLE_TAG_EPOCH_SECONDS);
}

/** HMAC-SHA-256(secret, "duochat-ble-tag-v1|" + epoch) truncated to 8 bytes. `secret` is the 32-byte contact ECDH secret. */
export async function bleTag(secret: Uint8Array, epoch: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`duochat-ble-tag-v1|${epoch}`));
  return new Uint8Array(mac).slice(0, BLE_TAG_BYTES);
}

/** Tags a scanner should accept now: the previous, current and next epoch (clock skew up to one epoch). */
export async function bleAcceptTags(secret: Uint8Array, nowMs: number): Promise<Uint8Array[]> {
  const e = bleEpoch(nowMs);
  return Promise.all([e - 1, e, e + 1].map((x) => bleTag(secret, x)));
}
