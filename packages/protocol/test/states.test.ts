import { describe, expect, it } from 'vitest';
import { deriveConnectionMode, presentConnection } from '../src';

describe('connection modes', () => {
  it('derives all combined modes', () => {
    expect(
      deriveConnectionMode({ cloudConnected: true, p2pConnected: true }),
    ).toBe('CLOUD_AND_P2P_CONNECTED');
    expect(
      deriveConnectionMode({ cloudConnected: true, p2pConnected: false }),
    ).toBe('CLOUD_CONNECTED');
    expect(
      deriveConnectionMode({ cloudConnected: false, p2pConnected: true }),
    ).toBe('P2P_CONNECTED');
    expect(
      deriveConnectionMode({ cloudConnected: false, p2pConnected: false }),
    ).toBe('OFFLINE_QUEUED');
    expect(
      deriveConnectionMode({
        cloudConnected: false,
        p2pConnected: false,
        connecting: true,
      }),
    ).toBe('CONNECTING');
    expect(
      deriveConnectionMode({
        cloudConnected: false,
        p2pConnected: false,
        reconnecting: true,
      }),
    ).toBe('RECONNECTING');
    expect(
      deriveConnectionMode({
        cloudConnected: false,
        p2pConnected: false,
        failed: true,
      }),
    ).toBe('CONNECTION_FAILED');
  });

  it('describes direct-only operation honestly', () => {
    const presentation = presentConnection('P2P_CONNECTED');
    expect(presentation.detail).toMatch(/cloud sync is unavailable/i);
    expect(presentation.tone).toBe('direct');
  });

  it('shows queued count while offline', () => {
    expect(presentConnection('OFFLINE_QUEUED', 3).label).toContain('3 queued');
  });
});
