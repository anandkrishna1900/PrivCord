package com.duochat.app.security

import java.security.MessageDigest

/**
 * Public WordCode encoder / decoder.
 * Converts an 8-byte (16 hex character) public User ID into exactly 6 human-readable
 * BIP-39 dictionary words with an embedded 2-bit checksum (and vice-versa).
 *
 * This allows users to easily copy, read, or speak a short 6-word public address code
 * (e.g. "rifle crop mango boy aerobic belt") instead of long cryptographic strings,
 * without exposing or compromising their private 12-word master recovery phrase!
 */
object WordCode {
    private val wordlist: List<String> by lazy {
        val stream = WordCode::class.java.getResourceAsStream("/bip39_english.txt")
            ?: error("BIP-39 wordlist resource is missing.")
        stream.bufferedReader().use { reader -> reader.readLines().map { it.trim() }.filter { it.isNotEmpty() } }
            .also { check(it.size == 2048) { "BIP-39 wordlist must have 2048 words." } }
    }

    private val index: Map<String, Int> by lazy { wordlist.withIndex().associate { it.value to it.index } }

    /** Encodes a public UID (taking the first 16 hex characters) into 6 readable words. */
    fun encode(uid: String): String {
        val cleanUid = uid.replace(Regex("[^0-9a-fA-F]"), "").lowercase().take(16).padStart(16, '0')
        val bytes = ByteArray(8) { i ->
            cleanUid.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
        val checksum = (MessageDigest.getInstance("SHA-256").digest(bytes)[0].toInt() and 0xff) shr 6
        val bits = StringBuilder()
        for (b in bytes) {
            bits.append((b.toInt() and 0xff).toString(2).padStart(8, '0'))
        }
        bits.append(checksum.toString(2).padStart(2, '0'))
        return (0 until 6).joinToString(" ") { i ->
            wordlist[bits.substring(i * 11, i * 11 + 11).toInt(2)]
        }
    }

    /** Decodes a 6-word phrase back into the 16-hex-character public UID. Returns null if invalid or checksum fails. */
    fun decode(phrase: String): String? {
        val parts = phrase.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (parts.size != 6) return null
        val bits = StringBuilder()
        for (p in parts) {
            val idx = index[p] ?: return null
            bits.append(idx.toString(2).padStart(11, '0'))
        }
        val entropyBits = bits.substring(0, 64)
        val checkBits = bits.substring(64).toInt(2)
        val bytes = ByteArray(8) { i ->
            entropyBits.substring(i * 8, i * 8 + 8).toInt(2).toByte()
        }
        val expectedCheck = (MessageDigest.getInstance("SHA-256").digest(bytes)[0].toInt() and 0xff) shr 6
        if (checkBits != expectedCheck) return null
        return bytes.joinToString("") { "%02x".format(it) }
    }
}

