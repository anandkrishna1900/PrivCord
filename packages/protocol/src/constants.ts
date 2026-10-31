export const PROTOCOL_VERSION = 1 as const;

/** Maximum message length in Unicode code points (PRD FR-03). */
export const MAX_TEXT_LENGTH = 4000;

/** Maximum size of a retry/deduplication identifier. */
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 64;

/** Byte-level safety net for multi-byte text. */
export const MAX_TEXT_BYTES = 16000;

export const MAX_MANUAL_SIGNAL_BYTES = 64 * 1024;

export const MANUAL_SIGNAL_PREFIX = 'DUO1:';

export const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

export const AUTH_TIMEOUT_MS = 15_000;
export const P2P_RETRY_MS = 20_000;

/** Hard limit on group size (including the creator). Enforced by the roster fold, so every replica agrees. */
export const MAX_GROUP_MEMBERS = 10;

/** Largest file that can be sent (8 MiB). */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Raw bytes per file chunk. Base64 makes it 16 KiB on the wire, the safe size for a data channel message. */
export const FILE_CHUNK_BYTES = 12 * 1024;

/** Longest quoted snippet carried with a reply, in code points. */
export const MAX_REPLY_PREVIEW = 120;
