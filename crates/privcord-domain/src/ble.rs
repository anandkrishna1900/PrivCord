//! Bluetooth chunk framing (`bleFraming.ts` / `BleFraming.kt`, docs/BLE_TRANSPORT.md section 4).
//!
//! A chunk is `flags (1) | seq (2, big-endian, 0-based in the message) | payload`. Flags: bit 0 START, bit 1 END, no
//! other bit may be set. GATT delivers in order, so there are no acknowledgements or retransmits.

use thiserror::Error;

pub const BLE_HEADER_BYTES: usize = 3;
pub const BLE_MAX_MESSAGE_BYTES: usize = 65_536;
/// Smallest usable chunk: the header plus one payload byte.
pub const BLE_MIN_CHUNK_BYTES: usize = BLE_HEADER_BYTES + 1;
pub const FLAG_START: u8 = 0x01;
pub const FLAG_END: u8 = 0x02;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum BleFramingError {
    #[error("Empty message.")]
    Empty,
    #[error("Message too large.")]
    TooLarge,
    #[error("Chunk size too small.")]
    ChunkSizeTooSmall,
    #[error("Chunk too short.")]
    ChunkTooShort,
    #[error("Unknown flags.")]
    UnknownFlags,
    #[error("START chunk must have seq 0.")]
    StartSeq,
    #[error("Chunk without START.")]
    NoStart,
    #[error("Chunk out of order.")]
    OutOfOrder,
}

/// Split one message into chunks of at most `max_chunk_bytes` (header included).
pub fn chunk_message(
    payload: &[u8],
    max_chunk_bytes: usize,
) -> Result<Vec<Vec<u8>>, BleFramingError> {
    if payload.is_empty() {
        return Err(BleFramingError::Empty);
    }
    if payload.len() > BLE_MAX_MESSAGE_BYTES {
        return Err(BleFramingError::TooLarge);
    }
    if max_chunk_bytes < BLE_MIN_CHUNK_BYTES {
        return Err(BleFramingError::ChunkSizeTooSmall);
    }
    let body = max_chunk_bytes - BLE_HEADER_BYTES;
    let count = payload.len().div_ceil(body);
    let mut out = Vec::with_capacity(count);
    for (seq, part) in payload.chunks(body).enumerate() {
        let flags =
            (if seq == 0 { FLAG_START } else { 0 }) | (if seq + 1 == count { FLAG_END } else { 0 });
        // The sequence field is 16 bits; a 64 KiB message at the minimum chunk size is under 65,536 chunks.
        let seq16 = u16::try_from(seq).map_err(|_| BleFramingError::TooLarge)?;
        let mut chunk = Vec::with_capacity(BLE_HEADER_BYTES + part.len());
        chunk.push(flags);
        chunk.extend_from_slice(&seq16.to_be_bytes());
        chunk.extend_from_slice(part);
        out.push(chunk);
    }
    Ok(out)
}

/// A JSON frame as UTF-8 bytes, chunked.
pub fn encode_json_frame(
    value: &serde_json::Value,
    max_chunk_bytes: usize,
) -> Result<Vec<Vec<u8>>, BleFramingError> {
    chunk_message(value.to_string().as_bytes(), max_chunk_bytes)
}

/// Stateful reassembler for one link direction. A malformed stream is an error and resets it, so the next START starts
/// clean.
#[derive(Debug, Default)]
pub struct Reassembler {
    buf: Vec<u8>,
    next: u16,
    active: bool,
}

impl Reassembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// The full message when the END chunk arrives, otherwise `None`.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Option<Vec<u8>>, BleFramingError> {
        let r = self.push_inner(chunk);
        if r.is_err() {
            self.reset();
        }
        r
    }

    fn push_inner(&mut self, chunk: &[u8]) -> Result<Option<Vec<u8>>, BleFramingError> {
        let [flags, hi, lo, payload @ ..] = chunk else {
            return Err(BleFramingError::ChunkTooShort);
        };
        if payload.is_empty() {
            return Err(BleFramingError::ChunkTooShort);
        }
        if flags & !(FLAG_START | FLAG_END) != 0 {
            return Err(BleFramingError::UnknownFlags);
        }
        let seq = u16::from_be_bytes([*hi, *lo]);
        if flags & FLAG_START != 0 {
            // A new START always discards a half-received message (the sender restarted).
            self.reset();
            if seq != 0 {
                return Err(BleFramingError::StartSeq);
            }
            self.active = true;
        } else if !self.active {
            return Err(BleFramingError::NoStart);
        }
        if seq != self.next {
            return Err(BleFramingError::OutOfOrder);
        }
        if self.buf.len() + payload.len() > BLE_MAX_MESSAGE_BYTES {
            return Err(BleFramingError::TooLarge);
        }
        self.buf.extend_from_slice(payload);
        self.next = seq.wrapping_add(1);
        if flags & FLAG_END == 0 {
            return Ok(None);
        }
        let out = std::mem::take(&mut self.buf);
        self.reset();
        Ok(Some(out))
    }

    pub fn reset(&mut self) {
        self.buf.clear();
        self.next = 0;
        self.active = false;
    }
}

/// Advertisement tags rotate every 15 minutes.
pub const BLE_TAG_EPOCH_SECONDS: u64 = 900;
pub const BLE_TAG_BYTES: usize = 8;

pub fn ble_epoch(now_ms: u64) -> u64 {
    now_ms / 1000 / BLE_TAG_EPOCH_SECONDS
}
