import {
  ChatMessage,
  DeliveryState,
  highestDeliveryState,
} from './message';

/**
 * Documented ordering policy: sender clock first, then stable message id.
 * Server timestamps are metadata and never reorder the local transcript.
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
 * Merge two transcripts without duplicates. Newer delivery state wins, and the
 * cloud copy is authoritative for text/metadata while local-only fields
 * (readAt) are preserved.
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
  const preferIncoming = incoming.syncedToCloud && !current.syncedToCloud;
  const base = preferIncoming ? incoming : current;
  const other = preferIncoming ? current : incoming;
  const deliveryState: DeliveryState = highestDeliveryState(
    current.deliveryState,
    incoming.deliveryState,
  );
  return {
    ...base,
    deliveryState,
    syncedToCloud: current.syncedToCloud || incoming.syncedToCloud,
    serverCreatedAt: base.serverCreatedAt ?? other.serverCreatedAt ?? null,
    readAt: current.readAt ?? incoming.readAt ?? null,
  };
}

/** True when a state is terminal for retry purposes. */
export function isRetryable(state: DeliveryState): boolean {
  return state === 'FAILED' || state === 'QUEUED';
}
