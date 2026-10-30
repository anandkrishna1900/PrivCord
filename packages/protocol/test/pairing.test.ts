import { describe, expect, it } from 'vitest';
import {
  canAutoReconnect,
  createPairingRecord,
  derivePairingStatus,
  EMPTY_PAIRING_STATE,
  pairingMatchesPeer,
  parsePairingState,
  reconnectDelayMs,
  serializePairingState,
  shouldPersistPairing,
} from '../src';

const KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'a'.repeat(43),
  y: 'b'.repeat(43),
};

const record = createPairingRecord({
  peerUid: 'peer-uid',
  peerDeviceId: 'peer-device',
  publicKeyJwk: KEY,
  safetyNumber: '00001 00002 00003 00004 00005 00006',
  now: 1_000,
});

describe('pairing records', () => {
  it('round-trips a valid saved peer', () => {
    const parsed = parsePairingState(
      serializePairingState({ record, autoReconnect: true }),
      'peer-uid',
    );
    expect(parsed.record).toMatchObject({
      peerUid: 'peer-uid',
      peerDeviceId: 'peer-device',
      safetyNumber: record.safetyNumber,
      pairedAt: 1_000,
    });
    expect(parsed.autoReconnect).toBe(true);
  });

  it('rejects malformed, mismatched, or unversioned records', () => {
    expect(parsePairingState(null)).toEqual(EMPTY_PAIRING_STATE);
    expect(parsePairingState('{not json')).toEqual(EMPTY_PAIRING_STATE);
    expect(
      parsePairingState(JSON.stringify({ version: 1, record, autoReconnect: true }), 'other'),
    ).toEqual({ record: null, autoReconnect: true });
    expect(
      parsePairingState(JSON.stringify({ version: 2, record, autoReconnect: false })),
    ).toEqual(EMPTY_PAIRING_STATE);
  });

  it('only persists verified or user-confirmed peers', () => {
    expect(shouldPersistPairing('verified')).toBe(true);
    expect(shouldPersistPairing('confirmed')).toBe(true);
    expect(shouldPersistPairing('unverified')).toBe(false);
    expect(shouldPersistPairing('none')).toBe(false);
  });

  it('matches the saved peer identity and rejects a changed key', () => {
    expect(pairingMatchesPeer(record, 'peer-uid', 'peer-device', KEY)).toBe(true);
    expect(pairingMatchesPeer(record, 'peer-uid', 'new-device', KEY)).toBe(false);
    expect(
      pairingMatchesPeer(record, 'peer-uid', 'peer-device', { ...KEY, x: 'c'.repeat(43) }),
    ).toBe(false);
  });

  it('preserves the original paired timestamp across reconnects', () => {
    const reconnected = createPairingRecord({
      peerUid: 'peer-uid',
      peerDeviceId: 'peer-device',
      publicKeyJwk: KEY,
      safetyNumber: record.safetyNumber,
      previous: record,
      now: 9_000,
    });
    expect(reconnected.pairedAt).toBe(1_000);
    expect(reconnected.lastConnectedAt).toBe(9_000);
  });
});

describe('pairing status and reconnect backoff', () => {
  it('derives the visible saved, connecting, connected, and offline states', () => {
    expect(
      derivePairingStatus({ saved: true, connected: false, connecting: false, failed: false }),
    ).toBe('SAVED');
    expect(
      derivePairingStatus({ saved: true, connected: false, connecting: true, failed: false }),
    ).toBe('CONNECTING');
    expect(
      derivePairingStatus({ saved: true, connected: true, connecting: false, failed: false }),
    ).toBe('CONNECTED');
    expect(
      derivePairingStatus({ saved: true, connected: false, connecting: false, failed: true }),
    ).toBe('OFFLINE');
    expect(
      derivePairingStatus({ saved: false, connected: false, connecting: false, failed: true }),
    ).toBe('UNPAIRED');
  });

  it('uses bounded exponential retry delays', () => {
    expect(reconnectDelayMs(0)).toBe(5_000);
    expect(reconnectDelayMs(1)).toBe(10_000);
    expect(reconnectDelayMs(3)).toBe(40_000);
    expect(reconnectDelayMs(20)).toBe(120_000);
    expect(reconnectDelayMs(-1)).toBe(5_000);
    expect(reconnectDelayMs(2, { baseMs: 1_000, maxMs: 2_500 })).toBe(2_500);
  });

  it('only auto-reconnects with a saved peer when enabled', () => {
    expect(canAutoReconnect({ record, autoReconnect: true })).toBe(true);
    expect(canAutoReconnect({ record, autoReconnect: false })).toBe(false);
    expect(canAutoReconnect({ record: null, autoReconnect: true })).toBe(false);
  });
});
