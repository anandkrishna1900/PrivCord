package com.duochat.app.p2p

import com.duochat.app.data.AUTH_TIMEOUT_MS
import com.duochat.app.data.ChatMessage
import com.duochat.app.data.DeliveryState
import com.duochat.app.data.MAX_TEXT_LENGTH
import com.duochat.app.data.PROTOCOL_VERSION
import com.duochat.app.data.P2PState
import com.duochat.app.data.PeerKeySource
import com.duochat.app.data.PeerTrust
import com.duochat.app.data.TransportKind
import com.duochat.app.data.countCodePoints
import com.duochat.app.data.isValidClientMessageId
import com.duochat.app.security.AndroidIdentityManager
import com.duochat.app.security.DeviceIdentity
import com.duochat.app.security.PublicJwk
import com.duochat.app.security.ResolvedPeerKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.webrtc.PeerConnection
import java.security.SecureRandom

class PeerSession(
    private val scope: CoroutineScope,
    private val conversationId: String,
    private val selfUid: String,
    private val peerUid: String,
    private val identityManager: AndroidIdentityManager,
    private val identity: () -> DeviceIdentity?,
    private val resolvePeerKey: suspend (deviceId: String) -> ResolvedPeerKey?,
    private val cachePeerKey: (deviceId: String, key: PublicJwk) -> Unit,
    private val iceServers: List<PeerConnection.IceServer>,
    private val listener: Listener,
) {
    enum class Origin { AUTO, MANUAL }

    interface Listener {
        fun onStateChanged(
            state: P2PState,
            connected: Boolean,
            trust: PeerTrust,
            safetyNumber: String?,
            keySource: PeerKeySource?,
        )

        fun onNotice(message: String)
        fun onFailure(message: String)
        fun onPeerMessage(message: ChatMessage)
        fun onAck(messageId: String, state: DeliveryState, at: Long)
        fun onRead(lastReadMessageId: String)
    }

    private data class Hello(
        val uid: String,
        val deviceId: String,
        val nonce: String,
        val key: PublicJwk,
    )

    private data class Auth(
        var myNonce: String = "",
        var hello: Hello? = null,
        var proofSent: Boolean = false,
        var proven: Boolean = false,
        var acknowledged: Boolean = false,
        var authenticated: Boolean = false,
        var origin: Origin = Origin.AUTO,
        var trust: PeerTrust = PeerTrust.NONE,
        var keySource: PeerKeySource? = null,
        var safetyNumber: String? = null,
    )

    private var auth = Auth()
    private var transport: WebRtcTransport? = null
    private var authJob: Job? = null
    private val frameQueue = ArrayDeque<String>()
    private var processingFrames = false
    private var manualExpectedKey: PublicJwk? = null

    val isOpen: Boolean
        get() = transport?.isOpen == true

    val isAuthenticated: Boolean
        get() = auth.authenticated

    val isReady: Boolean
        get() = auth.authenticated &&
            isOpen &&
            (auth.trust == PeerTrust.VERIFIED || auth.trust == PeerTrust.CONFIRMED)

    val hasPendingConnection: Boolean
        get() = transport != null

    val trust: PeerTrust
        get() = auth.trust

    val safetyNumber: String?
        get() = auth.safetyNumber

    val keySource: PeerKeySource?
        get() = auth.keySource

    fun setExpectedPeerKey(key: PublicJwk?) {
        manualExpectedKey = key
    }

    suspend fun createOffer(origin: Origin): String {
        val created = newTransport(origin)
        return created.createOffer()
    }

    suspend fun acceptOffer(origin: Origin, sdp: String): String {
        val created = newTransport(origin)
        return created.acceptOffer(sdp)
    }

    suspend fun applyAnswer(sdp: String) {
        val current = transport ?: throw IllegalStateException("No pending connection offer.")
        current.applyAnswer(sdp)
    }

    fun sendJson(value: JSONObject): Boolean = transport?.sendJson(value.toString()) == true

    fun close() {
        cancelTimer()
        transport?.close()
        transport = null
        resetAuth(auth.origin)
    }

    fun confirmPeer() {
        val hello = auth.hello ?: return
        if (!auth.authenticated) return
        auth.trust = PeerTrust.CONFIRMED
        cachePeerKey(hello.deviceId, hello.key)
        listener.onStateChanged(
            P2PState.CONNECTED,
            true,
            PeerTrust.CONFIRMED,
            auth.safetyNumber,
            auth.keySource,
        )
    }

    private fun newTransport(origin: Origin): WebRtcTransport {
        cancelTimer()
        transport?.close()
        frameQueue.clear()
        resetAuth(origin)
        listener.onStateChanged(P2PState.CONNECTING, false, PeerTrust.NONE, null, null)
        val created = WebRtcTransport(
            iceServers,
            object : WebRtcTransport.Handlers {
                override fun onOpen() = handleOpen()

                override fun onClose() = handleClose()

                override fun onFrame(data: String) = enqueueFrame(data)

                override fun onError(message: String) = listener.onNotice(message)
            },
        )
        transport = created
        return created
    }

    private fun resetAuth(origin: Origin) {
        auth = Auth(
            origin = origin,
            keySource = null,
        )
    }

    private fun cancelTimer() {
        authJob?.cancel()
        authJob = null
    }

    private fun handleOpen() {
        val currentIdentity = identity()
        if (currentIdentity == null) {
            transport?.close()
            transport = null
            return
        }
        cancelTimer()
        auth.myNonce = randomNonce()
        auth.authenticated = false
        frameQueue.clear()
        listener.onStateChanged(P2PState.CONNECTING, false, PeerTrust.NONE, null, null)
        sendHello()
        authJob = scope.launch {
            delay(AUTH_TIMEOUT_MS)
            if (!auth.authenticated) failPeer("Peer identity verification timed out.")
        }
    }

    private fun sendHello() {
        val currentIdentity = identity() ?: return
        if (transport?.isOpen != true) return
        sendJson(
            JSONObject()
                .put("v", PROTOCOL_VERSION)
                .put("kind", "hello")
                .put("uid", selfUid)
                .put("deviceId", currentIdentity.deviceId)
                .put(
                    "publicKeyJwk",
                    JSONObject()
                        .put("kty", "EC")
                        .put("crv", "P-256")
                        .put("x", currentIdentity.publicJwk.x)
                        .put("y", currentIdentity.publicJwk.y),
                )
                .put("nonce", auth.myNonce),
        )
    }

    private fun handleClose() {
        cancelTimer()
        val wasConnected = auth.authenticated
        val origin = auth.origin
        resetAuth(origin)
        frameQueue.clear()
        listener.onStateChanged(
            if (wasConnected) P2PState.FAILED else P2PState.IDLE,
            false,
            PeerTrust.NONE,
            null,
            null,
        )
    }

    private fun enqueueFrame(raw: String) {
        frameQueue.addLast(raw)
        if (processingFrames) return
        processingFrames = true
        scope.launch {
            try {
                while (frameQueue.isNotEmpty()) {
                    val next = frameQueue.removeFirst()
                    processFrame(next)
                }
            } finally {
                processingFrames = false
            }
        }
    }

    private suspend fun processFrame(raw: String) {
        val frame = try {
            JSONObject(raw)
        } catch (_: Exception) {
            return
        }
        if (frame.optInt("v", -1) != PROTOCOL_VERSION) return
        when (frame.optString("kind")) {
            "hello" -> handleHello(frame)
            "auth_proof" -> handleProof(frame)
            "auth_ok" -> handleAuthOk(frame)
            "ack" -> if (auth.authenticated) handleAck(frame)
            "read" -> if (auth.authenticated) handleRead(frame)
            "message" -> if (auth.authenticated) handlePeerMessage(frame)
        }
    }

    private suspend fun handleHello(frame: JSONObject) {
        val uid = frame.optString("uid")
        val deviceId = frame.optString("deviceId")
        val nonce = frame.optString("nonce")
        val keyObject = frame.optJSONObject("publicKeyJwk")
        val key = keyObject?.let { publicKeyFrom(it) }
        if (uid.isEmpty() || deviceId.isEmpty() || nonce.length < 16 || key == null) return
        if (uid != peerUid) {
            failPeer("A different account attempted to connect.")
            return
        }
        val currentIdentity = identity() ?: return
        if (identityManager.publicKeysEqual(currentIdentity.publicJwk, key)) {
            failPeer("Refused a connection that claimed our own device identity.")
            return
        }
        val resolved = resolvePeerKey(deviceId)
        if (resolved != null) {
            if (!identityManager.publicKeysEqual(resolved.key, key)) {
                failPeer("Peer identity key does not match the registered device.")
                return
            }
            auth.trust = PeerTrust.VERIFIED
            auth.keySource = when (resolved.source) {
                "cloud" -> PeerKeySource.CLOUD
                "cache" -> PeerKeySource.CACHE
                else -> PeerKeySource.CACHE
            }
            if (resolved.source == "cloud") cachePeerKey(deviceId, key)
        } else if (auth.origin == Origin.MANUAL) {
            val expected = manualExpectedKey
            if (expected != null && !identityManager.publicKeysEqual(expected, key)) {
                failPeer("This peer's identity key does not match the connection code.")
                return
            }
            auth.trust = PeerTrust.UNVERIFIED
            auth.keySource = PeerKeySource.MANUAL
        } else {
            failPeer(
                "Could not verify the peer device key. Register the peer device in " +
                    "Firestore or use a manual code.",
            )
            return
        }
        auth.hello = Hello(uid, deviceId, nonce, key)
        sendProofIfReady()
    }

    private fun handleProof(frame: JSONObject) {
        val hello = auth.hello
        val uid = frame.optString("uid")
        val signature = frame.optString("signature")
        if (hello == null || uid != peerUid || signature.length <= 40) {
            failPeer("Peer identity proof arrived out of order.")
            return
        }
        val challenge = authChallenge(
            conversationId = conversationId,
            uid = hello.uid,
            deviceId = hello.deviceId,
            nonceSelf = hello.nonce,
            noncePeer = auth.myNonce,
        )
        if (!identityManager.verify(hello.key, challenge, signature)) {
            failPeer("Peer identity proof is invalid.")
            return
        }
        auth.proven = true
        sendJson(
            JSONObject()
                .put("v", PROTOCOL_VERSION)
                .put("kind", "auth_ok")
                .put("uid", selfUid),
        )
        finalizeAuthentication()
    }

    private fun handleAuthOk(frame: JSONObject) {
        if (frame.optString("uid") != peerUid) {
            failPeer("Peer acknowledgement came from the wrong account.")
            return
        }
        auth.acknowledged = true
        finalizeAuthentication()
    }

    private fun sendProofIfReady() {
        val hello = auth.hello ?: return
        if (auth.proofSent || transport?.isOpen != true) return
        val currentIdentity = identity() ?: return
        val challenge = authChallenge(
            conversationId = conversationId,
            uid = selfUid,
            deviceId = currentIdentity.deviceId,
            nonceSelf = auth.myNonce,
            noncePeer = hello.nonce,
        )
        val signature = try {
            identityManager.sign(selfUid, challenge)
        } catch (error: Exception) {
            failPeer("Could not sign the identity proof: ${error.message}")
            return
        }
        auth.proofSent = true
        sendJson(
            JSONObject()
                .put("v", PROTOCOL_VERSION)
                .put("kind", "auth_proof")
                .put("uid", selfUid)
                .put("signature", signature),
        )
    }

    private fun finalizeAuthentication() {
        val hello = auth.hello ?: return
        if (auth.authenticated || !auth.proven || !auth.acknowledged) return
        val currentIdentity = identity() ?: return
        auth.authenticated = true
        cancelTimer()
        auth.safetyNumber = try {
            identityManager.deriveSafetyNumber(currentIdentity.publicJwk, hello.key)
        } catch (_: Exception) {
            null
        }
        listener.onStateChanged(
            P2PState.CONNECTED,
            auth.trust == PeerTrust.VERIFIED || auth.trust == PeerTrust.CONFIRMED,
            auth.trust,
            auth.safetyNumber,
            auth.keySource,
        )
        if (auth.trust == PeerTrust.UNVERIFIED) {
            listener.onNotice(
                "Direct channel established. Compare the safety number with your friend, " +
                    "then mark it verified.",
            )
        }
    }

    private fun handleAck(frame: JSONObject) {
        val messageId = frame.optString("messageId")
        val state = frame.optString("state")
        val at = (frame.opt("at") as? Number)?.toLong() ?: return
        if (messageId.isEmpty() || (state != "DELIVERED" && state != "READ")) return
        listener.onAck(
            messageId,
            if (state == "READ") DeliveryState.READ else DeliveryState.DELIVERED,
            at,
        )
    }

    private fun handleRead(frame: JSONObject) {
        val messageId = frame.optString("lastReadMessageId")
        if (messageId.isEmpty()) return
        listener.onRead(messageId)
    }

    private fun handlePeerMessage(frame: JSONObject) {
        val messageId = frame.optString("messageId")
        val clientMessageId = frame.optString("clientMessageId")
        val senderId = frame.optString("senderId")
        val text = frame.optString("text")
        val clientCreatedAt = (frame.opt("clientCreatedAt") as? Number)?.toLong() ?: return
        if (!isValidClientMessageId(messageId) || !isValidClientMessageId(clientMessageId)) return
        if (senderId != peerUid) return
        if (text.trim().isEmpty() || countCodePoints(text) > MAX_TEXT_LENGTH) return
        if (clientCreatedAt <= 0) return
        listener.onPeerMessage(
            ChatMessage(
                messageId = messageId,
                clientMessageId = clientMessageId,
                senderId = senderId,
                text = text,
                clientCreatedAt = clientCreatedAt,
                serverCreatedAt = null,
                transport = TransportKind.P2P,
                deliveryState = DeliveryState.DELIVERED,
                syncedToCloud = false,
                readAt = null,
            ),
        )
    }

    private fun failPeer(reason: String) {
        cancelTimer()
        transport?.close()
        transport = null
        frameQueue.clear()
        resetAuth(auth.origin)
        listener.onFailure(reason)
        listener.onStateChanged(P2PState.FAILED, false, PeerTrust.NONE, null, null)
    }

    private fun publicKeyFrom(value: JSONObject): PublicJwk? {
        if (value.optString("kty") != "EC" || value.optString("crv") != "P-256") return null
        val x = value.optString("x")
        val y = value.optString("y")
        if (x.length < 40 || y.length < 40) return null
        return PublicJwk(x, y)
    }

    private fun authChallenge(
        conversationId: String,
        uid: String,
        deviceId: String,
        nonceSelf: String,
        noncePeer: String,
    ): String = listOf(
        "duochat-peer-auth-v1",
        conversationId,
        uid,
        deviceId,
        nonceSelf,
        noncePeer,
    ).joinToString("\n")

    private fun randomNonce(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
