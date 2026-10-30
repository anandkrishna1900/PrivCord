import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  fromB64Url,
  randomBytes,
  sha256,
  toB64Url,
} from '../e2ee/primitives';

/**
 * PrivCord Chunked Encrypted File Sharing Protocol
 *
 * Transfers are broken into fixed-size chunks (e.g. 16KB for Bluetooth mesh, 64KB for WebRTC).
 * Each transfer generates a distinct AES-256-GCM symmetric key.
 * File metadata and key are exchanged encrypted over the message channel.
 * Integrity is guaranteed through whole-file SHA-256 and individual chunk MACs.
 */

export interface FileMetadata {
  transferId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  totalChunks: number;
  chunkSize: number;
  keyB64Url: string; // Transfer encryption key
}

export interface FileChunk {
  v: 1;
  kind: 'file_chunk';
  transferId: string;
  chunkIndex: number;
  iv: string;
  data: string; // Base64 ciphertext
}

export interface FileProgress {
  transferId: string;
  receivedChunks: number;
  totalChunks: number;
  bytesTransferred: number;
  totalBytes: number;
  state: 'queued' | 'transferring' | 'paused' | 'completed' | 'failed' | 'cancelled';
  error?: string;
}

export class FileTransferManager {
  private activeTransfers = new Map<
    string,
    {
      meta: FileMetadata;
      key: Uint8Array;
      chunks: Map<number, Uint8Array>;
      receivedBytes: number;
      isSender: boolean;
      state: FileProgress['state'];
    }
  >();

  static async createTransfer(
    name: string,
    mimeType: string,
    data: Uint8Array,
    chunkSize = 32 * 1024,
  ): Promise<{ meta: FileMetadata; chunks: FileChunk[] }> {
    const transferId = toB64Url(randomBytes(16));
    const key = randomBytes(32);
    const fileHash = toB64Url(await sha256(data));
    const totalChunks = Math.ceil(data.length / chunkSize);

    const meta: FileMetadata = {
      transferId,
      name,
      mimeType,
      size: data.length,
      sha256: fileHash,
      totalChunks,
      chunkSize,
      keyB64Url: toB64Url(key),
    };

    const chunks: FileChunk[] = [];
    const enc = new TextEncoder();

    for (let i = 0; i < totalChunks; i++) {
      const slice = data.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, data.length));
      const iv = randomBytes(12);
      const aad = enc.encode(`file|${transferId}|${i}`);
      const ct = await aesGcmEncrypt(key, iv, slice, aad);
      chunks.push({
        v: 1,
        kind: 'file_chunk',
        transferId,
        chunkIndex: i,
        iv: toB64Url(iv),
        data: toB64Url(ct),
      });
    }

    return { meta, chunks };
  }

  registerIncoming(meta: FileMetadata): void {
    this.activeTransfers.set(meta.transferId, {
      meta,
      key: fromB64Url(meta.keyB64Url),
      chunks: new Map(),
      receivedBytes: 0,
      isSender: false,
      state: 'transferring',
    });
  }

  async processChunk(chunk: FileChunk): Promise<{ complete: boolean; data?: Uint8Array }> {
    const transfer = this.activeTransfers.get(chunk.transferId);
    if (!transfer) throw new Error(`Unknown transfer ${chunk.transferId}`);

    const enc = new TextEncoder();
    const aad = enc.encode(`file|${chunk.transferId}|${chunk.chunkIndex}`);
    const decrypted = await aesGcmDecrypt(
      transfer.key,
      fromB64Url(chunk.iv),
      fromB64Url(chunk.data),
      aad,
    );

    transfer.chunks.set(chunk.chunkIndex, decrypted);
    transfer.receivedBytes += decrypted.length;

    if (transfer.chunks.size === transfer.meta.totalChunks) {
      // Reassemble and verify integrity
      const full = new Uint8Array(transfer.meta.size);
      for (let i = 0; i < transfer.meta.totalChunks; i++) {
        const piece = transfer.chunks.get(i);
        if (!piece) throw new Error(`Missing chunk ${i}`);
        full.set(piece, i * transfer.meta.chunkSize);
      }
      const actualHash = toB64Url(await sha256(full));
      if (actualHash !== transfer.meta.sha256) {
        transfer.state = 'failed';
        throw new Error('Integrity check failed: checksum does not match metadata');
      }
      transfer.state = 'completed';
      return { complete: true, data: full };
    }

    return { complete: false };
  }

  getProgress(transferId: string): FileProgress | undefined {
    const t = this.activeTransfers.get(transferId);
    if (!t) return undefined;
    return {
      transferId,
      receivedChunks: t.chunks.size,
      totalChunks: t.meta.totalChunks,
      bytesTransferred: t.receivedBytes,
      totalBytes: t.meta.size,
      state: t.state,
    };
  }
}

