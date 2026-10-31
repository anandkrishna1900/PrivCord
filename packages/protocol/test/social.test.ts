import { describe, expect, it } from 'vitest';
import {
  BACKUP_PREFIX,
  REACTION_EMOJI,
  createOutgoingMessage,
  createPeerMessageFrame,
  deleteFrame,
  isInlineAudio,
  makeFileOffer,
  openBackup,
  parseDeleteFrame,
  parseFileOffer,
  parsePeerMessageFrame,
  parseReactFrame,
  parseGroupFrame,
  reactFrame,
  sealBackup,
  summarizeReactions,
} from '../src';

describe('delete and reactions', () => {
  it('delete frames carry just a message id', () => {
    expect(parseDeleteFrame(JSON.parse(JSON.stringify(deleteFrame('m-1'))))?.messageId).toBe('m-1');
    expect(parseDeleteFrame({ v: 1, kind: 'delete', messageId: '' })).toBeNull();
    expect(parseDeleteFrame({ v: 2, kind: 'delete', messageId: 'm' })).toBeNull();
    expect(parseDeleteFrame(null)).toBeNull();
  });

  it('reactions allow only the offered emoji', () => {
    for (const e of REACTION_EMOJI) expect(parseReactFrame(reactFrame('m-1', e, true))?.emoji).toBe(e);
    expect(parseReactFrame({ v: 1, kind: 'react', messageId: 'm', emoji: '💣', on: true })).toBeNull();
    expect(parseReactFrame({ v: 1, kind: 'react', messageId: 'm', emoji: '👍'.repeat(500), on: true })).toBeNull();
    expect(parseReactFrame({ v: 1, kind: 'react', messageId: 'm', emoji: '👍', on: 'yes' })).toBeNull();
  });

  it('shows each emoji once with a count and whether I reacted', () => {
    const s = summarizeReactions({ a: '👍', b: '👍', me: '❤️' }, 'me');
    expect(s).toEqual([{ emoji: '👍', count: 2, mine: false }, { emoji: '❤️', count: 1, mine: true }]);
    expect(summarizeReactions(undefined, 'me')).toEqual([]);
  });


  it('knows which audio plays inline', () => {
    expect(isInlineAudio('audio/webm;codecs=opus')).toBe(true);
    expect(isInlineAudio('audio/mp4')).toBe(true);
    expect(isInlineAudio('video/mp4')).toBe(false);
    expect(isInlineAudio('application/octet-stream')).toBe(false);
  });
});

describe('encrypted backup', () => {
  it('opens with the passphrase and only with the passphrase', async () => {
    const data = { contacts: [{ uid: 'u1', name: 'Ann' }], messages: ['hello'] };
    const text = await sealBackup(data, 'correct horse battery');
    expect(text.startsWith(BACKUP_PREFIX)).toBe(true);
    expect(text).not.toContain('Ann');
    expect(await openBackup(text, 'correct horse battery')).toEqual(data);
    expect(await openBackup(text, 'wrong passphrase!')).toBeNull();
    expect(await openBackup(text.slice(0, -6) + 'AAAAAA', 'correct horse battery')).toBeNull();
    expect(await openBackup('not a backup', 'correct horse battery')).toBeNull();
    await expect(sealBackup(data, 'short')).rejects.toThrow(/at least 8/);
  }, 30_000);
});
