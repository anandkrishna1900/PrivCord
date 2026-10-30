import { describe, expect, it } from 'vitest';
import { GroupSessionManager } from '../src/e2ee/groupCrypto';
import { MeshRouter } from '../src/connectivity/mesh';
import { FileTransferManager } from '../src/connectivity/fileSharing';

describe('GroupSessionManager', () => {
  it('encrypts and decrypts group messages per epoch and isolates across epochs', async () => {
    const mgrA = new GroupSessionManager();
    const mgrB = new GroupSessionManager();

    const epoch1Secret = await GroupSessionManager.generateEpochSecret();
    const groupId = 'group-alpha';

    mgrA.setGroup({
      groupId,
      name: 'Secret Agents',
      createdBy: 'alice',
      createdAt: Date.now(),
      epoch: 1,
      members: {
        alice: { uid: 'alice', role: 'admin', joinedEpoch: 1, addedBy: 'alice' },
        bob: { uid: 'bob', role: 'member', joinedEpoch: 1, addedBy: 'alice' },
      },
    });
    mgrA.setEpochKey(groupId, 1, epoch1Secret);

    mgrB.setGroup(mgrA.getGroup(groupId)!);
    mgrB.setEpochKey(groupId, 1, epoch1Secret);

    const enc = await mgrA.encrypt(groupId, 'alice', 0, { text: 'Mission starts now' });
    expect(enc.epoch).toBe(1);

    const dec = (await mgrB.decrypt(enc)) as { text: string };
    expect(dec.text).toBe('Mission starts now');

    // Bob is removed in Epoch 2; Bob does not receive Epoch 2 key
    const epoch2Secret = await GroupSessionManager.generateEpochSecret();
    mgrA.setGroup({
      ...mgrA.getGroup(groupId)!,
      epoch: 2,
    });
    mgrA.setEpochKey(groupId, 2, epoch2Secret);

    const enc2 = await mgrA.encrypt(groupId, 'alice', 1, { text: 'Classified update' });
    // Bob attempts to decrypt Epoch 2 message without key
    await expect(mgrB.decrypt(enc2)).rejects.toThrow(/missing epoch key/);
  });
});

describe('MeshRouter', () => {
  it('handles multi-hop packet routing, deduplication, and loop detection', () => {
    const router = new MeshRouter({ defaultTtl: 5 });

    const pkt = {
      v: 1 as const,
      kind: 'mesh_pkt' as const,
      packetId: 'pkt-001',
      originUid: 'device-A',
      destUid: 'device-D',
      ttl: 4,
      maxHops: 5,
      timestamp: Date.now(),
      payload: 'ciphertext-data',
    };

    // Device B receives
    const actionB = router.processPacket(pkt, 'device-B');
    expect(actionB).toBe('FORWARD');

    // Duplicate packet arriving again at Device B is dropped
    const actionB2 = router.processPacket(pkt, 'device-B');
    expect(actionB2).toBe('DROP');

    // Decrement TTL for forwarding
    const hopC = router.nextHopPacket(pkt);
    expect(hopC?.ttl).toBe(3);

    // Final destination consumes
    const routerD = new MeshRouter();
    const actionD = routerD.processPacket(hopC!, 'device-D');
    expect(actionD).toBe('CONSUME');
  });
});

describe('FileTransferManager', () => {
  it('splits, encrypts, transfers chunks, validates SHA-256 and reassembles', async () => {
    const originalText = 'PrivCord Decentralized Encrypted File Sharing Chunking Test!';
    const rawData = new TextEncoder().encode(originalText);

    // Create 16-byte chunks to test multi-chunk reassembly
    const { meta, chunks } = await FileTransferManager.createTransfer(
      'secret.txt',
      'text/plain',
      rawData,
      16,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(meta.totalChunks).toBe(chunks.length);

    const receiver = new FileTransferManager();
    receiver.registerIncoming(meta);

    let reassembled: Uint8Array | undefined;
    for (const chunk of chunks) {
      const res = await receiver.processChunk(chunk);
      if (res.complete) {
        reassembled = res.data;
      }
    }

    expect(reassembled).toBeDefined();
    expect(new TextDecoder().decode(reassembled!)).toBe(originalText);
  });
});
