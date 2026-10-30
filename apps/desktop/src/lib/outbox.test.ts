import { describe, expect, it } from 'vitest';
import { needsDelivery } from './outbox';

describe('needsDelivery', () => {
  it('resends anything the peer has not acknowledged', () => {
    expect(needsDelivery('QUEUED')).toBe(true);
    expect(needsDelivery('SENT')).toBe(true);
    expect(needsDelivery('FAILED')).toBe(true);
  });

  it('never resends acknowledged messages', () => {
    expect(needsDelivery('DELIVERED')).toBe(false);
    expect(needsDelivery('READ')).toBe(false);
  });
});
