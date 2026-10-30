import type { DeliveryState } from '@duochat/protocol';

/** Own messages the peer has not acknowledged yet; resent whenever the direct channel opens. */
export function needsDelivery(state: DeliveryState): boolean {
  return state !== 'DELIVERED' && state !== 'READ';
}
