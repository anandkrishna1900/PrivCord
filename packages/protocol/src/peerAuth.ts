import { AUTH_TIMEOUT_MS, PROTOCOL_VERSION } from './constants';
import { isRecord } from './message';
import { isValidPublicJwk } from './signaling';

export interface AuthHello {
  v: typeof PROTOCOL_VERSION;
  kind: 'hello';
  uid: string;
  deviceId: string;
  publicKeyJwk: JsonWebKey;
  dhJwk: JsonWebKey;
  identityProof: string;
  nonce: string;
}

export interface AuthProof {
  v: typeof PROTOCOL_VERSION;
  kind: 'auth_proof';
  uid: string;
  signature: string;
}

export interface AuthAck {
  v: typeof PROTOCOL_VERSION;
  kind: 'auth_ok';
  uid: string;
}

export interface AckFrame {
  v: typeof PROTOCOL_VERSION;
  kind: 'ack';
  messageId: string;
  state: 'DELIVERED' | 'READ';
  at: number;
}

export interface ReadFrame {
  v: typeof PROTOCOL_VERSION;
  kind: 'read';
  lastReadMessageId: string;
  at: number;
}

/** Liveness probe: lets each side notice a dead link within seconds. Answer a ping with a pong. */
export interface PingFrame {
  v: typeof PROTOCOL_VERSION;
  kind: 'ping' | 'pong';
  at: number;
}

export type PeerControlFrame = AuthHello | AuthProof | AuthAck | AckFrame | ReadFrame | PingFrame;

export function randomNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Canonical string signed by each side. Both users must observe the same
 * conversation id, identity, device, and fresh nonces. This binds the proof to
 * this specific connection attempt and rejects replayed proofs.
 */
export function authChallenge(input: {
  conversationId: string;
  uid: string;
  deviceId: string;
  nonceSelf: string;
  noncePeer: string;
}): string {
  return [
    'duochat-peer-auth-v1',
    input.conversationId,
    input.uid,
    input.deviceId,
    input.nonceSelf,
    input.noncePeer,
  ].join('\n');
}

export function parsePeerFrame(value: unknown): PeerControlFrame | null {
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION) return null;
  switch (value.kind) {
    case 'hello': {
      if (
        typeof value.uid === 'string' &&
        value.uid.length > 0 &&
        typeof value.deviceId === 'string' &&
        value.deviceId.length > 0 &&
        typeof value.nonce === 'string' &&
        value.nonce.length >= 16 &&
        isValidPublicJwk(value.publicKeyJwk) &&
        isValidPublicJwk(value.dhJwk) &&
        typeof value.identityProof === 'string' &&
        value.identityProof.length >= 40
      ) {
        return {
          v: PROTOCOL_VERSION,
          kind: 'hello',
          uid: value.uid,
          deviceId: value.deviceId,
          publicKeyJwk: value.publicKeyJwk,
          dhJwk: value.dhJwk,
          identityProof: value.identityProof,
          nonce: value.nonce,
        };
      }
      return null;
    }
    case 'auth_proof': {
      if (
        typeof value.uid === 'string' &&
        value.uid.length > 0 &&
        typeof value.signature === 'string' &&
        value.signature.length > 40
      ) {
        return {
          v: PROTOCOL_VERSION,
          kind: 'auth_proof',
          uid: value.uid,
          signature: value.signature,
        };
      }
      return null;
    }
    case 'ping':
    case 'pong': {
      if (typeof value.at === 'number' && Number.isFinite(value.at)) {
        return { v: PROTOCOL_VERSION, kind: value.kind, at: value.at };
      }
      return null;
    }
    case 'auth_ok': {
      if (typeof value.uid === 'string' && value.uid.length > 0) {
        return { v: PROTOCOL_VERSION, kind: 'auth_ok', uid: value.uid };
      }
      return null;
    }
    case 'ack': {
      if (
        typeof value.messageId === 'string' &&
        value.messageId.length > 0 &&
        (value.state === 'DELIVERED' || value.state === 'READ') &&
        typeof value.at === 'number' &&
        Number.isFinite(value.at)
      ) {
        return {
          v: PROTOCOL_VERSION,
          kind: 'ack',
          messageId: value.messageId,
          state: value.state,
          at: value.at,
        };
      }
      return null;
    }
    case 'read': {
      if (
        typeof value.lastReadMessageId === 'string' &&
        value.lastReadMessageId.length > 0 &&
        typeof value.at === 'number' &&
        Number.isFinite(value.at)
      ) {
        return {
          v: PROTOCOL_VERSION,
          kind: 'read',
          lastReadMessageId: value.lastReadMessageId,
          at: value.at,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

export { AUTH_TIMEOUT_MS };
