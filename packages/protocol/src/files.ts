import { FILE_CHUNK_BYTES, MAX_FILE_BYTES, MAX_REPLY_PREVIEW, PROTOCOL_VERSION } from './constants';
import { fromB64Url, sha256, toB64Url } from './e2ee/primitives';
import { isRecord, validateClientMessageId, validateReply, type ReplyRef } from './message';
import { parseTtl } from './social';

/*
 * File sharing. A file goes straight to each recipient over the already-authenticated direct link
 * (WebRTC data channel), so it gets the same end-to-end protection as a message. No server stores it.
 * Not sent over Bluetooth (too slow) or the store-and-forward relay (size).
 *
 * Flow: file_offer -> file_chunk x N (in order) -> receiver verifies size + SHA-256 -> `ack` (DELIVERED).
 * A receiver that refuses answers `declined`.
 */

/** Largest group/direct file fan-out and chunk count are bounded by MAX_FILE_BYTES. */
export const MAX_FILE_CHUNKS = Math.ceil(MAX_FILE_BYTES / FILE_CHUNK_BYTES);
export const MAX_FILE_NAME = 120;
/** Incoming transfers a peer may have open at once. */
export const MAX_INCOMING_PER_PEER = 2;

export interface FileOfferFrame {
  v: typeof PROTOCOL_VERSION;
  kind: 'file_offer';
  messageId: string;
  /** Set for a group file, absent for a direct file. */
  groupId?: string;
  name: string;
  mime: string;
  size: number;
  /** SHA-256 of the whole file, base64url. */
  sha256: string;
  clientCreatedAt: number;
  replyTo?: ReplyRef;
  ttl?: number;
}

export interface FileChunkFrame {
  v: typeof PROTOCOL_VERSION;
  kind: 'file_chunk';
  messageId: string;
  index: number;
  /** base64url of up to FILE_CHUNK_BYTES raw bytes. */
  data: string;
}

/** Image types that are safe to preview inline. SVG is excluded on purpose: it can carry script. */
const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isInlineImage(mime: string): boolean {
  return INLINE_IMAGE.has(mime.toLowerCase());
}

/** Video types that play inline. Decoding is done by the system's own media stack. */
const INLINE_VIDEO = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg']);

export function isInlineVideo(mime: string): boolean {
  return INLINE_VIDEO.has(mime.toLowerCase());
}

/** Voice notes and other audio that play inline. */
const INLINE_AUDIO = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav', 'audio/x-m4a']);

export function isInlineAudio(mime: string): boolean {
  return INLINE_AUDIO.has(mime.toLowerCase().split(';')[0]!.trim());
}

/** A file name that is safe to show and to save under: no path, no control characters, bounded length. */
export function sanitizeFileName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let name = raw.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').replace(/^[.\s]+/, '').trim();
  const chars = Array.from(name);
  if (chars.length > MAX_FILE_NAME) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = chars.slice(0, MAX_FILE_NAME - Array.from(ext).length).join('') + ext;
  }
  return name || 'file';
}

/** Only well-formed `type/subtype` strings are kept; anything else is treated as unknown. */
export function sanitizeMime(raw: string): string {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/i.test(raw) ? raw.toLowerCase() : 'application/octet-stream';
}

export function validateFileSize(size: number): string | null {
  if (!Number.isInteger(size) || size <= 0) return 'That file is empty.';
  if (size > MAX_FILE_BYTES) return `Files can be at most ${formatBytes(MAX_FILE_BYTES)}.`;
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export async function makeFileOffer(input: {
  messageId: string;
  groupId?: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
  clientCreatedAt: number;
  replyTo?: ReplyRef;
  ttl?: number;
}): Promise<FileOfferFrame> {
  const error = validateFileSize(input.bytes.length);
  if (error) throw new Error(error);
  return {
    v: PROTOCOL_VERSION,
    kind: 'file_offer',
    messageId: input.messageId,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    name: sanitizeFileName(input.name),
    mime: sanitizeMime(input.mime),
    size: input.bytes.length,
    sha256: toB64Url(await sha256(input.bytes)),
    clientCreatedAt: input.clientCreatedAt,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.ttl ? { ttl: input.ttl } : {}),
  };
}

export function* fileChunks(messageId: string, bytes: Uint8Array): Generator<FileChunkFrame> {
  const total = Math.ceil(bytes.length / FILE_CHUNK_BYTES);
  for (let index = 0; index < total; index += 1) {
    yield {
      v: PROTOCOL_VERSION,
      kind: 'file_chunk',
      messageId,
      index,
      data: toB64Url(bytes.subarray(index * FILE_CHUNK_BYTES, (index + 1) * FILE_CHUNK_BYTES)),
    };
  }
}

