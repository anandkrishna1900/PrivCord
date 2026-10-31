package com.duochat.app.security

import java.security.MessageDigest
import java.security.SecureRandom
import java.text.Normalizer
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/** BIP-39 with the English list (2048 words, bundled as a resource). 12 words only: 128-bit entropy. */
object Bip39 {
    const val WORDS = 12

    private val wordlist: List<String> by lazy {
        val stream = Bip39::class.java.getResourceAsStream("/bip39_english.txt")
            ?: error("BIP-39 wordlist resource is missing.")
        stream.bufferedReader().use { reader -> reader.readLines().map { it.trim() }.filter { it.isNotEmpty() } }
            .also { check(it.size == 2048) { "BIP-39 wordlist must have 2048 words." } }
    }

    private val index: Map<String, Int> by lazy { wordlist.withIndex().associate { it.value to it.index } }

    fun wordAt(i: Int): String = wordlist[i]

    fun isWord(word: String): Boolean = index.containsKey(word)

    fun generate(random: SecureRandom = SecureRandom()): String =
        fromEntropy(ByteArray(16).also { random.nextBytes(it) })

    fun fromEntropy(entropy: ByteArray): String {
        require(entropy.size == 16) { "Only 128-bit entropy (12 words) is supported." }
        val checksum = MessageDigest.getInstance("SHA-256").digest(entropy)[0].toInt() and 0xff
        // 128 entropy bits + 4 checksum bits, read 11 bits at a time.
        val bits = StringBuilder()
        for (b in entropy) bits.append((b.toInt() and 0xff).toString(2).padStart(8, '0'))
        bits.append((checksum shr 4).toString(2).padStart(4, '0'))
        return (0 until WORDS).joinToString(" ") { i ->
            wordlist[bits.substring(i * 11, i * 11 + 11).toInt(2)]
        }
    }

    /** Null when the phrase is fine, otherwise a message that is safe to show. */
    fun validate(phrase: String): String? {
        val words = normalize(phrase).split(' ').filter { it.isNotEmpty() }
        if (words.isEmpty()) return "Enter your recovery phrase."
        if (words.size != WORDS) return "A recovery phrase must be exactly $WORDS words."
        val bits = StringBuilder()
        for (w in words) {
            val i = index[w] ?: return "This phrase does not match the DuoChat word list or checksum."
            bits.append(i.toString(2).padStart(11, '0'))
        }
        val entropy = ByteArray(16) { bits.substring(it * 8, it * 8 + 8).toInt(2).toByte() }
        val expected = (MessageDigest.getInstance("SHA-256").digest(entropy)[0].toInt() and 0xff) shr 4
        return if (bits.substring(128).toInt(2) == expected) null
        else "This phrase does not match the DuoChat word list or checksum."
    }

    fun normalize(phrase: String): String = phrase.trim().lowercase().split(Regex("\\s+")).joinToString(" ")

    /** PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic" + passphrase (both NFKD), 64 bytes. */
    fun seed(phrase: String, passphrase: String = ""): ByteArray {
        validate(phrase)?.let { throw IllegalArgumentException("Invalid recovery phrase: $it") }
        val password = Normalizer.normalize(normalize(phrase), Normalizer.Form.NFKD).toCharArray()
        val salt = Normalizer.normalize("mnemonic$passphrase", Normalizer.Form.NFKD).toByteArray(Charsets.UTF_8)
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA512")
            .generateSecret(PBEKeySpec(password, salt, 2048, 512)).encoded
    }
}
