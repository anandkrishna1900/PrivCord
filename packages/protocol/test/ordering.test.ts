import { describe, expect, it } from 'vitest';
import {
  ChatMessage,
  compareMessages,
  createOutgoingMessage,
  mergeMessages,
  sortMessages,
} from '../src';

function msg(id: string, at: number, state: ChatMessage['deliveryState'] = 'QUEUED'): ChatMessage {
  return {
    ...createOutgoingMessage({ senderId: 'uid-a', text: `m-${id}`, now: at, messageId: id }),
    deliveryState: state,
  };
}

describe('ordering', () => {
  it('orders by sender time then message id deterministically', () => {
    const list = [msg('c', 100), msg('b', 100), msg('a', 50)];
    expect(sortMessages(list).map((m) => m.messageId)).toEqual(['a', 'b', 'c']);
  });

  it('keeps compare consistent', () => {
    expect(compareMessages(msg('a', 1), msg('b', 2))).toBeLessThan(0);
    expect(compareMessages(msg('b', 2), msg('a', 1))).toBeGreaterThan(0);
    expect(compareMessages(msg('a', 1), msg('a', 1))).toBe(0);
  });
});

describe('merge and dedupe', () => {
  it('deduplicates by message id', () => {
    const merged = mergeMessages([msg('a', 1)], [msg('a', 1), msg('b', 2)]);
    expect(merged).toHaveLength(2);
  });

  it('promotes delivery state and cloud sync without duplicating', () => {
    const local = msg('a', 1, 'SENT');
    const cloud = { ...msg('a', 1, 'DELIVERED'), syncedToCloud: true };
    const merged = mergeMessages([local], [cloud]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.deliveryState).toBe('DELIVERED');
    expect(merged[0]?.syncedToCloud).toBe(true);
  });

  it('never regresses a read receipt', () => {
    const local = { ...msg('a', 1, 'READ'), readAt: 99 };
    const cloud = { ...msg('a', 1, 'DELIVERED'), syncedToCloud: true };
    const merged = mergeMessages([local], [cloud]);
    expect(merged[0]?.deliveryState).toBe('READ');
    expect(merged[0]?.readAt).toBe(99);
  });

  it('keeps a failed message retryable', () => {
    const merged = mergeMessages([msg('a', 1, 'FAILED')], [msg('a', 1, 'QUEUED')]);
    expect(merged[0]?.deliveryState).toBe('QUEUED');
  });
});
