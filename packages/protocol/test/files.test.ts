import { describe, expect, it } from 'vitest';
import {
  FILE_CHUNK_BYTES,
  FileAssembler,
  MAX_FILE_BYTES,
  createOutgoingMessage,
  fileChunks,
  isInlineImage,
  makeFileOffer,
  parseDeclinedFrame,
  parseFileChunk,
  parseFileOffer,
  parsePeerMessageFrame,
  createPeerMessageFrame,
  makeReplyRef,
  sanitizeFileName,
  sanitizeMime,
  validateFileSize,
} from '../src';

const bytesOf = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);

async function transfer(bytes: Uint8Array, tamper?: (f: ReturnType<typeof fileChunks> extends Generator<infer T> ? T : never, i: number) => unknown) {
  const offer = await makeFileOffer({ messageId: 'file-1', name: 'a.bin', mime: 'application/octet-stream', bytes, clientCreatedAt: 1 });
  const rx = new FileAssembler();
  expect(rx.begin(parseFileOffer(JSON.parse(JSON.stringify(offer)))!)).toBe('ok');
  let last: Awaited<ReturnType<FileAssembler['chunk']>> = { status: 'more' };
  let i = 0;
  for (const c of fileChunks('file-1', bytes)) {
    const wire = tamper ? tamper(c, i) : c;
    i += 1;
    const frame = parseFileChunk(JSON.parse(JSON.stringify(wire)));
    if (!frame) return { status: 'failed' as const, reason: 'bad_file' as const };
    last = await rx.chunk(frame);
    if (last.status !== 'more') break;
  }
  return last;
}

