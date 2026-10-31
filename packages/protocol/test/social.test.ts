import { describe, expect, it } from 'vitest';
import {
  BACKUP_PREFIX,
  REACTION_EMOJI,
  createOutgoingMessage,
  createPeerMessageFrame,
  deleteFrame,
  describeDisappear,
  isInlineAudio,
  makeFileOffer,
  openBackup,
  parseDeleteFrame,
  parseFileOffer,
  parsePeerMessageFrame,
  parseReactFrame,
  parseTtl,
  parseGroupFrame,
  reactFrame,
  sealBackup,
  summarizeReactions,
} from '../src';

describe('delete, reactions and disappearing messages', () => {
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

  it('a lifetime rides on messages, group messages and files, and bad ones are refused', () => {
    expect(parseTtl(undefined)).toBeUndefined();
    expect(parseTtl(3600)).toBe(3600);
    for (const bad of [0, -5, 1.5, 'x', 99_999_999, null]) expect(parseTtl(bad)).toBeNull();
    const m = { ...createOutgoingMessage({ senderId: 'a', text: 'hi' }), ttlSec: 86_400 };
    expect(parsePeerMessageFrame(JSON.parse(JSON.stringify(createPeerMessageFrame(m))))?.ttlSec).toBe(86_400);
    expect(parsePeerMessageFrame({ ...createPeerMessageFrame(m), ttl: -1 })).toBeNull();
    expect(parsePeerMessageFrame(createPeerMessageFrame({ ...m, ttlSec: undefined }))?.ttlSec).toBeUndefined();
    expect(parseGroupFrame({ v: 1, kind: 'gmsg', groupId: 'g', messageId: 'm-1', text: 'hi', clientCreatedAt: 5, ttl: 60 })?.kind).toBe('gmsg');
    expect(parseGroupFrame({ v: 1, kind: 'gmsg', groupId: 'g', messageId: 'm-1', text: 'hi', clientCreatedAt: 5, ttl: 0 })).toBeNull();
    return makeFileOffer({ messageId: 'f1', name: 'a.txt', mime: 'text/plain', bytes: new Uint8Array([1, 2, 3]), clientCreatedAt: 1, ttl: 3600 }).then((offer) => {
      expect(parseFileOffer(JSON.parse(JSON.stringify(offer)))?.ttl).toBe(3600);
      expect(parseFileOffer({ ...offer, ttl: 0 })).toBeNull();
    });
  });

  it('describes the options in plain words', () => {
    expect([0, 3600, 86_400, 604_800].map(describeDisappear)).toEqual(['Off', '1 hour', '1 day', '1 week']);
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
