package com.duochat.app.engine

import com.duochat.app.data.ChatMessage
import com.duochat.app.data.ChatState
import com.duochat.app.data.DeliveryState
import com.duochat.app.data.EnginePhase
import com.duochat.app.data.NetworkConfig
import com.duochat.app.data.MessageStore
import com.duochat.app.data.OutboxRow
import com.duochat.app.data.P2PState
import com.duochat.app.data.PeerTrust
import com.duochat.app.data.TransportKind
import com.duochat.app.data.compareMessages
import com.duochat.app.data.createOutgoingMessage
import com.duochat.app.data.deriveConnectionMode
import com.duochat.app.data.needsDelivery
import com.duochat.app.p2p.ManualSignal
import com.duochat.app.p2p.ManualSignalCodec
import com.duochat.app.p2p.PeerSession
import com.duochat.app.p2p.iceServers
import com.duochat.app.security.AndroidIdentityManager
import com.duochat.app.security.DeviceIdentity
import com.duochat.app.security.PinnedPeer
import com.duochat.app.security.PublicJwk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.security.SecureRandom

/**
 * Direct-only chat engine: no accounts, no cloud. Messages travel over the
 * WebRTC data channel to the one pinned peer; anything unsent stays queued
 * (encrypted at rest) and is sent when the channel opens. Mirrors
 * apps/desktop/src/lib/engine.ts.
 */
