package com.duochat.app.signaling

import com.duochat.app.security.Seal
import com.duochat.app.security.SealedBlob
import kotlinx.coroutines.CoroutineScope
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject

/** Signaling and mailboxes over public Nostr relays: decentralized, nothing to host. */
class NostrTransport(
    relays: List<String>,
    client: OkHttpClient,
    scope: CoroutineScope,
) : SignalingTransport {
    override val name = "nostr"

    private var mailbox: String? = null
    private var onBlob: ((SealedBlob, String) -> Unit)? = null
    private val seen = LinkedHashSet<String>()
    private val subId = "duo-" + java.util.UUID.randomUUID().toString().take(8)
    private val sockets = relays.map { url -> ManagedSocket(client, url, scope, ::opened) { handle(it) } }

    override fun start(mailbox: String, onBlob: (SealedBlob, String) -> Unit) {
        this.mailbox = mailbox
        this.onBlob = onBlob
        sockets.forEach { it.start() }
    }

    private fun opened(s: ManagedSocket) {
        val since = System.currentTimeMillis() / 1000 - 120
        val filter = JSONObject()
            .put("kinds", JSONArray(listOf(NOSTR_KIND_SIGNAL, NOSTR_KIND_MESSAGE)))
            .put("#t", JSONArray(listOf(mailbox)))
            .put("since", since)
        s.send(JSONArray(listOf("REQ", subId, filter)).toString())
    }

    private fun handle(text: String) {
        try {
            val frame = JSONArray(text)
            if (frame.optString(0) != "EVENT" || frame.optString(1) != subId) return
            val event = NostrEvent.fromJson(frame.getJSONObject(2)) ?: return
            if (!NostrCodec.verify(event)) return
            if (event.tag("t") != mailbox) return
            val expiry = event.tag("expiration")?.toLongOrNull()
            if (expiry != null && expiry < System.currentTimeMillis() / 1000) return
            val fresh = synchronized(seen) {
                val added = seen.add(event.id)
                if (seen.size > 2000) seen.remove(seen.first())
                added
            }
            if (!fresh) return
            val blob = Seal.decode(event.content) ?: return
            onBlob?.invoke(blob, event.id)
        } catch (_: Exception) {
            // Ignore anything that is not a well-formed relay frame.
        }
    }

    override suspend fun put(mailbox: String, blob: SealedBlob, kind: String, ttlSec: Int) {
        val event = NostrCodec.makeEvent(mailbox, Seal.encode(blob), kind, ttlSec)
        val payload = JSONArray(listOf("EVENT", event.toJson())).toString()
        val sent = sockets.count { it.send(payload) }
        if (sent == 0) throw IllegalStateException("No Nostr relay is connected.")
    }

    // Nostr relays cannot delete on our behalf; the expiration tag bounds retention.
    override fun remove(mailbox: String, id: String) = Unit

    override fun status() = when {
        sockets.any { it.isOpen } -> SignalingStatus.ONLINE
        sockets.any { it.isConnecting } -> SignalingStatus.CONNECTING
        else -> SignalingStatus.ERROR
    }

    override fun stop() = sockets.forEach { it.stop() }
}
