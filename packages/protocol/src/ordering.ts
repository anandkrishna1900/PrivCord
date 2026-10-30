import {
  ChatMessage,
  DeliveryState,
  highestDeliveryState,
} from './message';

/**
 * Documented ordering policy: sender clock first, then stable message id.
 * Receive time never reorders the local transcript.
 */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.clientCreatedAt !== b.clientCreatedAt) {
    return a.clientCreatedAt - b.clientCreatedAt;
  }
  return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
}

export function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort(compareMessages);
}

/**
 * Merge two transcripts without duplicates. Newer delivery state wins, and
 * local-only fields (readAt) are preserved.
 */
export function mergeMessages(
  existing: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of existing) byId.set(message.messageId, message);
  for (const message of incoming) {
    const current = byId.get(message.messageId);
    if (!current) {
      byId.set(message.messageId, message);
      continue;
    }
    byId.set(message.messageId, mergeOne(current, message));
  }
  return sortMessages([...byId.values()]);
}

function mergeOne(current: ChatMessage, incoming: ChatMessage): ChatMessage {
  return {
    ...current,
    deliveryState: highestDeliveryState(current.deliveryState, incoming.deliveryState),
    readAt: current.readAt ?? incoming.readAt ?? null,
  };
}

/** True when a state is terminal for retry purposes. */
export function isRetryable(state: DeliveryState): boolean {
  return state === 'FAILED' || state === 'QUEUED';
}
