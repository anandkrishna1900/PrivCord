import { describe, expect, it } from 'vitest';
import { encodeTurnShare, parseTurnShare, TURN_SHARE_PREFIX } from '../src';

describe('relay (TURN) share string', () => {
  const turn = { urls: ['turn:relay.example.org:3478', 'turns:relay.example.org:5349?transport=tcp'], username: 'friend', credential: 'pä$$ w0rd' };
  it('round-trips, including odd characters', () => {
    const s = encodeTurnShare(turn);
    expect(s.startsWith(TURN_SHARE_PREFIX)).toBe(true);
    expect(parseTurnShare(`  ${s}\n`)).toEqual(turn);
  });
  it('rejects anything malformed or not a turn address', () => {
    expect(parseTurnShare('hello')).toBeNull();
    expect(parseTurnShare(TURN_SHARE_PREFIX + '!!!')).toBeNull();
    expect(parseTurnShare(encodeTurnShare({ ...turn, urls: ['http://evil.example'] }))).toBeNull();
    expect(parseTurnShare(encodeTurnShare({ ...turn, urls: [...turn.urls, 'javascript:1'] }))).toBeNull();
    expect(parseTurnShare(encodeTurnShare({ ...turn, credential: '' }))).toBeNull();
    expect(parseTurnShare(TURN_SHARE_PREFIX + 'x'.repeat(3000))).toBeNull();
  });
});

describe('the relay kit script', () => {
  it('prints a line the app accepts', async () => {
    const { execFileSync } = await import('node:child_process');
    const line = execFileSync('node', ['../../docs/turn-server/make-share-line.mjs', 'relay.example.org', 'secret pw'], { encoding: 'utf8' }).trim();
    expect(parseTurnShare(line)).toEqual({ urls: ['turn:relay.example.org:3478', 'turn:relay.example.org:3478?transport=tcp'], username: 'privcord', credential: 'secret pw' });
  });
});
