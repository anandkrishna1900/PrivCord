package com.duochat.app.signaling

import com.duochat.app.security.CanonicalJson
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

const val NOSTR_KIND_SIGNAL = 21733 // ephemeral range: relays do not store it
const val NOSTR_KIND_MESSAGE = 31733 // parameterized replaceable range: relays store it

data class NostrEvent(
    val id: String,
    val pubkey: String,
    val createdAt: Long,
    val kind: Int,
    val tags: List<List<String>>,
    val content: String,
    val sig: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("pubkey", pubkey).put("created_at", createdAt).put("kind", kind)
        .put("tags", JSONArray(tags.map { JSONArray(it) })).put("content", content).put("sig", sig)

    fun tag(name: String): String? = tags.firstOrNull { it.size >= 2 && it[0] == name }?.get(1)

    companion object {
        fun fromJson(json: JSONObject): NostrEvent? = try {
            val tagsJson = json.getJSONArray("tags")
            NostrEvent(
                json.getString("id"), json.getString("pubkey"), json.getLong("created_at"), json.getInt("kind"),
                (0 until tagsJson.length()).map { i ->
                    val t = tagsJson.getJSONArray(i)
                    (0 until t.length()).map { t.getString(it) }
                },
                json.getString("content"), json.getString("sig"),
            )
        } catch (_: Exception) {
            null
        }
    }
}

object NostrCodec {
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    private fun unhex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    /** Hash of [0, pubkey, created_at, kind, tags, content] exactly as NIP-01 serializes it (matches JS JSON.stringify). */
    fun eventId(pubkey: String, createdAt: Long, kind: Int, tags: List<List<String>>, content: String): String =
        hex(MessageDigest.getInstance("SHA-256").digest(CanonicalJson.of(listOf(0, pubkey, createdAt, kind, tags, content)).toByteArray(Charsets.UTF_8)))

    /**
     * One event per blob, signed with a fresh throwaway key so events cannot be linked to the DuoChat identity.
     * `d` makes each stored message its own addressable event; `expiration` bounds retention.
     */
    fun makeEvent(
        mailbox: String,
        blobWire: String,
        kind: String,
        ttlSec: Int,
        now: Long = System.currentTimeMillis() / 1000,
        secretKey: ByteArray = Schnorr.newSecretKey(),
        aux: ByteArray? = null,
        dTag: String = java.util.UUID.randomUUID().toString(),
    ): NostrEvent {
        val pubkey = hex(Schnorr.publicKey(secretKey))
        val nostrKind = if (kind == "sig") NOSTR_KIND_SIGNAL else NOSTR_KIND_MESSAGE
        val tags = listOf(listOf("t", mailbox), listOf("d", dTag), listOf("expiration", (now + ttlSec).toString()))
        val id = eventId(pubkey, now, nostrKind, tags, blobWire)
        val sig = if (aux == null) Schnorr.sign(unhex(id), secretKey) else Schnorr.sign(unhex(id), secretKey, aux)
        return NostrEvent(id, pubkey, now, nostrKind, tags, blobWire, hex(sig))
    }

    fun verify(event: NostrEvent): Boolean = try {
        eventId(event.pubkey, event.createdAt, event.kind, event.tags, event.content) == event.id &&
            Schnorr.verify(unhex(event.sig), unhex(event.id), unhex(event.pubkey))
    } catch (_: Exception) {
        false
    }
}
