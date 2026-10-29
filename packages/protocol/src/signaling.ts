import {
  MANUAL_SIGNAL_PREFIX,
  MAX_MANUAL_SIGNAL_BYTES,
  PROTOCOL_VERSION,
} from './constants';
import { isRecord } from './message';

export const SIGNAL_KINDS = ['offer', 'answer'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/**
 * Self-contained SDP + identity bundle used when the signaling service is
 * unavailable. It is transport data, never proof of identity. The two users
 * must compare the safety number shown by both apps before trusting it.
 */
export interface ManualSignal {
  v: typeof PROTOCOL_VERSION;
  kind: SignalKind;
  conversationId: string;
  fromUid: string;
  fromDeviceId: string;
  publicKeyJwk: JsonWebKey;
  sdp: string;
  nonce: string;
  createdAt: number;
}

export type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function isValidPublicJwk(value: unknown): value is JsonWebKey {
  return (
    isRecord(value) &&
    value.kty === 'EC' &&
    value.crv === 'P-256' &&
    typeof value.x === 'string' &&
    value.x.length >= 40 &&
    typeof value.y === 'string' &&
    value.y.length >= 40
  );
}

export function publicKeysEqual(
  a: JsonWebKey | null | undefined,
  b: JsonWebKey | null | undefined,
): boolean {
  if (!isValidPublicJwk(a) || !isValidPublicJwk(b)) return false;
  return a.x === b.x && a.y === b.y && a.crv === b.crv && a.kty === b.kty;
}

export function encodeManualSignal(signal: ManualSignal): string {
  const json = JSON.stringify(signal);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const base64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${MANUAL_SIGNAL_PREFIX}${base64}`;
}

export function createManualSignal(input: Omit<ManualSignal, 'v' | 'createdAt'> & {
  createdAt?: number;
}): ManualSignal {
  return {
    v: PROTOCOL_VERSION,
    kind: input.kind,
    conversationId: input.conversationId,
    fromUid: input.fromUid,
    fromDeviceId: input.fromDeviceId,
    publicKeyJwk: input.publicKeyJwk,
    sdp: input.sdp,
    nonce: input.nonce,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function decodeManualSignal(
  encoded: string,
  expectedConversationId: string,
): DecodeResult<ManualSignal> {
  const trimmed = encoded.trim();
  if (!trimmed.startsWith(MANUAL_SIGNAL_PREFIX)) {
    return { ok: false, error: 'This is not a DuoChat connection code.' };
  }
  const base64 = trimmed.slice(MANUAL_SIGNAL_PREFIX.length);
  if (base64.length > MAX_MANUAL_SIGNAL_BYTES) {
    return { ok: false, error: 'Connection code is too large.' };
  }
  let json: string;
  try {
    const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    json = new TextDecoder().decode(bytes);
  } catch {
    return { ok: false, error: 'Connection code is malformed.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Connection code is malformed.' };
  }
  return validateManualSignal(parsed, expectedConversationId);
}

export function validateManualSignal(
  value: unknown,
  expectedConversationId: string,
): DecodeResult<ManualSignal> {
  if (!isRecord(value)) {
    return { ok: false, error: 'Connection code is malformed.' };
  }
  if (value.v !== PROTOCOL_VERSION) {
    return { ok: false, error: 'Unsupported connection code version.' };
  }
  if (value.kind !== 'offer' && value.kind !== 'answer') {
    return { ok: false, error: 'Connection code has an invalid type.' };
  }
  if (
    typeof value.conversationId !== 'string' ||
    value.conversationId !== expectedConversationId
  ) {
    return { ok: false, error: 'Connection code belongs to another conversation.' };
  }
  if (typeof value.fromUid !== 'string' || value.fromUid.length === 0) {
    return { ok: false, error: 'Connection code has no sender.' };
  }
  if (typeof value.fromDeviceId !== 'string' || value.fromDeviceId.length === 0) {
    return { ok: false, error: 'Connection code has no device.' };
  }
  if (!isValidPublicJwk(value.publicKeyJwk)) {
    return { ok: false, error: 'Connection code has an invalid identity key.' };
  }
  if (
    typeof value.sdp !== 'string' ||
    value.sdp.length < 20 ||
    value.sdp.length > MAX_MANUAL_SIGNAL_BYTES ||
    !value.sdp.includes('v=0')
  ) {
    return { ok: false, error: 'Connection code has an invalid session description.' };
  }
  if (typeof value.nonce !== 'string' || value.nonce.length < 16) {
    return { ok: false, error: 'Connection code has an invalid nonce.' };
  }
  if (
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt <= 0
  ) {
    return { ok: false, error: 'Connection code has an invalid timestamp.' };
  }
  return {
    ok: true,
    value: {
      v: PROTOCOL_VERSION,
      kind: value.kind,
      conversationId: value.conversationId,
      fromUid: value.fromUid,
      fromDeviceId: value.fromDeviceId,
      publicKeyJwk: value.publicKeyJwk,
      sdp: value.sdp,
      nonce: value.nonce,
      createdAt: value.createdAt,
    },
  };
}
