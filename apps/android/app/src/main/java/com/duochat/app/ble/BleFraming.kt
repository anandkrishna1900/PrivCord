package com.duochat.app.ble

/**
 * BLE chunking/reassembly for JSON frames (docs/BLE_TRANSPORT.md section 4).
 * Byte-for-byte identical to apps/desktop/src/lib/bleFraming.ts; both are tested
 * against docs/ble-vectors.json.
 *
 * Chunk = flags (1 byte) | seq (2 bytes, big-endian, 0-based within the message) | payload.
 * flags: bit0 START, bit1 END, other bits must be zero. GATT delivers writes and
 * notifications in order, so there are no acks or retransmits.
 */
class BleFramingException(message: String) : Exception(message)

object BleFraming {
    const val HEADER_BYTES = 3
    const val MAX_MESSAGE_BYTES = 65_536
    const val MIN_CHUNK_BYTES = HEADER_BYTES + 1
    const val FLAG_START = 0x01
    const val FLAG_END = 0x02

    /** Split one message into chunks of at most [maxChunkBytes] (header included). */
    fun chunk(payload: ByteArray, maxChunkBytes: Int): List<ByteArray> {
        if (payload.isEmpty()) throw BleFramingException("Empty message.")
        if (payload.size > MAX_MESSAGE_BYTES) throw BleFramingException("Message too large.")
        if (maxChunkBytes < MIN_CHUNK_BYTES) throw BleFramingException("Chunk size too small.")
        val body = maxChunkBytes - HEADER_BYTES
        val chunks = ArrayList<ByteArray>((payload.size + body - 1) / body)
        var offset = 0
        var seq = 0
        while (offset < payload.size) {
            val end = minOf(offset + body, payload.size)
            val chunk = ByteArray(HEADER_BYTES + end - offset)
            chunk[0] = ((if (seq == 0) FLAG_START else 0) or (if (end == payload.size) FLAG_END else 0)).toByte()
            chunk[1] = (seq shr 8).toByte()
            chunk[2] = seq.toByte()
            System.arraycopy(payload, offset, chunk, HEADER_BYTES, end - offset)
            chunks.add(chunk)
            offset = end
            seq += 1
        }
        return chunks
    }

    fun chunkJson(json: String, maxChunkBytes: Int): List<ByteArray> =
        chunk(json.toByteArray(Charsets.UTF_8), maxChunkBytes)
}

/** Stateful reassembler for one link direction. Not thread-safe: call from one thread. */
class BleReassembler {
    private var buffer = java.io.ByteArrayOutputStream()
    private var next = 0
    private var active = false

    /**
     * Returns the full message when the END chunk arrives, otherwise null.
     * Throws (after resetting) on a malformed stream.
     */
    fun push(chunk: ByteArray): ByteArray? {
        if (chunk.size < BleFraming.MIN_CHUNK_BYTES) fail("Chunk too short.")
        val flags = chunk[0].toInt() and 0xff
        if (flags and (BleFraming.FLAG_START or BleFraming.FLAG_END).inv() != 0) fail("Unknown flags.")
        val seq = ((chunk[1].toInt() and 0xff) shl 8) or (chunk[2].toInt() and 0xff)
        if (flags and BleFraming.FLAG_START != 0) {
            // A new START always discards a half-received message (the sender restarted).
            reset()
            if (seq != 0) fail("START chunk must have seq 0.")
            active = true
        } else if (!active) {
            fail("Chunk without START.")
        }
        if (seq != next) fail("Chunk out of order.")
        if (buffer.size() + chunk.size - BleFraming.HEADER_BYTES > BleFraming.MAX_MESSAGE_BYTES) {
            fail("Message too large.")
        }
        buffer.write(chunk, BleFraming.HEADER_BYTES, chunk.size - BleFraming.HEADER_BYTES)
        next = seq + 1
        if (flags and BleFraming.FLAG_END == 0) return null
        val out = buffer.toByteArray()
        reset()
        return out
    }

    fun reset() {
        buffer = java.io.ByteArrayOutputStream()
        next = 0
        active = false
    }

    private fun fail(message: String): Nothing {
        reset()
        throw BleFramingException(message)
    }
}

/** Rotating advertisement tag (docs/BLE_TRANSPORT.md section 3). */
object BleTag {
    const val EPOCH_SECONDS = 900L
    const val TAG_BYTES = 8

    fun epoch(nowMs: Long): Long = nowMs / 1000 / EPOCH_SECONDS

    /** HMAC-SHA-256(secret, "duochat-ble-tag-v1|" + epoch) truncated to 8 bytes. [secret] is the 32-byte contact ECDH secret. */
    fun tag(secret: ByteArray, epoch: Long): ByteArray {
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(javax.crypto.spec.SecretKeySpec(secret, "HmacSHA256"))
        return mac.doFinal("duochat-ble-tag-v1|$epoch".toByteArray(Charsets.UTF_8)).copyOf(TAG_BYTES)
    }

    /** Tags a scanner should accept now: previous, current and next epoch (clock skew up to one epoch). */
    fun acceptTags(secret: ByteArray, nowMs: Long): List<ByteArray> {
        val e = epoch(nowMs)
        return listOf(e - 1, e, e + 1).map { tag(secret, it) }
    }
}