describe('file transfer', () => {
  it('reassembles files of awkward sizes byte for byte', async () => {
    for (const size of [1, FILE_CHUNK_BYTES - 1, FILE_CHUNK_BYTES, FILE_CHUNK_BYTES + 1, 100_000]) {
      const bytes = bytesOf(size);
      const r = await transfer(bytes);
      expect(r.status).toBe('done');
      if (r.status === 'done') expect(Array.from(r.bytes)).toEqual(Array.from(bytes));
    }
  });

  it('handles the 8 MB maximum and refuses one byte more', async () => {
    const r = await transfer(bytesOf(MAX_FILE_BYTES));
    expect(r.status).toBe('done');
    expect(validateFileSize(MAX_FILE_BYTES)).toBeNull();
    expect(validateFileSize(MAX_FILE_BYTES + 1)).toMatch(/at most 8\.0 MB/);
    expect(validateFileSize(0)).toMatch(/empty/);
    await expect(makeFileOffer({ messageId: 'm', name: 'x', mime: 'a/b', bytes: bytesOf(MAX_FILE_BYTES + 1), clientCreatedAt: 1 })).rejects.toThrow();
    const rx = new FileAssembler();
    const offer = parseFileOffer({ v: 1, kind: 'file_offer', messageId: 'big', name: 'x', mime: 'a/b', size: MAX_FILE_BYTES + 1, sha256: 'a'.repeat(43), clientCreatedAt: 1 })!;
    expect(rx.begin(offer)).toBe('too_large');
  }, 60_000);

  it('rejects corrupted, truncated, reordered and padded transfers', async () => {
    const bytes = bytesOf(FILE_CHUNK_BYTES * 3 + 10);
    // flipped byte in chunk 1: hash mismatch
    const flipped = await transfer(bytes, (c, i) => (i === 1 ? { ...c, data: (c.data[0] === 'A' ? 'B' : 'A') + c.data.slice(1) } : c));
    expect(flipped.status).toBe('failed');
    // chunk skipped
    const skipped = await transfer(bytes, (c, i) => (i === 1 ? { ...c, index: 2 } : c));
    expect(skipped.status).toBe('failed');
    // wrong length
    const short = await transfer(bytes, (c, i) => (i === 0 ? { ...c, data: c.data.slice(0, 20) } : c));
    expect(short.status).toBe('failed');
  });

  it('refuses a third simultaneous incoming transfer and unknown chunks', async () => {
    const rx = new FileAssembler();
    const mk = (id: string) => parseFileOffer({ v: 1, kind: 'file_offer', messageId: id, name: 'x', mime: 'a/b', size: 10, sha256: 'a'.repeat(43), clientCreatedAt: 1 })!;
    expect(rx.begin(mk('a'))).toBe('ok');
    expect(rx.begin(mk('b'))).toBe('ok');
    expect(rx.begin(mk('c'))).toBe('busy');
    const stray = parseFileChunk({ v: 1, kind: 'file_chunk', messageId: 'zzz', index: 0, data: 'AAAA' })!;
    expect((await rx.chunk(stray)).status).toBe('failed');
  });

  it('cleans names and types that arrive from a stranger', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFileName('C:\\Windows\\evil.exe')).not.toMatch(/[\\/:]/);
    expect(sanitizeFileName('a\u0000b\nc.txt')).toBe('a_b_c.txt');
    expect(sanitizeFileName('   ')).toBe('file');
    expect(sanitizeFileName('x'.repeat(500) + '.png').length).toBeLessThanOrEqual(120);
    expect(sanitizeFileName('x'.repeat(500) + '.png').endsWith('.png')).toBe(true);
    expect(sanitizeMime('text/html; charset=utf-8')).toBe('application/octet-stream');
    expect(sanitizeMime('IMAGE/PNG')).toBe('image/png');
    expect(isInlineImage('image/png')).toBe(true);
    expect(isInlineImage('image/svg+xml')).toBe(false);
  });

  it('validates offer and chunk frames', () => {
    expect(parseFileOffer({ v: 1, kind: 'file_offer', messageId: '', name: 'x', mime: 'a/b', size: 1, sha256: 'a'.repeat(43), clientCreatedAt: 1 })).toBeNull();
    expect(parseFileOffer({ v: 1, kind: 'file_offer', messageId: 'm', name: 'x', mime: 'a/b', size: 1.5, sha256: 'a'.repeat(43), clientCreatedAt: 1 })).toBeNull();
    expect(parseFileChunk({ v: 1, kind: 'file_chunk', messageId: 'm', index: -1, data: 'AAAA' })).toBeNull();
    expect(parseFileChunk({ v: 1, kind: 'file_chunk', messageId: 'm', index: 0, data: 'A'.repeat(100_000) })).toBeNull();
  });
});

describe('replies and declines', () => {
  it('carries a reply on a direct message and rejects a malformed one', () => {
    const original = createOutgoingMessage({ senderId: 'alice', text: 'lunch at 12?' });
    const reply = createOutgoingMessage({ senderId: 'bob', text: 'yes', replyTo: makeReplyRef(original) });
    const frame = JSON.parse(JSON.stringify(createPeerMessageFrame(reply)));
    expect(parsePeerMessageFrame(frame)?.replyTo).toEqual({ id: original.messageId, author: 'alice', preview: 'lunch at 12?' });
    expect(parsePeerMessageFrame({ ...frame, replyTo: { id: 'x' } })).toBeNull();
    expect(parsePeerMessageFrame({ ...frame, replyTo: undefined })?.replyTo).toBeUndefined();
  });

  it('truncates long quotes', () => {
    const long = createOutgoingMessage({ senderId: 'a', text: 'x'.repeat(1000) });
    expect(Array.from(makeReplyRef(long).preview)).toHaveLength(120);
  });

  it('parses declined frames', () => {
    expect(parseDeclinedFrame({ v: 1, kind: 'declined', messageId: 'm', reason: 'direct_not_accepted' })?.reason).toBe('direct_not_accepted');
    expect(parseDeclinedFrame({ v: 1, kind: 'declined', messageId: 'm', reason: 'nope' })).toBeNull();
  });
});
