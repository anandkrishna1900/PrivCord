package com.duochat.app.security

import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.Normalizer
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Open channels: public, named chat rooms. Port of packages/protocol/src/mesh/channel.ts (see the comment
 * there). Anyone who types the same name is in the same room; every message is signed with the sender's identity
 * but is NOT private: anyone who knows the channel name can read it.
 */
object Channels {
    const val MAX_NAME = 32
    const val MAX_TEXT = 500
    const val TTL_SEC = 24 * 3600
    private const val SALT = "duochat-channel-v1"
    private const val MAILBOX_PREFIX = "duochat-channel-mailbox-v1|"
    private val random = SecureRandom()

    /** "  #General Chat " becomes "general-chat". Letters, digits (any language) and dashes only; null if nothing is left. */
    fun normalize(raw: String): String? {
        val name = Normalizer.normalize(raw, Normalizer.Form.NFKC).lowercase()
            .replace(Regex("^#+"), "")
            .replace(Regex("[^\\p{L}\\p{N}]+"), "-")
            .replace(Regex("^-+|-+$"), "")
            .take(MAX_NAME)
            .replace(Regex("-+$"), "")
        return name.ifEmpty { null }
    }

    class Keys(val name: String, val mailbox: String, val tag: String, val key: ByteArray)

    fun derive(name: String): Keys {
        val digest = MessageDigest.getInstance("SHA-256").digest((MAILBOX_PREFIX + name).toByteArray(Charsets.UTF_8))
        val mailbox = digest.joinToString("") { "%02x".format(it) }
        return Keys(
            name, mailbox, "ch:${mailbox.take(16)}",
            RecoveryIdentity.hkdf(digest, SALT.toByteArray(Charsets.UTF_8), "key".toByteArray(Charsets.UTF_8), 32),
        )
    }

    class Message(val channel: String, val text: String, val at: Long, val contact: Contact)

    private fun gcm(mode: Int, key: ByteArray, iv: ByteArray, aad: ByteArray): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            updateAAD(aad)
        }

    fun seal(keys: Keys, text: String, at: Long, card: ContactCard, uid: String, sign: (ByteArray) -> String): SealedBlob {
        val clean = text.trim().let { t -> t.substring(0, t.offsetByCodePoints(0, minOf(MAX_TEXT, t.codePointCount(0, t.length)))) }
        require(clean.isNotEmpty()) { "Message cannot be empty." }
        val iv = ByteArray(12).also { random.nextBytes(it) }
        val body = JSONObject().put("c", keys.name).put("t", clean).put("at", at).put("card", ContactCards.encode(card)).toString()
        val ct = gcm(Cipher.ENCRYPT_MODE, keys.key, iv, "${keys.tag}|$uid".toByteArray(Charsets.UTF_8)).doFinal(body.toByteArray(Charsets.UTF_8))
        val eph = EcKeys.generateEphemeral()
        val epk = JSONObject().put("kty", "EC").put("crv", "P-256").put("x", eph.public.x).put("y", eph.public.y)
        val ivB64 = SignatureCodec.base64UrlEncode(iv)
        val ctB64 = SignatureCodec.base64UrlEncode(ct)
        return SealedBlob(keys.tag, uid, epk, ivB64, ctB64, Seal.signBlob(keys.tag, uid, epk, ivB64, ctB64, sign))
    }

    /** Decrypts with the channel name, checks the sender's card is genuine and really signed this. Null otherwise. */
    fun open(keys: Keys, blob: SealedBlob): Message? = try {
        if (blob.to != keys.tag || Seal.jwkOrNull(blob.epk) == null) null
        else {
            val plain = gcm(
                Cipher.DECRYPT_MODE, keys.key, SignatureCodec.base64UrlDecode(blob.iv), "${keys.tag}|${blob.from}".toByteArray(Charsets.UTF_8),
            ).doFinal(SignatureCodec.base64UrlDecode(blob.ct))
            val body = JSONObject(String(plain, Charsets.UTF_8))
            val text = body.opt("t") as? String
            val at = (body.opt("at") as? Number)?.toLong()
            val contact = ContactCards.decode(body.optString("card"))
            when {
                body.opt("c") != keys.name || text == null || at == null || at <= 0 -> null
                text.isBlank() || text.codePointCount(0, text.length) > MAX_TEXT -> null
                contact == null || contact.uid != blob.from || !Seal.verifyBlob(blob, contact.card.sign) -> null
                else -> Message(keys.name, text, at, contact)
            }
        }
    } catch (_: Exception) {
        null
    }
}
