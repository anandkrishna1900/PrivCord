package com.duochat.app.p2p

import com.duochat.app.ble.BleTransport
import com.duochat.app.ble.SecureBleLink
import com.duochat.app.data.AUTH_TIMEOUT_MS
import com.duochat.app.data.ChatMessage
import com.duochat.app.data.ReplyRef
import com.duochat.app.data.ConnectionPath
import com.duochat.app.data.DeliveryState
import com.duochat.app.data.MAX_TEXT_LENGTH
import com.duochat.app.data.P2PState
import com.duochat.app.data.PROTOCOL_VERSION
import com.duochat.app.data.PeerTrust
import com.duochat.app.data.TransportKind
import com.duochat.app.data.countCodePoints
import com.duochat.app.data.isValidClientMessageId
import com.duochat.app.security.AndroidIdentityManager
import com.duochat.app.security.DeviceIdentity
import com.duochat.app.security.PinnedPeer
import com.duochat.app.security.PublicJwk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.webrtc.PeerConnection
import java.security.SecureRandom

/**
 * One direct connection to the other person: the WebRTC data channel or the Bluetooth LE link,
 * plus the identity handshake (hello / auth_proof / auth_ok) that runs over whichever is open.
 * Mirrors the desktop engine's peer handling.
 */
class PeerSession(
    private val scope: CoroutineScope,
    private val conversationId: String,
    private val selfUid: String,
    private val identityManager: AndroidIdentityManager,
    private val identity: () -> DeviceIdentity?,
    private val pinned: () -> PinnedPeer?,
    private val pinPeer: (uid: String, deviceId: String, key: PublicJwk, dh: PublicJwk) -> Unit,
    private val iceServers: () -> List<PeerConnection.IceServer>,
    private val forceRelay: () -> Boolean,
    private val listener: Listener,
) {
    interface Listener {
        fun onStateChanged(
            state: P2PState,
            connected: Boolean,
            trust: PeerTrust,
            safetyNumber: String?,
            peerUid: String?,
        )

        fun onNotice(message: String)
        fun onFailure(message: String)
        fun onPeerMessage(message: ChatMessage)
        fun onAck(messageId: String, state: DeliveryState, at: Long)
        fun onRead(lastReadMessageId: String)

        /** A group or relay frame (`gmsg`, `group_*`, `relay_blob`) from the authenticated, trusted peer. */
        fun onFrame(frame: JSONObject) {}
    }

    private data class Hello(
        val uid: String,
        val deviceId: String,
        val nonce: String,
        val key: PublicJwk,
        val dh: PublicJwk,
        val proof: String,
    )

    private data class Auth(
        var myNonce: String = "",
        var hello: Hello? = null,
        var proofSent: Boolean = false,
        var proven: Boolean = false,
        var acknowledged: Boolean = false,
        var authenticated: Boolean = false,
        var trust: PeerTrust = PeerTrust.NONE,
        var safetyNumber: String? = null,
    )

    private var auth = Auth()
    private var transport: LinkTransport? = null
    private var authJob: Job? = null
    private var livenessJob: Job? = null
    private val liveness = LivenessMonitor()
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

    /** True while a WebRTC offer/answer exchange is in progress (what manual codes and signaling need). */
    val hasPendingConnection: Boolean
        get() = transport is WebRtcTransport

    val isWebRtc: Boolean
        get() = transport is WebRtcTransport

    val isBluetooth: Boolean
        get() = transport is SecureBleLink

    suspend fun connectionPath(): ConnectionPath? = transport?.connectionPath()

    val iceState: String? get() = (transport as? WebRtcTransport)?.iceState
    val localCandidates get() = (transport as? WebRtcTransport)?.lastCandidates

    /** The peer's identity as it proved itself in the handshake (null before that). */
    fun peerCard(): com.duochat.app.security.ContactCard? =
        auth.hello?.let { com.duochat.app.security.ContactCard(it.key, it.dh, it.proof) }

    /** Device id the peer announced (needed to pin it). */
    fun peerDeviceId(): String? = auth.hello?.deviceId

    fun setExpectedPeerKey(key: PublicJwk?) {
        manualExpectedKey = key
    }

    suspend fun createOffer(): String = newTransport().createOffer()

    suspend fun acceptOffer(sdp: String): String = newTransport().acceptOffer(sdp)

    suspend fun applyAnswer(sdp: String) {
        val current = transport as? WebRtcTransport ?: throw IllegalStateException("No pending connection offer.")
        current.applyAnswer(sdp)
    }

    fun sendJson(value: JSONObject): Boolean = transport?.sendJson(value.toString()) == true

    /** See [LinkTransport.awaitWritable]. */
    suspend fun awaitWritable(): Boolean = transport?.awaitWritable() ?: false

    fun close() {
        cancelTimer()
        transport?.close()
        transport = null
        auth = Auth()
    }

    /** The user compared the safety number: pin this peer so later connections are verified. */
    fun confirmPeer() {
        val hello = auth.hello ?: return
        if (!auth.authenticated) return
        auth.trust = PeerTrust.CONFIRMED
        pinPeer(hello.uid, hello.deviceId, hello.key, hello.dh)
        publishState(P2PState.CONNECTED)
    }

    private fun publishState(state: P2PState) {
        listener.onStateChanged(
            state,
            auth.authenticated &&
                (auth.trust == PeerTrust.VERIFIED || auth.trust == PeerTrust.CONFIRMED),
            auth.trust,
            auth.safetyNumber,
            auth.hello?.uid,
        )
    }

    private fun newTransport(): WebRtcTransport {
        cancelTimer()
        transport?.close()
        frameQueue.clear()
        auth = Auth()
        listener.onStateChanged(P2PState.CONNECTING, false, PeerTrust.NONE, null, null)
        val created = WebRtcTransport(
            iceServers(),
            forceRelay(),
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

    /**
     * Replaces the current link with a Bluetooth one. [create] builds it with handlers bound to this session;
     * callbacks from a link that has since been replaced are ignored so they cannot clobber the new one.
     */
    fun newBluetoothLink(create: (BleTransport.Handlers) -> SecureBleLink): SecureBleLink {
        cancelTimer()
        transport?.close()
        frameQueue.clear()
        auth = Auth()
        listener.onStateChanged(P2PState.CONNECTING, false, PeerTrust.NONE, null, null)
        var created: SecureBleLink? = null
        created = create(
            object : BleTransport.Handlers {
                override fun onOpen() {
                    if (transport === created) handleOpen()
                }

                override fun onClose() {
                    if (transport === created) handleClose()
                }

                override fun onFrame(data: String) {
                    if (transport === created) enqueueFrame(data)
                }

                override fun onError(message: String) {
                    if (transport === created) listener.onNotice(message)
                }
            },
        )
        transport = created
        return created
    }

    private fun cancelTimer() {
        authJob?.cancel()
        authJob = null
        livenessJob?.cancel()
        livenessJob = null
    }

    /**
     * Once authenticated: ping every few seconds and drop the link when nothing at all has arrived for
     * [Liveness.DEAD_LINK_MS], so the normal reconnect logic can take over.
     */
    private fun startLiveness() {
        livenessJob?.cancel()
        liveness.reset()
        livenessJob = scope.launch {
            while (true) {
                delay(Liveness.PING_INTERVAL_MS)
                if (!auth.authenticated) return@launch
                when (liveness.tick()) {
                    LivenessMonitor.Tick.LOST -> {
                        failPeer("Connection to your friend was lost. Reconnecting...")
                        return@launch
                    }
                    LivenessMonitor.Tick.PING -> sendJson(Liveness.ping(System.currentTimeMillis()))
                }
            }
        }
    }

    private fun handleOpen() {
        if (identity() == null) {
            transport?.close()
            transport = null
            return
        }
        cancelTimer()
        auth = Auth(myNonce = randomNonce())
        liveness.reset()
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
                .put("publicKeyJwk", jwk(currentIdentity.publicJwk))
                .put("dhJwk", jwk(currentIdentity.dhJwk))
                .put("identityProof", currentIdentity.identityProof)
                .put("nonce", auth.myNonce),
        )
    }

    private fun handleClose() {
        cancelTimer()
        val wasConnected = auth.authenticated
        auth = Auth()
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
        liveness.onInbound()
        frameQueue.addLast(raw)
        if (processingFrames) return
        processingFrames = true
        scope.launch {
            try {
                while (frameQueue.isNotEmpty()) {
                    processFrame(frameQueue.removeFirst())
                }
            } finally {
                processingFrames = false
            }
        }
    }

    private fun processFrame(raw: String) {
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
            "ping" -> Liveness.parse(frame)?.let { if (auth.authenticated) sendJson(Liveness.pong(it.at)) }
            "pong" -> Unit // already counted as proof of life when it arrived
            "ack" -> if (auth.authenticated) handleAck(frame)
            "read" -> if (auth.authenticated) handleRead(frame)
            "message" -> if (auth.authenticated) handlePeerMessage(frame)
            "gmsg", "group_push", "group_events", "group_have", "relay_blob",
            "declined", "file_offer", "file_chunk", "privacy", "delete", "react",
            -> if (isReady) listener.onFrame(frame)
        }
    }

    private fun handleHello(frame: JSONObject) {
        val uid = frame.optString("uid")
        val deviceId = frame.optString("deviceId")
        val nonce = frame.optString("nonce")
        val key = frame.optJSONObject("publicKeyJwk")?.let { publicKeyFrom(it) }
        val dh = frame.optJSONObject("dhJwk")?.let { publicKeyFrom(it) }
        val proof = frame.optString("identityProof")
        if (
            uid.isEmpty() || deviceId.isEmpty() || nonce.length < 16 ||
            key == null || dh == null || proof.length < 40
        ) {
            return
        }
        val currentIdentity = identity() ?: return
        if (identityManager.publicKeysEqual(currentIdentity.publicJwk, key)) {
            failPeer("Refused a connection that claimed our own device identity.")
            return
        }
        // The id is a fingerprint of the ECDH identity key, and that key is bound
        // to the signing key by a self-signature: nobody can claim someone else's id.
        if (!identityManager.verifyIdentityProof(key, dh, proof)) {
            failPeer("Peer identity proof is invalid.")
            return
        }
        if (identityManager.uidFor(dh) != uid) {
            failPeer("Peer identity does not match its key.")
            return
        }
        val pin = pinned()
        if (pin != null) {
            if (uid != pin.uid || !identityManager.publicKeysEqual(pin.key, key)) {
                failPeer(
                    "This is not the device you paired with. Use Reset pairing in " +
                        "Settings to pair a different one.",
                )
                return
            }
            auth.trust = PeerTrust.VERIFIED
        } else {
            val expected = manualExpectedKey
            if (expected != null && !identityManager.publicKeysEqual(expected, key)) {
                failPeer("Peer identity key does not match the connection code.")
                return
            }
            auth.trust = PeerTrust.UNVERIFIED
        }
        auth.hello = Hello(uid, deviceId, nonce, key, dh, proof)
        sendProofIfReady()
    }

    private fun handleProof(frame: JSONObject) {
        val hello = auth.hello
        val signature = frame.optString("signature")
        if (hello == null || frame.optString("uid") != hello.uid || signature.length <= 40) {
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
        if (frame.optString("uid") != auth.hello?.uid) {
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
            identityManager.sign(challenge)
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
        // Refresh the pinned record for a verified reconnect.
        if (auth.trust == PeerTrust.VERIFIED) pinPeer(hello.uid, hello.deviceId, hello.key, hello.dh)
        publishState(P2PState.CONNECTED)
        startLiveness()
        if (auth.trust == PeerTrust.UNVERIFIED) {
            listener.onNotice(
                "Connected. Compare the safety number with your friend, then mark it " +
                    "verified to start chatting.",
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
        // Until the safety number is confirmed the peer is not trusted: drop its
        // messages. It resends anything unacknowledged once the channel is verified.
        if (!isReady) return
        val messageId = frame.optString("messageId")
        val clientMessageId = frame.optString("clientMessageId")
        val senderId = frame.optString("senderId")
        val text = frame.optString("text")
        val clientCreatedAt = (frame.opt("clientCreatedAt") as? Number)?.toLong() ?: return
        if (!isValidClientMessageId(messageId) || !isValidClientMessageId(clientMessageId)) return
        if (senderId != auth.hello?.uid) return
        if (text.trim().isEmpty() || countCodePoints(text) > MAX_TEXT_LENGTH) return
        if (clientCreatedAt <= 0) return
        val replyTo = if (frame.has("replyTo")) ReplyRef.fromJson(frame.opt("replyTo")) ?: return else null
        val ttl = try { com.duochat.app.data.parseTtl(frame) } catch (_: IllegalArgumentException) { return }
        listener.onPeerMessage(
            ChatMessage(
                messageId = messageId,
                clientMessageId = clientMessageId,
                senderId = senderId,
                text = text,
                clientCreatedAt = clientCreatedAt,
                transport = TransportKind.P2P,
                deliveryState = DeliveryState.DELIVERED,
                readAt = null,
                replyTo = replyTo,
                ttlSec = ttl,
            ),
        )
    }

    private fun failPeer(reason: String) {
        cancelTimer()
        transport?.close()
        transport = null
        frameQueue.clear()
        auth = Auth()
        listener.onFailure(reason)
        listener.onStateChanged(P2PState.FAILED, false, PeerTrust.NONE, null, null)
    }

    private fun jwk(key: PublicJwk): JSONObject =
        JSONObject().put("kty", "EC").put("crv", "P-256").put("x", key.x).put("y", key.y)

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
