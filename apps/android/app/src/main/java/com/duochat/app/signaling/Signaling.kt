package com.duochat.app.signaling

import com.duochat.app.data.NetworkConfig
import com.duochat.app.data.SignalingConfig
import com.duochat.app.security.SealedBlob
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

enum class SignalingStatus { IDLE, CONNECTING, ONLINE, ERROR }

/**
 * A replaceable way to move sealed blobs between two contacts (docs/CONNECTIVITY.md section 5).
 * It never sees plaintext: blobs are encrypted to the recipient and signed by the sender.
 */
interface SignalingTransport {
    val name: String
    fun start(mailbox: String, onBlob: (blob: SealedBlob, id: String) -> Unit)

    /** [kind] is "sig" (live, short-lived) or "msg" (held for an offline contact). */
    suspend fun put(mailbox: String, blob: SealedBlob, kind: String, ttlSec: Int)

    /** Tell the relay a stored item was handled. No-op where the backend cannot delete. */
    fun remove(mailbox: String, id: String)
    fun status(): SignalingStatus
    fun stop()
}

/** Delay before the next automatic reconnect attempt to a paired friend: 5 s doubling to 120 s (same as the desktop). */
fun reconnectDelayMs(attempt: Int): Long = minOf(120_000L, 5_000L shl minOf(maxOf(attempt, 0), 8))

/** Reconnect delay for a dropped socket (ms): 1 s doubling to 30 s. */
fun socketBackoff(attempt: Int): Long = minOf(30_000L, 1_000L shl minOf(attempt, 5))

/** One WebSocket that reconnects by itself with backoff. */
class ManagedSocket(
    private val client: OkHttpClient,
    private val url: String,
    private val scope: CoroutineScope,
    private val onOpen: (ManagedSocket) -> Unit,
    private val onText: (String) -> Unit,
) {
    @Volatile private var socket: WebSocket? = null
    @Volatile var isOpen = false
        private set
    @Volatile var isConnecting = false
        private set
    @Volatile private var stopped = true
    @Volatile private var attempt = 0

    fun start() {
        stopped = false
        connect()
    }

    private fun connect() {
        if (stopped) return
        isConnecting = true
        val request = try {
            Request.Builder().url(url).build()
        } catch (_: Exception) {
            isConnecting = false
            retry()
            return
        }
        socket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    attempt = 0
                    isOpen = true
                    isConnecting = false
                    onOpen(this@ManagedSocket)
                }

                override fun onMessage(webSocket: WebSocket, text: String) = onText(text)

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket)

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dropped(webSocket)
            },
        )
    }

    private fun dropped(webSocket: WebSocket) {
        if (socket !== webSocket) return
        socket = null
        isOpen = false
        isConnecting = false
        retry()
    }

    private fun retry() {
        if (stopped) return
        val wait = socketBackoff(attempt++)
        scope.launch {
            delay(wait)
            connect()
        }
    }

    fun send(text: String): Boolean = isOpen && socket?.send(text) == true

    fun stop() {
        stopped = true
        isOpen = false
        isConnecting = false
        socket?.close(1000, null)
        socket = null
    }
}

/** Orbot's SOCKS proxy on this phone (its default port). */
const val TOR_SOCKS_PORT = 9050

/**
 * The relays' sockets. Through Tor, every connection goes to Orbot's SOCKS proxy, and OkHttp hands it the host name
 * unresolved, so the name lookup happens inside Tor too. If Orbot is not running the connection fails: nothing is ever
 * sent around Tor.
 */
fun newSignalingClient(tor: Boolean = false): OkHttpClient = OkHttpClient.Builder()
    .pingInterval(30, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .apply {
        if (tor) {
            proxy(java.net.Proxy(java.net.Proxy.Type.SOCKS, java.net.InetSocketAddress("127.0.0.1", TOR_SOCKS_PORT)))
            // Circuits are slow to build; a relay that answers late is not a dead relay.
            connectTimeout(60, TimeUnit.SECONDS)
        }
    }
    .build()

/** Whether Orbot's SOCKS proxy answers on this phone right now (blocking; call off the main thread). */
fun torIsRunning(): Boolean = runCatching {
    java.net.Socket().use { it.connect(java.net.InetSocketAddress("127.0.0.1", TOR_SOCKS_PORT), 1_000) }
}.isSuccess

fun transportsFor(config: NetworkConfig, scope: CoroutineScope, client: OkHttpClient = newSignalingClient(config.torMode)): List<SignalingTransport> =
    config.signaling.map {
        when (it) {
            is SignalingConfig.Nostr -> NostrTransport(it.relays, client, scope)
            is SignalingConfig.Relay -> RelayClient(it.url, client, scope)
        }
    }

/** Runs every configured transport at once; the first copy of a blob wins. */
class SignalingHub(private val transports: List<SignalingTransport>) {
    private val seen = LinkedHashSet<String>()

    val enabled: Boolean get() = transports.isNotEmpty()

    fun start(mailbox: String, onBlob: (blob: SealedBlob, id: String, via: SignalingTransport) -> Unit) {
        for (transport in transports) {
            transport.start(mailbox) { blob, id ->
                val fresh = synchronized(seen) {
                    val added = seen.add(blob.sig)
                    if (seen.size > 2000) seen.remove(seen.first())
                    added
                }
                if (fresh) onBlob(blob, id, transport)
            }
        }
    }

    /** Succeeds if at least one transport accepted the blob. */
    suspend fun put(mailbox: String, blob: SealedBlob, kind: String, ttlSec: Int) {
        if (transports.isEmpty()) throw IllegalStateException("No signaling is configured.")
        val results = kotlinx.coroutines.coroutineScope {
            transports.map { t -> async { runCatching { t.put(mailbox, blob, kind, ttlSec) } } }.awaitAll()
        }
        if (results.none { it.isSuccess }) throw results.first().exceptionOrNull() ?: IllegalStateException("Signaling failed.")
    }

    fun remove(via: SignalingTransport, mailbox: String, id: String) = via.remove(mailbox, id)

    /** Which servers are reachable and what they said, in words (for "could not find that invite"). */
    fun describe(): String = transports.joinToString(" | ") { t ->
        (t as? NostrTransport)?.describe() ?: (t.name + " " + t.status().name.lowercase())
    }

    fun status(): SignalingStatus {
        val states = transports.map { it.status() }
        return when {
            SignalingStatus.ONLINE in states -> SignalingStatus.ONLINE
            SignalingStatus.CONNECTING in states -> SignalingStatus.CONNECTING
            states.isEmpty() -> SignalingStatus.IDLE
            else -> SignalingStatus.ERROR
        }
    }

    fun stop() = transports.forEach { it.stop() }
}
