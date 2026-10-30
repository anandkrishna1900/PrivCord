package com.duochat.app.signaling

import com.duochat.app.security.Seal
import com.duochat.app.security.SealedBlob
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Talks to a self-hosted DuoChat relay (see /relay, protocol in docs/CONNECTIVITY.md 5a). */
class RelayClient(
    private val url: String,
    client: OkHttpClient,
    scope: CoroutineScope,
) : SignalingTransport {
    override val name = "relay $url"

    private var mailbox: String? = null
    private var onBlob: ((SealedBlob, String) -> Unit)? = null
    @Volatile private var lastSeen = 0L
    private val pending = ConcurrentHashMap<String, CompletableDeferred<Unit>>()
    private val socket = ManagedSocket(client, url, scope, ::opened, ::handle)

    override fun start(mailbox: String, onBlob: (SealedBlob, String) -> Unit) {
        this.mailbox = mailbox
        this.onBlob = onBlob
        socket.start()
    }

    private fun opened(s: ManagedSocket) {
        s.send(JSONObject().put("op", "sub").put("mailbox", mailbox).put("since", lastSeen).toString())
    }

    private fun handle(text: String) {
        val frame = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        when (frame.optString("op")) {
            "event" -> {
                val id = frame.optString("id")
                val blob = Seal.decode(frame.optString("blob")) ?: return
                lastSeen = maxOf(lastSeen, frame.optLong("ts", 0L))
                if (id.isNotEmpty()) onBlob?.invoke(blob, id)
            }
            "ok" -> pending.remove(frame.optString("id"))?.complete(Unit)
            "err" -> pending.remove(frame.optString("id"))?.completeExceptionally(
                IllegalStateException(frame.optString("reason", "Relay refused the message.")),
            )
        }
    }

    override suspend fun put(mailbox: String, blob: SealedBlob, kind: String, ttlSec: Int) {
        if (!socket.isOpen) throw IllegalStateException("Relay is not connected.")
        val id = UUID.randomUUID().toString()
        val done = CompletableDeferred<Unit>()
        pending[id] = done
        val sent = socket.send(
            JSONObject().put("op", "put").put("mailbox", mailbox).put("id", id)
                .put("blob", Seal.encode(blob)).put("ttl", ttlSec).put("kind", kind).toString(),
        )
        if (!sent) {
            pending.remove(id)
            throw IllegalStateException("Relay is not connected.")
        }
        try {
            withTimeout(PUT_TIMEOUT_MS) { done.await() }
        } finally {
            pending.remove(id)
        }
    }

    override fun remove(mailbox: String, id: String) {
        socket.send(JSONObject().put("op", "del").put("mailbox", mailbox).put("id", id).toString())
    }

    override fun status() = when {
        socket.isOpen -> SignalingStatus.ONLINE
        socket.isConnecting -> SignalingStatus.CONNECTING
        else -> SignalingStatus.ERROR
    }

    override fun stop() {
        socket.stop()
        pending.values.forEach { it.completeExceptionally(IllegalStateException("Stopped.")) }
        pending.clear()
    }

    private companion object {
        const val PUT_TIMEOUT_MS = 8_000L
    }
}