class ChatEngine(
    private val scope: CoroutineScope,
    private val conversationId: String,
    private val store: MessageStore,
    private val identityManager: AndroidIdentityManager,
    private val networkConfig: () -> NetworkConfig,
    private val onNotify: (ChatMessage) -> Unit,
) {
    private val _state = MutableStateFlow(ChatState(conversationId = conversationId))
    val state: StateFlow<ChatState> = _state.asStateFlow()

    private val messages = linkedMapOf<String, ChatMessage>()
    private val outbox = linkedMapOf<String, OutboxRow>()
    private val p2pSent = mutableSetOf<String>()

    private var identity: DeviceIdentity? = null
    private var pinned: PinnedPeer? = null
    private var peer: PeerSession? = null
    private var stopped = false
    private var visible = false
    private var lastReadWritten: String? = null
    private var tickJob: Job? = null
    private var pathJob: Job? = null

    private val selfUid: String
        get() = identity?.uid.orEmpty()

    suspend fun start() {
        try {
            val loadedIdentity = identityManager.loadOrCreate()
            identity = loadedIdentity
            pinned = identityManager.loadPinnedPeer()

            store.loadMessages().forEach { messages[it.messageId] = it }
            runCatching { store.loadOutbox() }.getOrDefault(emptyList()).forEach { row ->
                outbox[row.messageId] = row
            }
            if (stopped) return

            _state.update {
                it.copy(
                    phase = EnginePhase.READY,
                    uid = loadedIdentity.uid,
                    peerUid = pinned?.uid,
                    paired = pinned != null,
                    messages = sortedMessages(),
                    queuedCount = outbox.size,
                )
            }
            peer = buildPeerSession(loadedIdentity)
            updateConnection()
            startTicking()
        } catch (error: Exception) {
            if (!stopped) {
                _state.update {
                    it.copy(phase = EnginePhase.ERROR, error = error.message ?: "Startup failed.")
                }
            }
        }
    }

    fun stop() {
        stopped = true
        tickJob?.cancel()
        pathJob?.cancel()
        peer?.close()
        peer = null
        _state.update { it.copy(phase = EnginePhase.STOPPED) }
    }

    fun setVisible(isVisible: Boolean) {
        visible = isVisible
        if (isVisible) scope.launch { markRead() }
    }

    fun clearNotice() {
        _state.update { it.copy(notice = null, error = null) }
    }

    fun confirmPeer() {
        peer?.confirmPeer()
    }

    suspend fun send(rawText: String): Result<Unit> {
        if (identity == null) {
            return Result.failure(IllegalStateException("Identity is not ready yet."))
        }
        return try {
            val message = createOutgoingMessage(selfUid, rawText)
            messages[message.messageId] = message
            store.putMessage(message)
            val row = OutboxRow(
                messageId = message.messageId,
                recipientId = _state.value.peerUid.orEmpty(),
                payload = message.messageId,
                createdAt = System.currentTimeMillis(),
                attemptCount = 0,
                lastAttemptAt = null,
                deliveryState = DeliveryState.QUEUED,
                lastError = null,
            )
            outbox[row.messageId] = row
            store.enqueueOutbox(row)
            emitMessages()
            scope.launch { deliver(message.messageId) }
            Result.success(Unit)
        } catch (error: Exception) {
            Result.failure(error)
        }
    }

    suspend fun retry(messageId: String) {
        val message = messages[messageId] ?: return
        if (message.senderId != selfUid) return
        p2pSent.remove(messageId)
        deliver(messageId)
    }

    /** Sends one own message over the direct channel if it is up; otherwise it stays queued. */
    private suspend fun deliver(messageId: String) {
        val message = messages[messageId] ?: return
        if (message.senderId != selfUid || !needsDelivery(message.deliveryState)) return
        val session = peer ?: return
        if (!session.isReady || messageId in p2pSent) return
        val frame = JSONObject()
            .put("v", 1)
            .put("kind", "message")
            .put("messageId", message.messageId)
            .put("clientMessageId", message.clientMessageId)
            .put("senderId", message.senderId)
            .put("text", message.text)
            .put("clientCreatedAt", message.clientCreatedAt)
        if (!session.sendJson(frame)) return

        p2pSent += messageId
        messages[messageId] = message.copy(
            transport = TransportKind.P2P,
            deliveryState = DeliveryState.SENT,
        )
        store.updateMessage(messageId, deliveryState = DeliveryState.SENT, transport = TransportKind.P2P)
        outbox[messageId]?.let { row ->
            val now = System.currentTimeMillis()
            outbox[messageId] = row.copy(deliveryState = DeliveryState.SENT, lastAttemptAt = now)
            store.updateOutboxDelivery(messageId, DeliveryState.SENT, now)
        }
        emitMessages()
    }

    private fun flushUndelivered() {
        for (message in messages.values.toList()) {
            if (message.senderId == selfUid && needsDelivery(message.deliveryState)) {
                scope.launch { deliver(message.messageId) }
            }
        }
    }

    suspend fun clearLocalData() {
        store.clearAll()
        messages.clear()
        outbox.clear()
        p2pSent.clear()
        lastReadWritten = null
        emitMessages()
        _state.update { it.copy(notice = "Local messages and the send queue were cleared.") }
    }

    /**
     * Per-conversation kill switch (Option A "CLEAR LOCAL CHAT"): erase this
     * chat's local content only. Identity keys and settings are untouched.
     */
    suspend fun clearLocalChat() {
        store.clearConversation()
        messages.clear()
        outbox.clear()
        p2pSent.clear()
        lastReadWritten = null
        emitMessages()
        _state.update { it.copy(notice = "This chat was cleared locally.") }
    }

    /**
     * Per-conversation kill switch (Option B extra "DELETE CHAT AND LOCAL
     * SESSION STATE"): closes the authenticated channel and forgets the pinned
     * peer, so a new identity handshake is required before sending again.
     */
    suspend fun eraseLocalChatSession() {
        identityManager.erasePeerKey(null)
        resetConnection("Local chat erased. Sending again requires a new identity handshake.")
    }

    /** Forgets the pinned peer so a different device can be paired. Messages are kept. */
    fun resetPairing() {
        identityManager.erasePeerKey(null)
        resetConnection("Pairing reset. Connect again to pair a device.")
    }

    private fun resetConnection(notice: String) {
        peer?.close()
        pinned = null
        p2pSent.clear()
        lastReadWritten = null
        pathJob?.cancel()
        _state.update {
            it.copy(
                paired = false,
                peerUid = null,
                p2pState = P2PState.IDLE,
                p2pConnected = false,
                peerTrust = PeerTrust.NONE,
                safetyNumber = null,
                connectionPath = null,
                notice = notice,
            )
        }
        updateConnection()
    }

    /**
     * A code is only accepted if its id matches its own key (via the identity
     * proof) and, once paired, only if it comes from the paired device.
     */
    private fun checkSignalIdentity(signal: ManualSignal) {
        if (signal.fromUid == selfUid) {
            throw IllegalArgumentException("This code was created on this device.")
        }
        if (!identityManager.verifyIdentityProof(signal.publicKeyJwk, signal.dhJwk, signal.identityProof)) {
            throw IllegalArgumentException(
                "This connection code is corrupted: its identity proof is invalid.",
            )
        }
        if (identityManager.uidFor(signal.dhJwk) != signal.fromUid) {
            throw IllegalArgumentException(
                "This connection code is corrupted: its identity does not match its key.",
            )
        }
        val pin = pinned
        if (pin != null &&
            (signal.fromUid != pin.uid || !identityManager.publicKeysEqual(pin.key, signal.publicKeyJwk))
        ) {
            throw IllegalArgumentException(
                "This code comes from a different device than the one you paired with. " +
                    "Use Reset pairing in Settings to pair a new one.",
            )
        }
    }

    private fun localSignal(kind: String, sdp: String, currentIdentity: DeviceIdentity) =
        ManualSignal(
            kind = kind,
            conversationId = conversationId,
            fromUid = currentIdentity.uid,
            fromDeviceId = currentIdentity.deviceId,
            publicKeyJwk = currentIdentity.publicJwk,
            dhJwk = currentIdentity.dhJwk,
            identityProof = currentIdentity.identityProof,
            sdp = sdp,
            nonce = randomNonce(),
            createdAt = System.currentTimeMillis(),
        )

    suspend fun createManualOffer(): String {
        val currentIdentity = identity ?: throw IllegalStateException("Identity is not ready.")
        val session = peer ?: throw IllegalStateException("Direct messaging is not ready.")
        _state.update { it.copy(notice = null) }
        session.setExpectedPeerKey(null)
        return try {
            ManualSignalCodec.encode(localSignal("offer", session.createOffer(), currentIdentity))
        } catch (error: Exception) {
            session.close()
            throw error
        }
    }

    suspend fun applyManualAnswer(code: String) {
        val decoded = ManualSignalCodec.decode(code, conversationId)
        if (decoded.kind != "answer") {
            throw IllegalArgumentException(
                "This code is an offer. The other user must paste your offer and send back an answer.",
            )
        }
        checkSignalIdentity(decoded)
        val session = peer ?: throw IllegalStateException("Direct messaging is not ready.")
        if (!session.hasPendingConnection) {
            throw IllegalStateException("Create an offer before pasting an answer.")
        }
        session.setExpectedPeerKey(decoded.publicKeyJwk)
        session.applyAnswer(decoded.sdp)
        _state.update { it.copy(p2pState = P2PState.CONNECTING) }
    }

    suspend fun acceptManualOffer(code: String): String {
        val currentIdentity = identity ?: throw IllegalStateException("Identity is not ready.")
        val decoded = ManualSignalCodec.decode(code, conversationId)
        if (decoded.kind != "offer") {
            throw IllegalArgumentException(
                "This code is an answer. Paste the offer from the other user instead.",
            )
        }
        checkSignalIdentity(decoded)
        _state.update { it.copy(notice = null) }
        val session = peer ?: throw IllegalStateException("Direct messaging is not ready.")
        session.setExpectedPeerKey(decoded.publicKeyJwk)
        return try {
            ManualSignalCodec.encode(
                localSignal("answer", session.acceptOffer(decoded.sdp), currentIdentity),
            )
        } catch (error: Exception) {
            session.close()
            throw error
        }
    }

    fun cancelManual() {
        peer?.setExpectedPeerKey(null)
        peer?.close()
        pathJob?.cancel()
        _state.update {
            it.copy(
                p2pState = P2PState.IDLE,
                p2pConnected = false,
                peerTrust = PeerTrust.NONE,
                safetyNumber = null,
                connectionPath = null,
            )
        }
        updateConnection()
    }

    private fun buildPeerSession(currentIdentity: DeviceIdentity): PeerSession = PeerSession(
        scope = scope,
        conversationId = conversationId,
        selfUid = currentIdentity.uid,
        identityManager = identityManager,
        identity = { identity },
        pinned = { pinned },
        pinPeer = { uid, deviceId, key -> pin(uid, deviceId, key) },
        iceServers = { networkConfig().iceServers() },
        forceRelay = { networkConfig().forceRelay },
        listener = object : PeerSession.Listener {
            override fun onStateChanged(
                state: P2PState,
                connected: Boolean,
                trust: PeerTrust,
                safetyNumber: String?,
                peerUid: String?,
            ) {
                _state.update {
                    it.copy(
                        p2pState = state,
                        p2pConnected = connected,
                        peerTrust = trust,
                        safetyNumber = safetyNumber,
                        peerUid = peerUid ?: pinned?.uid,
                        paired = pinned != null,
                        connectionPath = if (state == P2PState.CONNECTED) it.connectionPath else null,
                    )
                }
                if (state == P2PState.CONNECTED) detectPath()
                if (connected) onChannelReady()
                updateConnection()
            }

            override fun onNotice(message: String) {
                _state.update { it.copy(notice = message) }
            }

            override fun onFailure(message: String) {
                _state.update {
                    it.copy(
                        p2pState = P2PState.FAILED,
                        p2pConnected = false,
                        peerTrust = PeerTrust.NONE,
                        safetyNumber = null,
                        connectionPath = null,
                        notice = message,
                    )
                }
                updateConnection()
            }

            override fun onPeerMessage(message: ChatMessage) {
                scope.launch { handlePeerMessage(message) }
            }

            override fun onAck(messageId: String, state: DeliveryState, at: Long) {
                scope.launch { handleAck(messageId, state, at) }
            }

            override fun onRead(lastReadMessageId: String) {
                scope.launch { applyPeerReadThrough(lastReadMessageId) }
            }
        },
    )

    private fun pin(uid: String, deviceId: String, key: PublicJwk) {
        identityManager.pinPeer(uid, deviceId, key)
        pinned = PinnedPeer(uid, deviceId, key)
        _state.update { it.copy(paired = true, peerUid = uid) }
    }

    /** Reads the real route (host / srflx / relay) once the channel is up; retries while stats settle. */
    private fun detectPath() {
        pathJob?.cancel()
        pathJob = scope.launch {
            for (attempt in 1..5) {
                delay(400L * attempt)
                val path = peer?.connectionPath()
                if (path != null) {
                    _state.update { it.copy(connectionPath = path) }
                    return@launch
                }
            }
        }
    }

    private fun onChannelReady() {
        p2pSent.clear()
        lastReadWritten = null
        flushUndelivered()
        if (visible) scope.launch { markRead() }
    }

    private suspend fun applyPeerReadThrough(messageId: String) {
        val ordered = sortedMessages()
        val index = ordered.indexOfFirst { it.messageId == messageId }
        if (index < 0) return
        var changed = false
        val now = System.currentTimeMillis()
        for (i in 0..index) {
            val message = ordered[i]
            if (message.senderId != selfUid || message.deliveryState == DeliveryState.READ) continue
            val updated = message.copy(deliveryState = DeliveryState.READ, readAt = message.readAt ?: now)
            messages[updated.messageId] = updated
            store.updateMessage(
                updated.messageId,
                deliveryState = DeliveryState.READ,
                readAt = updated.readAt,
                setReadAt = true,
            )
            dropOutbox(updated.messageId)
            changed = true
        }
        if (changed) emitMessages()
    }

    private suspend fun dropOutbox(messageId: String) {
        if (outbox.remove(messageId) != null) runCatching { store.removeOutbox(messageId) }
    }

    private fun startTicking() {
        tickJob?.cancel()
        tickJob = scope.launch {
            while (!stopped) {
                delay(TICK_MS)
                if (peer?.isReady == true) flushUndelivered()
            }
        }
    }

    private fun updateConnection() {
        val connected = peer?.isReady == true
        val mode = deriveConnectionMode(
            p2pConnected = connected,
            connecting = _state.value.p2pState == P2PState.CONNECTING,
            reconnecting = false,
            failed = _state.value.p2pState == P2PState.FAILED,
        )
        _state.update { it.copy(connectionMode = mode, queuedCount = outbox.size) }
    }

    private suspend fun markRead() {
        val ordered = sortedMessages()
        val last = ordered.lastOrNull() ?: return
        var changed = false
        val now = System.currentTimeMillis()
        for (message in ordered) {
            if (message.senderId == selfUid || message.readAt != null) continue
            messages[message.messageId] = message.copy(readAt = now)
            store.updateMessage(message.messageId, readAt = now, setReadAt = true)
            changed = true
        }
        if (changed) emitMessages()
        val session = peer
        if (lastReadWritten != last.messageId && session?.isReady == true) {
            lastReadWritten = last.messageId
            session.sendJson(
                JSONObject()
                    .put("v", 1)
                    .put("kind", "read")
                    .put("lastReadMessageId", last.messageId)
                    .put("at", now),
            )
        }
    }

    private suspend fun handlePeerMessage(message: ChatMessage) {
        val session = peer ?: return
        if (!session.isReady || message.senderId == selfUid) return
        val existing = messages[message.messageId]
        val merged = if (existing != null) {
            existing.copy(
                deliveryState = highestDelivery(existing.deliveryState, message.deliveryState),
                readAt = existing.readAt ?: message.readAt,
            )
        } else {
            message
        }
        messages[merged.messageId] = merged
        store.putMessage(merged)
        emitMessages()
        session.sendJson(
            JSONObject()
                .put("v", 1)
                .put("kind", "ack")
                .put("messageId", merged.messageId)
                .put("state", "DELIVERED")
                .put("at", System.currentTimeMillis()),
        )
        if (existing == null) onNotify(merged)
        if (visible) markRead()
    }

    private suspend fun handleAck(messageId: String, state: DeliveryState, at: Long) {
        val message = messages[messageId] ?: return
        if (message.senderId != selfUid) return
        val next = if (state == DeliveryState.READ || message.deliveryState == DeliveryState.READ) {
            DeliveryState.READ
        } else {
            DeliveryState.DELIVERED
        }
        val updated = message.copy(
            deliveryState = next,
            readAt = if (state == DeliveryState.READ) at else message.readAt,
        )
        messages[messageId] = updated
        store.updateMessage(
            messageId,
            deliveryState = updated.deliveryState,
            readAt = updated.readAt,
            setReadAt = updated.readAt != null,
        )
        dropOutbox(messageId)
        emitMessages()
        updateConnection()
    }

    private fun highestDelivery(first: DeliveryState, second: DeliveryState): DeliveryState {
        if (first == DeliveryState.FAILED && second == DeliveryState.FAILED) return DeliveryState.FAILED
        if (first == DeliveryState.FAILED) return second
        if (second == DeliveryState.FAILED) return first
        val rank = mapOf(
            DeliveryState.QUEUED to 0,
            DeliveryState.SENT to 1,
            DeliveryState.DELIVERED to 2,
            DeliveryState.READ to 3,
        )
        return if ((rank[first] ?: 0) >= (rank[second] ?: 0)) first else second
    }

    private fun sortedMessages(): List<ChatMessage> =
        messages.values.sortedWith { first, second -> compareMessages(first, second) }

    private fun emitMessages() {
        _state.update { it.copy(messages = sortedMessages(), queuedCount = outbox.size) }
    }

    private fun randomNonce(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private companion object {
        const val TICK_MS = 4_000L
    }
}
