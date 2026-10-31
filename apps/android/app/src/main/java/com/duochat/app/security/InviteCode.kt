package com.duochat.app.security

import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Six-word invite codes. Port of packages/protocol/src/connectivity/inviteCode.ts (see the comment there).
 *
 * The code is a meeting point: 66 random bits (six words of the BIP-39 list) from which both people derive
 * the same relay mailbox and AES key. The owner publishes their card there, encrypted; whoever knows the code
 * fetches it and answers with their own card. The owner then confirms who answered.
 */
object InviteCode {
    const val WORDS = 6
    const val TTL_SEC = 15 * 60
    private const val PBKDF2_ITERATIONS = 150_000
    private const val SALT = "duochat-invite-v1"
    private const val MAILBOX_PREFIX = "duochat-invite-mailbox-v1|"
    private val random = SecureRandom()

    class Rendezvous(val mailbox: String, val key: ByteArray)

    enum class Kind(val wire: String) { CARD("card"), REPLY("reply") }

    class Message(val kind: Kind, val contact: Contact)

    fun newWords(): List<String> {
        val bytes = ByteArray(WORDS * 2).also { random.nextBytes(it) }
        return List(WORDS) { i -> Bip39.wordAt((((bytes[i * 2].toInt() and 0xff) shl 8) or (bytes[i * 2 + 1].toInt() and 0xff)) and 0x7ff) }
    }

    /** The six words from what a person typed (any spacing, case or separators), or null if it is not a valid code. */
    fun parse(text: String): List<String>? {
        val parts = text.lowercase().split(Regex("[^a-z]+")).filter { it.isNotEmpty() }
        return if (parts.size == WORDS && parts.all { Bip39.isWord(it) }) parts else null
    }

    fun derive(words: List<String>): Rendezvous {
        val spec = PBEKeySpec(words.joinToString(" ").toCharArray(), SALT.toByteArray(Charsets.UTF_8), PBKDF2_ITERATIONS, 256)
        val seed = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        val mailbox = MessageDigest.getInstance("SHA-256").digest((MAILBOX_PREFIX + seed.joinToString("") { "%02x".format(it) }).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return Rendezvous(mailbox, RecoveryIdentity.hkdf(seed, SALT.toByteArray(Charsets.UTF_8), "key".toByteArray(Charsets.UTF_8), 32))
    }

    private fun gcm(mode: Int, key: ByteArray, iv: ByteArray, aad: ByteArray): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            updateAAD(aad)
        }

    fun seal(rv: Rendezvous, kind: Kind, card: ContactCard, uid: String, sign: (ByteArray) -> String): SealedBlob {
        val iv = ByteArray(12).also { random.nextBytes(it) }
        val body = JSONObject().put("t", kind.wire).put("card", ContactCards.encode(card)).toString().toByteArray(Charsets.UTF_8)
        val ct = gcm(Cipher.ENCRYPT_MODE, rv.key, iv, "invite|$uid".toByteArray(Charsets.UTF_8)).doFinal(body)
        val eph = EcKeys.generateEphemeral()
        val epk = JSONObject().put("kty", "EC").put("crv", "P-256").put("x", eph.public.x).put("y", eph.public.y)
        val ivB64 = SignatureCodec.base64UrlEncode(iv)
        val ctB64 = SignatureCodec.base64UrlEncode(ct)
        return SealedBlob("invite", uid, epk, ivB64, ctB64, Seal.signBlob("invite", uid, epk, ivB64, ctB64, sign))
    }

    /** Decrypts with the code, checks the card is genuine, belongs to the sender and signed the blob. Null otherwise. */
    fun open(rv: Rendezvous, blob: SealedBlob): Message? = try {
        if (blob.to != "invite" || Seal.jwkOrNull(blob.epk) == null) null
        else {
            val plain = gcm(
                Cipher.DECRYPT_MODE, rv.key, SignatureCodec.base64UrlDecode(blob.iv), "invite|${blob.from}".toByteArray(Charsets.UTF_8),
            ).doFinal(SignatureCodec.base64UrlDecode(blob.ct))
            val body = JSONObject(String(plain, Charsets.UTF_8))
            val kind = Kind.entries.firstOrNull { it.wire == body.optString("t") }
            val contact = ContactCards.decode(body.optString("card"))
            if (kind == null || contact == null || contact.uid != blob.from || !Seal.verifyBlob(blob, contact.card.sign)) null
            else Message(kind, contact)
        }
    } catch (_: Exception) {
        null
    }
}
