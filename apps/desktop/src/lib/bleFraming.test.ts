import { describe, expect, it } from 'vitest';
import vectors from '../../../../docs/ble-vectors.json';
import {
  BLE_MAX_MESSAGE_BYTES,
  BleFramingError,
  Reassembler,
  bleAcceptTags,
  bleEpoch,
  bleTag,
  chunkMessage,
  encodeJsonFrame,
} from './bleFraming';

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => Number.parseInt(h, 16));

describe('chunkMessage (shared vectors)', () => {
  for (const c of vectors.chunking) {
    it(c.name, () => {
      const chunks = chunkMessage(enc.encode(c.text), c.maxChunk);
      expect(chunks.map(hex)).toEqual(c.chunksHex);
      expect(chunks.every((chunk) => chunk.length <= c.maxChunk)).toBe(true);
      const r = new Reassembler();
      const out = chunks.map((chunk) => r.push(chunk)).filter((m) => m !== null);
      expect(out).toHaveLength(1);
      expect(dec.decode(out[0]!)).toBe(c.text);
    });
  }
});

describe('Reassembler (shared vectors)', () => {
  for (const c of vectors.reassembly) {
    it(c.name, () => {
      const r = new Reassembler();
      c.chunksHex.forEach((h, i) => {
        const expected = c.results[i] as { msg?: string; err?: boolean } | null;
        if (expected?.err) {
          expect(() => r.push(unhex(h))).toThrow(BleFramingError);
        } else if (expected?.msg !== undefined) {
          expect(dec.decode(r.push(unhex(h))!)).toBe(expected.msg);
        } else {
          expect(r.push(unhex(h))).toBeNull();
        }
      });
    });
  }
});

describe('limits', () => {
  it('round-trips a 64 KiB message in the expected number of chunks', () => {
    const { length, byte, maxChunk, chunkCount } = vectors.large;
    const payload = new Uint8Array(length).fill(byte);
    const chunks = chunkMessage(payload, maxChunk);
    expect(chunks).toHaveLength(chunkCount);
    const r = new Reassembler();
    let out: Uint8Array | null = null;
    for (const chunk of chunks) out = r.push(chunk);
    expect(out).toEqual(payload);
  });

  it('uses every sequence number up to 65535 at the minimum chunk size', () => {
    const chunks = chunkMessage(new Uint8Array(BLE_MAX_MESSAGE_BYTES), 4);
    expect(chunks).toHaveLength(65_536);
    expect([...chunks[65_535]!.subarray(0, 3)]).toEqual([0x02, 0xff, 0xff]);
  });

  it('rejects oversize, empty and too-small-chunk input', () => {
    expect(() => chunkMessage(new Uint8Array(vectors.oversize.length), vectors.oversize.maxChunk)).toThrow(BleFramingError);
    expect(() => chunkMessage(new Uint8Array(0), 20)).toThrow(BleFramingError);
    expect(() => chunkMessage(new Uint8Array(1), 3)).toThrow(BleFramingError);
    expect(() => chunkMessage(new Uint8Array(1), 20.5)).toThrow(BleFramingError);
  });

  it('rejects a stream that grows past 64 KiB', () => {
    const r = new Reassembler();
    const body = new Uint8Array(1000).fill(1);
    const mk = (flags: number, seq: number) => Uint8Array.from([flags, seq >> 8, seq & 0xff, ...body]);
    r.push(mk(0x01, 0));
    for (let i = 1; i < 65; i += 1) r.push(mk(0x00, i));
    expect(() => r.push(mk(0x00, 65))).toThrow(BleFramingError);
  });

  it('encodeJsonFrame is plain UTF-8 JSON', () => {
    const chunks = encodeJsonFrame({ v: 1, kind: 'read' }, 512);
    expect(chunks).toHaveLength(1);
    expect(dec.decode(chunks[0]!.subarray(3))).toBe('{"v":1,"kind":"read"}');
  });
});

describe('advertisement tag (shared vectors)', () => {
  const secret = unhex(vectors.tag.secretHex);
  for (const v of vectors.tag.vectors) {
    it(`epoch ${v.epoch}`, async () => {
      expect(hex(await bleTag(secret, v.epoch))).toBe(v.tagHex);
    });
  }

  it('a different secret gives a different tag', async () => {
    expect(hex(await bleTag(new Uint8Array(32), 1))).not.toBe(vectors.tag.vectors[1]!.tagHex);
  });

  it('epochs are 15 minutes and the accept window is previous/current/next', async () => {
    expect(bleEpoch(899_999)).toBe(0);
    expect(bleEpoch(900_000)).toBe(1);
    const tags = (await bleAcceptTags(secret, 900_000)).map(hex);
    expect(tags).toEqual(vectors.tag.vectors.slice(0, 2).map((v) => v.tagHex).concat([hex(await bleTag(secret, 2))]));
  });
});
