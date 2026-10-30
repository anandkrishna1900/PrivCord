import { isRecord } from './message';
import { isValidPublicJwk, publicKeysEqual } from './signaling';

export const PAIRING_RECORD_VERSION = 1 as const;

export type PairingStatus = 'UNPAIRED' | 'SAVED' | 'CONNECTING' | 'CONNECTED' | 'OFFLINE';

export interface PairingRecord {
  version: typeof PAIRING_RECORD_VERSION;
  peerUid: string;
  peerDeviceId: string;
  publicKeyJwk: JsonWebKey;
  /** Contact's ECDH identity key; needed to seal blobs to them. */
  dhJwk?: JsonWebKey;
  safetyNumber: string;
  pairedAt: number;
  lastConnectedAt: number;
}

export interface PairingStoreState {
  record: PairingRecord | null;
  autoReconnect: boolean;
}

export interface PairingStatusInput {
  saved: boolean;
  connected: boolean;
  connecting: boolean;
  failed: boolean;
}

export interface ReconnectBackoffOptions {
  baseMs?: number;
  maxMs?: number;
}

export const EMPTY_PAIRING_STATE: PairingStoreState = {
  record: null,
  autoReconnect: true,
};

export const RECONNECT_BASE_MS = 5_000;
export const RECONNECT_MAX_MS = 120_000;

export function isPairingRecord(
  value: unknown,
  expectedPeerUid?: string,
): value is PairingRecord {
  if (!isRecord(value)) return false;
  if (value.version !== PAIRING_RECORD_VERSION) return false;
  if (typeof value.peerUid !== 'string' || value.peerUid.length === 0) return false;
  if (expectedPeerUid !== undefined && value.peerUid !== expectedPeerUid) return false;
  if (typeof value.peerDeviceId !== 'string' || value.peerDeviceId.length === 0) return false;
  if (!isValidPublicJwk(value.publicKeyJwk)) return false;
  if (value.dhJwk !== undefined && !isValidPublicJwk(value.dhJwk)) return false;
  if (typeof value.safetyNumber !== 'string' || value.safetyNumber.length === 0) return false;
  if (typeof value.pairedAt !== 'number' || !Number.isFinite(value.pairedAt)) return false;
  if (
    typeof value.lastConnectedAt !== 'number' ||
    !Number.isFinite(value.lastConnectedAt)
  ) {
    return false;
  }
  return true;
}

export function parsePairingState(
  raw: string | null | undefined,
  expectedPeerUid?: string,
): PairingStoreState {
  if (!raw) return { ...EMPTY_PAIRING_STATE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_PAIRING_STATE };
  }
  if (!isRecord(parsed) || parsed.version !== PAIRING_RECORD_VERSION) {
    return { ...EMPTY_PAIRING_STATE };
  }
  const record = isPairingRecord(parsed.record, expectedPeerUid)
    ? parsed.record
    : null;
  return {
    record,
    autoReconnect: typeof parsed.autoReconnect === 'boolean' ? parsed.autoReconnect : true,
  };
}

export function serializePairingState(state: PairingStoreState): string {
  return JSON.stringify({
    version: PAIRING_RECORD_VERSION,
    record: state.record,
    autoReconnect: state.autoReconnect,
  });
}

export function createPairingRecord(input: {
  peerUid: string;
  peerDeviceId: string;
  publicKeyJwk: JsonWebKey;
  dhJwk?: JsonWebKey;
  safetyNumber: string;
  previous?: PairingRecord | null;
  now?: number;
}): PairingRecord {
  const now = input.now ?? Date.now();
  const samePeer =
    input.previous?.peerUid === input.peerUid &&
    input.previous.peerDeviceId === input.peerDeviceId &&
    publicKeysEqual(input.previous.publicKeyJwk, input.publicKeyJwk);
  return {
    version: PAIRING_RECORD_VERSION,
    peerUid: input.peerUid,
    peerDeviceId: input.peerDeviceId,
    publicKeyJwk: input.publicKeyJwk,
    ...(input.dhJwk ? { dhJwk: input.dhJwk } : {}),
    safetyNumber: input.safetyNumber,
    pairedAt: samePeer ? input.previous!.pairedAt : now,
    lastConnectedAt: now,
  };
}

export function shouldPersistPairing(trust: string): boolean {
  return trust === 'verified' || trust === 'confirmed';
}

export function pairingMatchesPeer(
  record: PairingRecord | null,
  peerUid: string,
  deviceId: string,
  publicKeyJwk: JsonWebKey,
): boolean {
  return (
    record !== null &&
    record.peerUid === peerUid &&
    record.peerDeviceId === deviceId &&
    publicKeysEqual(record.publicKeyJwk, publicKeyJwk)
  );
}

export function derivePairingStatus(input: PairingStatusInput): PairingStatus {
  if (input.connected) return 'CONNECTED';
  if (input.connecting) return 'CONNECTING';
  if (input.saved && input.failed) return 'OFFLINE';
  if (input.saved) return 'SAVED';
  return 'UNPAIRED';
}

export function reconnectDelayMs(
  attempt: number,
  options: ReconnectBackoffOptions = {},
): number {
  const base = options.baseMs ?? RECONNECT_BASE_MS;
  const max = options.maxMs ?? RECONNECT_MAX_MS;
  if (!Number.isFinite(base) || base <= 0) return RECONNECT_BASE_MS;
  if (!Number.isFinite(max) || max < base) return base;
  const bounded = Math.max(0, Math.min(Math.floor(attempt), 8));
  return Math.min(max, base * 2 ** bounded);
}

export function canAutoReconnect(state: PairingStoreState): boolean {
  return state.record !== null && state.autoReconnect;
}
