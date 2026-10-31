import { describe, expect, it } from 'vitest';
import { GroupSessionManager } from '../src/e2ee/groupCrypto';

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
