import { describe, expect, it } from 'vitest';
import { deriveConnectionMode, presentConnection } from '../src';

describe('connection modes', () => {
  it('derives every mode', () => {
    expect(deriveConnectionMode({ p2pConnected: true })).toBe('P2P_CONNECTED');
    expect(deriveConnectionMode({ p2pConnected: false })).toBe('OFFLINE_QUEUED');
    expect(deriveConnectionMode({ p2pConnected: false, connecting: true })).toBe('CONNECTING');
    expect(deriveConnectionMode({ p2pConnected: false, reconnecting: true })).toBe('RECONNECTING');
    expect(deriveConnectionMode({ p2pConnected: false, failed: true })).toBe('CONNECTION_FAILED');
  });

  it('describes direct operation honestly', () => {
    const presentation = presentConnection('P2P_CONNECTED');
    expect(presentation.detail).toMatch(/never touch a server/i);
    expect(presentation.tone).toBe('direct');
  });

  it('shows queued count while offline', () => {
    expect(presentConnection('OFFLINE_QUEUED', 3).label).toContain('3 queued');
  });
});
