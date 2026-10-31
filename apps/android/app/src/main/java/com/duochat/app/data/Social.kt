package com.duochat.app.data

import com.duochat.app.security.SignatureCodec
import org.json.JSONObject
import java.security.SecureRandom
import java.text.Normalizer
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/*
 * Delete for everyone, reactions and encrypted backups. Port of
 * packages/protocol/src/social.ts and backup.ts; the frames and the backup file are byte-compatible.
 * None of this can be enforced against a modified app: a receiver who wants to keep a message can.
 */

val REACTION_EMOJI = listOf("👍", "❤️", "😂", "😮", "😢", "🙏")

fun deleteFrame(messageId: String): JSONObject = JSONObject().put("v", 1).put("kind", "delete").put("messageId", messageId)

fun reactFrame(messageId: String, emoji: String, on: Boolean): JSONObject =
    JSONObject().put("v", 1).put("kind", "react").put("messageId", messageId).put("emoji", emoji).put("on", on)

fun parseDelete(frame: JSONObject): String? {
    if (frame.optString("kind") != "delete" || frame.optInt("v", -1) != 1) return null
    return frame.optString("messageId").takeIf { isValidClientMessageId(it) }
}

class ReactionEvent(val messageId: String, val emoji: String, val on: Boolean)

fun parseReact(frame: JSONObject): ReactionEvent? {
    if (frame.optString("kind") != "react" || frame.optInt("v", -1) != 1) return null
    val id = frame.optString("messageId").takeIf { isValidClientMessageId(it) } ?: return null
    val emoji = frame.opt("emoji") as? String ?: return null
    val on = frame.opt("on") as? Boolean ?: return null
    return if (emoji in REACTION_EMOJI) ReactionEvent(id, emoji, on) else null
}

class ReactionChip(val emoji: String, val count: Int, val mine: Boolean)

/** Everyone's reactions on one message, ready to show: emoji with a count and whether I reacted. */
fun summarizeReactions(reactions: Map<String, String>, me: String): List<ReactionChip> {
    val counts = LinkedHashMap<String, Pair<Int, Boolean>>()
    for ((uid, emoji) in reactions) {
        val (n, mine) = counts[emoji] ?: (0 to false)
        counts[emoji] = (n + 1) to (mine || uid == me)
    }
    return REACTION_EMOJI.filter { it in counts }.map { ReactionChip(it, counts[it]!!.first, counts[it]!!.second) }
}

/** Audio that plays inline (voice notes). */
private val INLINE_AUDIO = setOf("audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/aac", "audio/wav", "audio/x-m4a")

fun isInlineAudio(mime: String): Boolean = mime.lowercase().substringBefore(';').trim() in INLINE_AUDIO

/** Encrypted chat backup: a passphrase-protected file. A wrong passphrase and a damaged file look the same. */
object Backup {
    const val PREFIX = "PRIVCORD-BACKUP1:"
    const val MIN_PASSPHRASE = 8
    private const val ITERATIONS = 300_000
    private val AAD = "privcord-backup-v1".toByteArray(Charsets.UTF_8)
    private val random = SecureRandom()

    private fun key(passphrase: String, salt: ByteArray, iterations: Int): ByteArray {
        val spec = PBEKeySpec(Normalizer.normalize(passphrase, Normalizer.Form.NFKC).toCharArray(), salt, iterations, 256)
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    }

    private fun gcm(mode: Int, key: ByteArray, iv: ByteArray): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            updateAAD(AAD)
        }

    fun seal(data: JSONObject, passphrase: String): String {
        require(passphrase.length >= MIN_PASSPHRASE) { "Use at least $MIN_PASSPHRASE characters." }
        val salt = ByteArray(16).also { random.nextBytes(it) }
        val iv = ByteArray(12).also { random.nextBytes(it) }
        val ct = gcm(Cipher.ENCRYPT_MODE, key(passphrase, salt, ITERATIONS), iv).doFinal(data.toString().toByteArray(Charsets.UTF_8))
        val body = JSONObject().put("v", 1).put("it", ITERATIONS)
            .put("salt", SignatureCodec.base64UrlEncode(salt)).put("iv", SignatureCodec.base64UrlEncode(iv)).put("ct", SignatureCodec.base64UrlEncode(ct))
        return PREFIX + SignatureCodec.base64UrlEncode(body.toString().toByteArray(Charsets.UTF_8))
    }

    /** The data, or null for a wrong passphrase, a damaged file or something that is not a backup. */
    fun open(text: String, passphrase: String): JSONObject? = try {
        val trimmed = text.trim()
        if (!trimmed.startsWith(PREFIX)) null
        else {
            val body = JSONObject(String(SignatureCodec.base64UrlDecode(trimmed.removePrefix(PREFIX)), Charsets.UTF_8))
            val it = body.optInt("it")
            if (body.optInt("v") != 1 || it < 100_000 || it > 2_000_000) null
            else {
                val plain = gcm(
                    Cipher.DECRYPT_MODE, key(passphrase, SignatureCodec.base64UrlDecode(body.getString("salt")), it),
                    SignatureCodec.base64UrlDecode(body.getString("iv")),
                ).doFinal(SignatureCodec.base64UrlDecode(body.getString("ct")))
                JSONObject(String(plain, Charsets.UTF_8))
            }
        }
    } catch (_: Exception) {
        null
    }
}
