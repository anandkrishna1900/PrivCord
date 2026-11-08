//! Fixed limits shared by every platform (`packages/protocol/src/constants.ts`). Changing one changes the wire rules.

pub const PROTOCOL_VERSION: u64 = 1;
/// Maximum message length in Unicode code points.
pub const MAX_TEXT_LENGTH: usize = 4000;
/// Maximum size of a retry/deduplication identifier (UTF-16 code units, as the TypeScript implementation counts).
pub const MAX_CLIENT_MESSAGE_ID_LENGTH: usize = 64;
pub const MAX_TEXT_BYTES: usize = 16_000;
/// Hard limit on group size, including the creator.
pub const MAX_GROUP_MEMBERS: usize = 10;
/// Largest file that can be sent (8 MiB).
pub const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
/// Raw bytes per file chunk.
pub const FILE_CHUNK_BYTES: usize = 12 * 1024;
/// Longest quoted snippet carried with a reply, in code points.
pub const MAX_REPLY_PREVIEW: usize = 120;
pub const MAX_FILE_NAME: usize = 120;
pub const MAX_INCOMING_PER_PEER: usize = 2;
pub const MAX_FILE_CHUNKS: usize = MAX_FILE_BYTES.div_ceil(FILE_CHUNK_BYTES);
pub const MAX_CHANNEL_NAME: usize = 32;
pub const MAX_CHANNEL_TEXT: usize = 500;
pub const MESH_MAX_TTL: u32 = 7;
pub const MESH_CARRY_MS: u64 = 30 * 60 * 1000;
