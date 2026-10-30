import { createMessageId } from '../message';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  canonicalJson,
  fromB64Url,
  hkdf,
  randomBytes,
  sha256,
  toB64Url,
} from './primitives';

/**
 * Group messaging using Epoch-based Group Sender Keys with forward secrecy and break-in recovery.
 * Each epoch has an epoch key and generation seed. Group members share the epoch secret encrypted
 * via direct pairwise pairwise channel or sealed blobs.
 * Future messages cannot be decrypted by evicted members because epoch changes on member removal.
 */

export interface GroupEpochKey {
  epoch: number;
  groupId: string;
  key: Uint8Array; // 32-byte key
}

export interface GroupMember {
  uid: string;
  role: 'admin' | 'member';
  joinedEpoch: number;
  addedBy: string;
}

export interface GroupMetadata {
  groupId: string;
  name: string;
  avatarUrl?: string;
  createdBy: string;
  createdAt: number;
  epoch: number;
  members: Record<string, GroupMember>;
}

export interface GroupEncryptedMessage {
  v: 1;
  kind: 'group_msg';
  groupId: string;
  epoch: number;
  senderUid: string;
  seq: number;
  iv: string;
  ciphertext: string;
}

export class GroupSessionManager {
  private epochKeys = new Map<string, Map<number, Uint8Array>>(); // groupId -> (epoch -> key)
  private groupMeta = new Map<string, GroupMetadata>();

  setGroup(meta: GroupMetadata): void {
    this.groupMeta.set(meta.groupId, meta);
  }

  getGroup(groupId: string): GroupMetadata | undefined {
    return this.groupMeta.get(groupId);
  }

  setEpochKey(groupId: string, epoch: number, key: Uint8Array): void {
    let epochs = this.epochKeys.get(groupId);
    if (!epochs) {
      epochs = new Map();
      this.epochKeys.set(groupId, epochs);
    }
    epochs.set(epoch, key);
  }

  getEpochKey(groupId: string, epoch: number): Uint8Array | undefined {
    return this.epochKeys.get(groupId)?.get(epoch);
  }

  static async generateEpochSecret(): Promise<Uint8Array> {
    return randomBytes(32);
  }

  /**
   * Encrypt a message to a group epoch.
   */
  async encrypt(
    groupId: string,
    senderUid: string,
    seq: number,
    payload: unknown,
  ): Promise<GroupEncryptedMessage> {
    const group = this.groupMeta.get(groupId);
    if (!group) throw new Error(`Unknown group ${groupId}`);
    const key = this.getEpochKey(groupId, group.epoch);
    if (!key) throw new Error(`Missing epoch key for group ${groupId} epoch ${group.epoch}`);

    const enc = new TextEncoder();
    const iv = randomBytes(12);
    const aad = enc.encode(`group|${groupId}|${group.epoch}|${senderUid}|${seq}`);
    const plaintext = enc.encode(JSON.stringify(payload));

    const ct = await aesGcmEncrypt(key, iv, plaintext, aad);

    return {
      v: 1,
      kind: 'group_msg',
      groupId,
      epoch: group.epoch,
      senderUid,
      seq,
      iv: toB64Url(iv),
      ciphertext: toB64Url(ct),
    };
  }

  /**
   * Decrypt a message from a group epoch.
   */
  async decrypt(msg: GroupEncryptedMessage): Promise<unknown> {
    const key = this.getEpochKey(msg.groupId, msg.epoch);
    if (!key) {
      throw new Error(`Cannot decrypt: missing epoch key for ${msg.groupId} epoch ${msg.epoch}`);
    }

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const aad = enc.encode(`group|${msg.groupId}|${msg.epoch}|${msg.senderUid}|${msg.seq}`);
    const plain = await aesGcmDecrypt(
      key,
      fromB64Url(msg.iv),
      fromB64Url(msg.ciphertext),
      aad,
    );
    return JSON.parse(dec.decode(plain));
  }
}

