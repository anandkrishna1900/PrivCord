export const PROTOCOL_VERSION = 1 as const;

/** Maximum message length in Unicode code points (PRD FR-03). */
export const MAX_TEXT_LENGTH = 4000;

/** Maximum size of a retry/deduplication identifier. */
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 64;

/** Firestore rejects larger strings; this is a byte-level safety net for multi-byte text. */
export const MAX_TEXT_BYTES = 16000;

export const MAX_MANUAL_SIGNAL_BYTES = 64 * 1024;

export const MANUAL_SIGNAL_PREFIX = 'DUO1:';

export const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

export const AUTH_TIMEOUT_MS = 15_000;
export const P2P_RETRY_MS = 20_000;
