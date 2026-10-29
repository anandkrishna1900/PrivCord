import { describe, expect, it } from 'vitest';
import type { OutboxRow } from './localDb';
import {
  allowsCloudWrites,
  canAttemptDelivery,
  chooseRoute,
  retryDelayMs,
  shouldAttempt,
} from './outbox';

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    messageId: 'message-1',
    recipientId: 'peer-1',
    payload: '{}',
    createdAt: 1_000,
    attemptCount: 0,
    lastAttemptAt: null,
    deliveryState: 'QUEUED',
    lastError: null,
    ...overrides,
  };
}

describe('chooseRoute', () => {
  it('prefers the durable cloud path', () => {
    expect(chooseRoute({ cloudConnected: true, p2pConnected: true })).toBe('cloud');
    expect(chooseRoute({ cloudConnected: true, p2pConnected: false })).toBe('cloud');
  });

  it('uses peer transport only while cloud is unavailable', () => {
    expect(chooseRoute({ cloudConnected: false, p2pConnected: true })).toBe('p2p');
  });

  it('queues when neither transport is ready', () => {
    expect(chooseRoute({ cloudConnected: false, p2pConnected: false })).toBe('queue');
  });
});

describe('message mode routing', () => {
  it('disables cloud writes in direct mode', () => {
    expect(allowsCloudWrites('direct')).toBe(false);
    expect(allowsCloudWrites('cloud')).toBe(true);
  });

  it('does not fall back to cloud in direct mode', () => {
    expect(
      canAttemptDelivery({
        mode: 'direct',
        cloudConnected: true,
        p2pConnected: false,
      }),
    ).toBe(false);
    expect(
      canAttemptDelivery({
        mode: 'direct',
        cloudConnected: false,
        p2pConnected: true,
      }),
    ).toBe(true);
  });

  it('preserves cloud and direct attempts in cloud mode', () => {
    expect(
      canAttemptDelivery({
        mode: 'cloud',
        cloudConnected: true,
        p2pConnected: false,
      }),
    ).toBe(true);
    expect(
      canAttemptDelivery({
        mode: 'cloud',
        cloudConnected: false,
        p2pConnected: true,
      }),
    ).toBe(true);
    expect(
      canAttemptDelivery({
        mode: 'cloud',
        cloudConnected: false,
        p2pConnected: false,
      }),
    ).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially from two seconds', () => {
    expect(retryDelayMs(0)).toBe(2_000);
    expect(retryDelayMs(1)).toBe(4_000);
    expect(retryDelayMs(2)).toBe(8_000);
    expect(retryDelayMs(3)).toBe(16_000);
  });

  it('caps attempts at thirty seconds', () => {
    expect(retryDelayMs(4)).toBe(30_000);
    expect(retryDelayMs(6)).toBe(30_000);
    expect(retryDelayMs(100)).toBe(30_000);
  });
});

describe('shouldAttempt', () => {
  it('attempts a never-tried row immediately', () => {
    expect(shouldAttempt(row(), 1_000)).toBe(true);
  });

  it('respects the current backoff window', () => {
    expect(
      shouldAttempt(row({ attemptCount: 1, lastAttemptAt: 10_000 }), 13_999),
    ).toBe(false);
    expect(
      shouldAttempt(row({ attemptCount: 1, lastAttemptAt: 10_000 }), 14_000),
    ).toBe(true);
  });

  it('never retries a permanently failed row', () => {
    expect(
      shouldAttempt(
        row({ deliveryState: 'FAILED', attemptCount: 0, lastAttemptAt: 1_000 }),
        1_000_000,
      ),
    ).toBe(false);
  });
});
