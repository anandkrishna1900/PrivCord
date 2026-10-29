import type { OutboxRow } from './localDb';
import type { MessageMode } from './settings';

export type SendRoute = 'cloud' | 'p2p' | 'queue';

export function allowsCloudWrites(mode: MessageMode): boolean {
  return mode === 'cloud';
}

export function canAttemptDelivery(input: {
  mode: MessageMode;
  cloudConnected: boolean;
  p2pConnected: boolean;
}): boolean {
  if (input.mode === 'direct') return input.p2pConnected;
  return input.cloudConnected || input.p2pConnected;
}

export function chooseRoute(input: {
  cloudConnected: boolean;
  p2pConnected: boolean;
}): SendRoute {
  if (input.cloudConnected) return 'cloud';
  if (input.p2pConnected) return 'p2p';
  return 'queue';
}

export function retryDelayMs(attemptCount: number): number {
  const bounded = Math.max(0, Math.min(attemptCount, 6));
  return Math.min(30_000, 2_000 * 2 ** bounded);
}

export function shouldAttempt(row: OutboxRow, now: number): boolean {
  if (row.deliveryState === 'FAILED') return false;
  if (row.lastAttemptAt === null) return true;
  return now - row.lastAttemptAt >= retryDelayMs(row.attemptCount);
}

export function isQueuedForCloud(row: OutboxRow): boolean {
  return row.deliveryState !== 'FAILED';
}
