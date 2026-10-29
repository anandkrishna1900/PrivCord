import {
  MAX_CLIENT_MESSAGE_ID_LENGTH,
  MAX_TEXT_LENGTH,
  PROTOCOL_VERSION,
} from './constants';

export type DeliveryState = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
export type TransportKind = 'cloud' | 'p2p';
export type MessageType = 'text';

export interface ChatMessage {
  messageId: string;
  clientMessageId: string;
  senderId: string;
  text: string;
  /** Sender's clock at composition time. Ordering key (with messageId as tie-breaker). */
  clientCreatedAt: number;
  /** Present only once the message exists in Firestore. */
  serverCreatedAt?: number | null;
  type: MessageType;
  transport: TransportKind;
  deliveryState: DeliveryState;
  /** True once the message has been persisted to the cloud (or received from it). */
  syncedToCloud: boolean;
  /** Local-only read timestamp for incoming messages. */
  readAt?: number | null;
}

export interface CloudMessagePayload {
  messageId: string;
  senderId: string;
  text: string;
  clientCreatedAt: number;
  type: MessageType;
  clientMessageId: string;
  transport: TransportKind;
  createdAt?: unknown;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function createMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function countCodePoints(text: string): number {
  return Array.from(text).length;
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function validateOutgoingText(raw: string): ValidationResult<string> {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Message must be text.' };
  }
  const text = normalizeNewlines(raw);
  if (text.trim().length === 0) {
    return { ok: false, error: 'Message cannot be empty.' };
  }
  if (countCodePoints(text) > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      error: `Message exceeds the ${MAX_TEXT_LENGTH.toLocaleString()} character limit.`,
    };
  }
  return { ok: true, value: text };
}

export function validateClientMessageId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CLIENT_MESSAGE_ID_LENGTH
  );
}

export function validateIncomingText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    countCodePoints(value) <= MAX_TEXT_LENGTH
  );
}

export function createOutgoingMessage(input: {
  senderId: string;
  text: string;
  now?: number;
  transport?: TransportKind;
  messageId?: string;
}): ChatMessage {
  const validation = validateOutgoingText(input.text);
  if (!validation.ok) throw new ProtocolError(validation.error);
  if (!input.senderId) throw new ProtocolError('A sender is required.');
  const messageId = input.messageId ?? createMessageId();
  if (!validateClientMessageId(messageId)) {
    throw new ProtocolError('Invalid message identifier.');
  }
  return {
    messageId,
    clientMessageId: messageId,
    senderId: input.senderId,
    text: validation.value,
    clientCreatedAt: input.now ?? Date.now(),
    serverCreatedAt: null,
    type: 'text',
    transport: input.transport ?? 'cloud',
    deliveryState: 'QUEUED',
    syncedToCloud: false,
    readAt: null,
  };
}

const DELIVERY_RANK: Record<DeliveryState, number> = {
  QUEUED: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  FAILED: 0,
};

export function highestDeliveryState(
  a: DeliveryState,
  b: DeliveryState,
): DeliveryState {
  if (a === 'FAILED' && b === 'FAILED') return 'FAILED';
  if (a === 'FAILED') return b;
  if (b === 'FAILED') return a;
  return DELIVERY_RANK[a] >= DELIVERY_RANK[b] ? a : b;
}

/** Convert a Cloud Firestore message document into the local model. */
export function fromCloudMessage(
  id: string,
  data: Record<string, unknown>,
): ValidationResult<ChatMessage> {
  const senderId = data.senderId;
  const text = data.text;
  if (typeof senderId !== 'string' || senderId.length === 0) {
    return { ok: false, error: 'Cloud message has no sender.' };
  }
  if (!validateIncomingText(text)) {
    return { ok: false, error: 'Cloud message has invalid text.' };
  }
  const messageId = typeof data.messageId === 'string' ? data.messageId : id;
  if (messageId !== id) {
    return { ok: false, error: 'Cloud message id mismatch.' };
  }
  if (!validateClientMessageId(data.clientMessageId)) {
    return { ok: false, error: 'Cloud message has invalid clientMessageId.' };
  }
  if (
    data.type !== 'text' ||
    (data.transport !== 'cloud' && data.transport !== 'p2p')
  ) {
    return { ok: false, error: 'Unsupported cloud message type.' };
  }
  const clientCreatedAt = Number(data.clientCreatedAt);
  if (!Number.isFinite(clientCreatedAt) || clientCreatedAt <= 0) {
    return { ok: false, error: 'Cloud message has invalid timestamp.' };
  }
  const serverCreatedAt =
    typeof (data.createdAt as { toMillis?: unknown } | undefined)?.toMillis ===
    'function'
      ? (data.createdAt as { toMillis: () => number }).toMillis()
      : null;
  return {
    ok: true,
    value: {
      messageId,
      clientMessageId: data.clientMessageId,
      senderId,
      text: text as string,
      clientCreatedAt,
      serverCreatedAt,
      type: 'text',
      transport: data.transport,
      deliveryState: 'DELIVERED',
      syncedToCloud: true,
      readAt: null,
    },
  };
}

export function toCloudMessagePayload(
  message: ChatMessage,
): CloudMessagePayload {
  return {
    messageId: message.messageId,
    senderId: message.senderId,
    text: message.text,
    clientCreatedAt: message.clientCreatedAt,
    type: 'text',
    clientMessageId: message.clientMessageId,
    transport: message.transport,
  };
}

/** Wire frame sent over a WebRTC data channel. */
export interface PeerMessageFrame {
  v: typeof PROTOCOL_VERSION;
  kind: 'message';
  messageId: string;
  clientMessageId: string;
  senderId: string;
  text: string;
  clientCreatedAt: number;
}

export function createPeerMessageFrame(
  message: ChatMessage,
): PeerMessageFrame {
  return {
    v: PROTOCOL_VERSION,
    kind: 'message',
    messageId: message.messageId,
    clientMessageId: message.clientMessageId,
    senderId: message.senderId,
    text: message.text,
    clientCreatedAt: message.clientCreatedAt,
  };
}

export function parsePeerMessageFrame(value: unknown): ChatMessage | null {
  if (!isRecord(value) || value.kind !== 'message') return null;
  if (value.v !== PROTOCOL_VERSION) return null;
  const { messageId, clientMessageId, senderId, clientCreatedAt } = value;
  if (!validateClientMessageId(messageId)) return null;
  if (!validateClientMessageId(clientMessageId)) return null;
  if (typeof senderId !== 'string' || senderId.length === 0) return null;
  if (!validateIncomingText(value.text)) return null;
  if (
    typeof clientCreatedAt !== 'number' ||
    !Number.isFinite(clientCreatedAt) ||
    clientCreatedAt <= 0
  ) {
    return null;
  }
  return {
    messageId,
    clientMessageId,
    senderId,
    text: value.text,
    clientCreatedAt,
    serverCreatedAt: null,
    type: 'text',
    transport: 'p2p',
    deliveryState: 'DELIVERED',
    syncedToCloud: false,
    readAt: null,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