export function parseFileOffer(value: unknown): FileOfferFrame | null {
  if (!isRecord(value) || value.kind !== 'file_offer' || value.v !== PROTOCOL_VERSION) return null;
  if (!validateClientMessageId(value.messageId)) return null;
  if (value.groupId !== undefined && (typeof value.groupId !== 'string' || value.groupId.length === 0 || value.groupId.length > 128)) return null;
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 400) return null;
  if (typeof value.mime !== 'string' || value.mime.length > 200) return null;
  if (typeof value.size !== 'number' || !Number.isInteger(value.size) || value.size <= 0) return null;
  if (typeof value.sha256 !== 'string' || value.sha256.length < 40 || value.sha256.length > 64) return null;
  if (typeof value.clientCreatedAt !== 'number' || !Number.isFinite(value.clientCreatedAt) || value.clientCreatedAt <= 0) return null;
  if (value.replyTo !== undefined && !validateReply(value.replyTo)) return null;
  const ttl = parseTtl(value.ttl);
  if (ttl === null) return null;
  return {
    v: PROTOCOL_VERSION,
    kind: 'file_offer',
    messageId: value.messageId,
    ...(value.groupId ? { groupId: value.groupId as string } : {}),
    name: sanitizeFileName(value.name),
    mime: sanitizeMime(value.mime),
    size: value.size,
    sha256: value.sha256,
    clientCreatedAt: value.clientCreatedAt,
    ...(value.replyTo ? { replyTo: value.replyTo as ReplyRef } : {}),
    ...(ttl ? { ttl } : {}),
  };
}

export function parseFileChunk(value: unknown): FileChunkFrame | null {
  if (!isRecord(value) || value.kind !== 'file_chunk' || value.v !== PROTOCOL_VERSION) return null;
  if (!validateClientMessageId(value.messageId)) return null;
  if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0 || value.index >= MAX_FILE_CHUNKS) return null;
  if (typeof value.data !== 'string' || value.data.length === 0 || value.data.length > Math.ceil((FILE_CHUNK_BYTES * 4) / 3) + 4) return null;
  return { v: PROTOCOL_VERSION, kind: 'file_chunk', messageId: value.messageId, index: value.index, data: value.data };
}

export type AssembleResult =
  | { status: 'more' }
  | { status: 'done'; offer: FileOfferFrame; bytes: Uint8Array }
  | { status: 'failed'; reason: 'bad_file' | 'too_large' | 'busy' };

interface Incoming {
  offer: FileOfferFrame;
  parts: Uint8Array[];
  next: number;
  received: number;
}

/**
 * Receiving side, one per peer link. Chunks must arrive in order (the data channel is ordered); anything
 * out of order, oversized or failing the SHA-256 check aborts that transfer.
 */
export class FileAssembler {
  private active = new Map<string, Incoming>();

  get activeCount(): number {
    return this.active.size;
  }

  /** Start a transfer. Returns a failure reason if it must be refused. */
  begin(offer: FileOfferFrame): 'ok' | 'too_large' | 'busy' | 'bad_file' {
    if (this.active.has(offer.messageId)) return 'ok';
    if (validateFileSize(offer.size)) return 'too_large';
    if (this.active.size >= MAX_INCOMING_PER_PEER) return 'busy';
    this.active.set(offer.messageId, { offer, parts: [], next: 0, received: 0 });
    return 'ok';
  }

  async chunk(frame: FileChunkFrame): Promise<AssembleResult> {
    const t = this.active.get(frame.messageId);
    if (!t) return { status: 'failed', reason: 'bad_file' };
    let data: Uint8Array;
    try {
      data = fromB64Url(frame.data);
    } catch {
      this.active.delete(frame.messageId);
      return { status: 'failed', reason: 'bad_file' };
    }
    const expectedLast = Math.ceil(t.offer.size / FILE_CHUNK_BYTES) - 1;
    const expectedLen = frame.index === expectedLast ? t.offer.size - expectedLast * FILE_CHUNK_BYTES : FILE_CHUNK_BYTES;
    if (frame.index !== t.next || data.length !== expectedLen || t.received + data.length > t.offer.size) {
      this.active.delete(frame.messageId);
      return { status: 'failed', reason: 'bad_file' };
    }
    t.parts.push(data);
    t.next += 1;
    t.received += data.length;
    if (t.received < t.offer.size) return { status: 'more' };
    this.active.delete(frame.messageId);
    const bytes = new Uint8Array(t.received);
    let at = 0;
    for (const part of t.parts) {
      bytes.set(part, at);
      at += part.length;
    }
    if (toB64Url(await sha256(bytes)) !== t.offer.sha256) return { status: 'failed', reason: 'bad_file' };
    return { status: 'done', offer: t.offer, bytes };
  }

  progress(messageId: string): number | null {
    const t = this.active.get(messageId);
    return t ? t.received / t.offer.size : null;
  }

  abort(messageId: string): void {
    this.active.delete(messageId);
  }

  clear(): void {
    this.active.clear();
  }
}

/** Text shown when a file is quoted in a reply or listed as a last message. */
export function filePreviewText(name: string): string {
  return Array.from(`📎 ${name}`).slice(0, MAX_REPLY_PREVIEW).join('');
}
