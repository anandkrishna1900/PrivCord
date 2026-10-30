package com.duochat.app.engine

import com.duochat.app.ble.BleAvailability
import com.duochat.app.ble.BleEnvironment
import com.duochat.app.ble.bleReconnectDelayMs
import com.duochat.app.data.BluetoothStatus
import com.duochat.app.data.ChatMessage
import com.duochat.app.data.ChatState
import com.duochat.app.data.DeliveryState
import com.duochat.app.data.EnginePhase
import com.duochat.app.data.NetworkConfig
import com.duochat.app.data.MessageStore
import com.duochat.app.data.OutboxRow
import com.duochat.app.data.P2PState
import com.duochat.app.data.PeerTrust
import com.duochat.app.data.PendingContact
import com.duochat.app.data.TransportKind
import com.duochat.app.data.MAX_TEXT_LENGTH
import com.duochat.app.data.compareMessages
import com.duochat.app.data.countCodePoints
import com.duochat.app.data.isValidClientMessageId
import com.duochat.app.data.createOutgoingMessage
import com.duochat.app.data.deriveConnectionMode
import com.duochat.app.data.needsDelivery
import com.duochat.app.p2p.ManualSignal
import com.duochat.app.p2p.ManualSignalCodec
import com.duochat.app.p2p.PeerSession
import com.duochat.app.p2p.iceServers
import com.duochat.app.security.AndroidIdentityManager
import com.duochat.app.security.ContactCard
import com.duochat.app.security.ContactCards
import com.duochat.app.security.Contact
import com.duochat.app.security.DeviceIdentity
import com.duochat.app.security.Seal
import com.duochat.app.security.SealedBlob
import com.duochat.app.security.PinnedPeer
import com.duochat.app.security.PublicJwk
import com.duochat.app.signaling.SignalingHub
import com.duochat.app.signaling.SignalingStatus
import com.duochat.app.signaling.SignalingTransport
import com.duochat.app.signaling.reconnectDelayMs
import com.duochat.app.signaling.transportsFor
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
 * Chat engine: no accounts, no required server. Messages travel over the WebRTC data channel to the
 * one pinned peer; anything unsent stays queued (encrypted at rest) and is sent when the channel
 * opens. Paired friends reconnect automatically through the configured signaling (sealed offers and
 * answers), and an optional store-and-forward relay can hold sealed messages for an offline friend.
 * Mirrors apps/desktop/src/lib/engine.ts.
 */
class ChatEngine(
    private val scope: CoroutineScope,
    private val conversationId: String,
    private val store: MessageStore,
    private val identityManager: AndroidIdentityManager,
    private val networkConfig: () -> NetworkConfig,
    private val onNotify: (ChatMessage) -> Unit,
    /** Null where Bluetooth cannot be used at all (for example in unit tests). */
    private val ble: BleEnvironment? = null,
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
    private var hub: SignalingHub? = null
    private var pendingCard: Contact? = null
    private var lastOfferAt = 0L
    private var offerAttempt = 0
    private var manualActive = false
    private var offerTimeout: Job? = null
    private var bleSearch: Job? = null
    private var lastBleAt = 0L
    private var bleAttempt = 0
    private var bleManualAttempt = false
    private val relayed = mutableSetOf<String>()

    private val selfUid: String
        get() = identity?.uid.orEmpty()

    suspend fun start() {
        try {
            val loadedIdentity = identityManager.load()
            if (loadedIdentity == null) {
                // First run: nothing works until the 12-word phrase flow has created an identity.
                _state.update { it.copy(phase = EnginePhase.NEEDS_IDENTITY) }
                return
            }
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
            startSignaling()
            startTicking()
            refreshBluetooth()
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
        offerTimeout?.cancel()
        bleSearch?.cancel()
        hub?.stop()
        hub = null
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
            scope.launch {
                deliver(message.messageId)
                relayPending()
            }
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
        pendingCard = null
        manualActive = false
        hub?.stop()
        hub = null
        offerTimeout?.cancel()
        relayed.clear()
        p2pSent.clear()
        lastReadWritten = null
        pathJob?.cancel()
        bleSearch?.cancel()
        bleAttempt = 0
        lastBleAt = 0L
        _state.update {
            it.copy(
                paired = false,
                peerUid = null,
                pendingContact = null,
                signaling = SignalingStatus.IDLE,
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
        manualActive = true
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
        manualActive = true
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
        manualActive = false
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
        pinPeer = { uid, deviceId, key, dh -> pin(uid, deviceId, key, dh) },
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
                refreshBluetooth()
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

    private fun pin(uid: String, deviceId: String, key: PublicJwk, dh: PublicJwk) {
        identityManager.pinPeer(uid, deviceId, key, dh)
        val firstTime = pinned == null
        pinned = PinnedPeer(uid, deviceId, key, dh)
        _state.update { it.copy(paired = true, peerUid = uid) }
        if (firstTime) startSignaling(force = true)
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
        manualActive = false
        offerAttempt = 0
        bleAttempt = 0
        offerTimeout?.cancel()
        bleSearch?.cancel()
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
                _state.update { it.copy(signaling = hub?.status() ?: SignalingStatus.IDLE) }
                dropBluetoothIfDisabled()
                if (peer?.isReady == true) {
                    flushUndelivered()
                } else {
                    maybeBluetooth()
                    maybeOffer()
                }
                refreshBluetooth()
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
        ingest(message) { ack -> session.sendJson(ack) }
    }

    /** Store a message from the paired friend, acknowledge it, notify. Shared by the direct and relay paths. */
    private suspend fun ingest(message: ChatMessage, sendAck: (JSONObject) -> Unit) {
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
        sendAck(
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


    // ---------------------------------------------------------------------
    // Contacts: exchange public cards, compare the safety number, pin
    // ---------------------------------------------------------------------

    fun ownCard(name: String? = null): String {
        val current = identity ?: throw IllegalStateException("Identity is not ready.")
        return ContactCards.encode(ContactCard(current.publicJwk, current.dhJwk, current.identityProof, name?.ifBlank { null }))
    }

    /** Validate a pasted contact card and show its safety number. Nothing is saved yet. */
    fun previewContact(text: String) {
        val current = identity ?: throw IllegalStateException("Identity is not ready.")
        val contact = ContactCards.decode(text) ?: throw IllegalArgumentException("This is not a valid DuoChat contact card.")
        if (contact.uid == current.uid) throw IllegalArgumentException("This is your own contact card.")
        val pin = pinned
        if (pin != null && pin.uid != contact.uid) {
            throw IllegalArgumentException("You are already paired with someone else. Reset pairing in Settings first.")
        }
        val safety = identityManager.deriveSafetyNumber(current.publicJwk, contact.card.sign)
        pendingCard = contact
        _state.update { it.copy(pendingContact = PendingContact(contact.uid, safety, contact.card.name)) }
    }

    /** The user compared the safety number over a separate channel: pin the contact. */
    fun confirmContact() {
        val contact = pendingCard ?: return
        pin(contact.uid, "card", contact.card.sign, contact.card.dh)
        pendingCard = null
        offerAttempt = 0
        lastOfferAt = 0
        val signalingOn = networkConfig().signaling.isNotEmpty()
        _state.update {
            it.copy(
                pendingContact = null,
                notice = if (signalingOn) "Friend saved. Connecting automatically whenever you are both online."
                else "Friend saved. No signaling is configured, so connect with a code (Settings > Network).",
            )
        }
        startSignaling(force = true)
    }

    fun cancelContact() {
        pendingCard = null
        _state.update { it.copy(pendingContact = null) }
    }

    // ---------------------------------------------------------------------
    // Signaling: find the paired friend again without typing codes
    // ---------------------------------------------------------------------

    /** Apply changed STUN/TURN/signaling settings; they take effect on the next connection. */
    fun reloadNetwork() {
        startSignaling(force = true)
        _state.update { it.copy(notice = "Network settings applied. They take effect on the next connection.") }
    }

    /** The device gained a network: reconnect the signaling sockets now instead of waiting out the backoff. */
    fun onNetworkAvailable() {
        if (stopped || identity == null) return
        offerAttempt = 0
        lastOfferAt = 0
        if (hub?.status() != SignalingStatus.ONLINE) startSignaling(force = true)
    }

    private fun startSignaling(force: Boolean = false) {
        if (stopped) return
        if (hub != null && !force) return
        hub?.stop()
        hub = null
        val pin = pinned
        val config = networkConfig()
        if (pin?.dh == null || config.signaling.isEmpty()) {
            _state.update { it.copy(signaling = SignalingStatus.IDLE) }
            return
        }
        val created = SignalingHub(transportsFor(config, scope))
        hub = created
        created.start(Seal.mailboxFor(selfUid)) { blob, id, via -> scope.launch { handleBlob(blob, id, via) } }
        offerAttempt = 0
        lastOfferAt = 0
        _state.update { it.copy(signaling = created.status()) }
    }

    private fun sealToPeer(payload: JSONObject): Pair<SealedBlob, String>? {
        val pin = pinned ?: return null
        val dh = pin.dh ?: return null
        val blob = Seal.seal(payload, selfUid, pin.uid, dh) { identityManager.signRaw(it) }
        return blob to Seal.mailboxFor(pin.uid)
    }

    private suspend fun putToPeer(payload: JSONObject, kind: String, ttlSec: Int) {
        val (blob, mailbox) = sealToPeer(payload) ?: throw IllegalStateException("No signaling is available.")
        (hub ?: throw IllegalStateException("No signaling is available.")).put(mailbox, blob, kind, ttlSec)
    }

    private fun isInitiator(): Boolean = pinned?.let { selfUid < it.uid } == true

    private suspend fun handleBlob(blob: SealedBlob, id: String, via: SignalingTransport) {
        val pin = pinned ?: return
        val payload = Seal.open(blob, selfUid, identityManager::dhAgree, pin.key, pin.uid) ?: return
        try {
            when (payload.optString("t")) {
                "ready" -> if (isInitiator()) lastOfferAt = 0
                "offer" -> {
                    val session = peer ?: return
                    val sdp = payload.optString("sdp")
                    if (isInitiator() || manualActive || session.isReady || sdp.isEmpty()) return
                    session.setExpectedPeerKey(null)
                    val answer = session.acceptOffer(sdp)
                    putToPeer(JSONObject().put("t", "answer").put("sdp", answer), "sig", SIGNAL_TTL_SEC)
                    armOfferTimeout()
                }
                "answer" -> {
                    val session = peer ?: return
                    val sdp = payload.optString("sdp")
                    if (!isInitiator() || !session.hasPendingConnection || session.isReady || sdp.isEmpty()) return
                    session.applyAnswer(sdp)
                }
                "msg" -> {
                    val messageId = payload.optString("id")
                    val text = payload.optString("text")
                    val at = (payload.opt("at") as? Number)?.toLong()
                    if (!isValidClientMessageId(messageId) || at == null || at <= 0 ||
                        text.trim().isEmpty() || countCodePoints(text) > MAX_TEXT_LENGTH
                    ) {
                        return
                    }
                    ingest(
                        ChatMessage(
                            messageId = messageId,
                            clientMessageId = messageId,
                            senderId = pin.uid,
                            text = text,
                            clientCreatedAt = at,
                            transport = TransportKind.RELAY,
                            deliveryState = DeliveryState.DELIVERED,
                        ),
                    ) {
                        scope.launch {
                            runCatching { putToPeer(JSONObject().put("t", "ack").put("id", messageId), "msg", MSG_TTL_SEC) }
                        }
                    }
                    hub?.remove(via, Seal.mailboxFor(selfUid), id)
                }
                "ack" -> {
                    val messageId = payload.optString("id")
                    val message = messages[messageId] ?: return
                    if (message.senderId != selfUid) return
                    handleAck(messageId, DeliveryState.DELIVERED, System.currentTimeMillis())
                    hub?.remove(via, Seal.mailboxFor(selfUid), id)
                }
            }
        } catch (error: Exception) {
            _state.update { it.copy(notice = "Signaling failed: ${error.message ?: "unknown error"}") }
        }
    }

    private fun armOfferTimeout() {
        offerTimeout?.cancel()
        offerTimeout = scope.launch {
            delay(OFFER_TIMEOUT_MS)
            val session = peer
            if (session != null && !session.isReady && !manualActive) {
                session.close()
                _state.update { it.copy(p2pState = P2PState.FAILED, notice = "Could not reach your friend. Retrying...") }
                updateConnection()
            }
        }
    }

    /** Reconnect to a paired friend automatically, backing off between attempts (5 s doubling to 120 s). */
    private suspend fun maybeOffer() {
        val pin = pinned
        val current = hub
        relayPending()
        if (pin?.dh == null || current == null || current.status() != SignalingStatus.ONLINE || manualActive) return
        val session = peer ?: return
        val now = System.currentTimeMillis()
        if (_state.value.p2pState == P2PState.CONNECTING) return
        if (now - lastOfferAt < reconnectDelayMs(offerAttempt)) return
        lastOfferAt = now
        offerAttempt += 1
        try {
            if (!isInitiator()) {
                // Tell the friend we are online so they can offer straight away.
                putToPeer(JSONObject().put("t", "ready"), "sig", SIGNAL_TTL_SEC)
                return
            }
            session.setExpectedPeerKey(null)
            val sdp = session.createOffer()
            putToPeer(JSONObject().put("t", "offer").put("sdp", sdp), "sig", SIGNAL_TTL_SEC)
            armOfferTimeout()
        } catch (error: Exception) {
            session.close()
            _state.update { it.copy(p2pState = P2PState.IDLE, notice = "Could not reach signaling: ${error.message ?: "unknown error"}") }
        }
    }

    // ---------------------------------------------------------------------
    // Bluetooth LE: works with no internet, within radio range. UNTESTED on a real radio.
    // ---------------------------------------------------------------------

    /** Re-reads what Bluetooth can do right now (permission, adapter, pairing) for the Settings row. */
    fun refreshBluetooth() {
        val session = peer
        val status = when {
            !networkConfig().bluetooth -> BluetoothStatus.DISABLED
            ble == null -> BluetoothStatus.UNSUPPORTED
            session?.isBluetooth == true && session.isReady -> BluetoothStatus.CONNECTED
            session?.isBluetooth == true -> BluetoothStatus.SEARCHING
            else -> when (ble.availability()) {
                BleAvailability.UNSUPPORTED -> BluetoothStatus.UNSUPPORTED
                BleAvailability.NEEDS_PERMISSION -> BluetoothStatus.NEEDS_PERMISSION
                BleAvailability.ADAPTER_OFF -> BluetoothStatus.ADAPTER_OFF
                BleAvailability.READY -> if (pinned?.dh == null) BluetoothStatus.NOT_PAIRED else BluetoothStatus.READY
            }
        }
        if (_state.value.bluetooth != status) _state.update { it.copy(bluetooth = status) }
    }

    /**
     * Looks for the paired friend over Bluetooth for [BLE_SEARCH_MS]. Never prompts for permissions: when they are
     * missing it fails with a message and the UI asks. [manual] attempts report a timeout to the user.
     */
    suspend fun connectBluetooth(manual: Boolean = true): Result<Unit> {
        val failure = { message: String -> Result.failure<Unit>(IllegalStateException(message)) }
        val environment = ble ?: return failure("Bluetooth is not available in this build.")
        val current = identity ?: return failure("Identity is not ready yet.")
        val pin = pinned
        val friendDh = pin?.dh ?: return failure("Add your friend first.")
        val session = peer ?: return failure("Direct messaging is not ready.")
        if (session.isReady || manualActive || _state.value.p2pState == P2PState.CONNECTING) return Result.success(Unit)
        when (environment.availability()) {
            BleAvailability.UNSUPPORTED -> return failure("This phone has no Bluetooth LE.")
            BleAvailability.NEEDS_PERMISSION -> return failure("Bluetooth permission is needed. Allow it in Settings.")
            BleAvailability.ADAPTER_OFF -> return failure("Bluetooth is off. Turn it on, then try again.")
            BleAvailability.READY -> Unit
        }
        return try {
            val secret = identityManager.dhAgree(friendDh)
            bleManualAttempt = manual
            val link = session.newBluetoothLink { handlers ->
                environment.createLink(
                    secret = secret,
                    // Two phones: the lower uid scans, the higher one is found. A desktop is always the scanner.
                    initiateAsCentral = current.uid < pin.uid,
                    ownUid = current.uid,
                    peerUid = pin.uid,
                    sign = identityManager::signRaw,
                    peerSign = pin.key,
                    handlers = handlers,
                )
            }
            link.start()
            armBluetoothSearch()
            refreshBluetooth()
            Result.success(Unit)
        } catch (error: Exception) {
            session.close()
            _state.update { it.copy(p2pState = P2PState.IDLE) }
            updateConnection()
            failure("Bluetooth could not start: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    private fun armBluetoothSearch() {
        bleSearch?.cancel()
        bleSearch = scope.launch {
            delay(BLE_SEARCH_MS)
            val session = peer
            if (session != null && session.isBluetooth && !session.isAuthenticated) {
                session.close()
                _state.update {
                    it.copy(
                        p2pState = P2PState.IDLE,
                        notice = if (bleManualAttempt) {
                            "No friend found nearby over Bluetooth. Check that they have DuoChat open with Bluetooth on."
                        } else {
                            it.notice
                        },
                    )
                }
                updateConnection()
                refreshBluetooth()
            }
        }
    }

    /** Automatic attempts with backoff, only when Bluetooth is already allowed and on (never prompts). */
    private suspend fun maybeBluetooth() {
        val environment = ble ?: return
        if (!networkConfig().bluetooth || pinned?.dh == null || manualActive) return
        if (_state.value.p2pState == P2PState.CONNECTING) return
        if (environment.availability() != BleAvailability.READY) return
        val now = System.currentTimeMillis()
        if (now - lastBleAt < bleReconnectDelayMs(bleAttempt)) return
        lastBleAt = now
        bleAttempt += 1
        connectBluetooth(manual = false)
    }

    /** Turning the Bluetooth setting off ends a Bluetooth link that is still up or searching. */
    private fun dropBluetoothIfDisabled() {
        val session = peer ?: return
        if (networkConfig().bluetooth || !session.isBluetooth) return
        session.close()
        bleSearch?.cancel()
        _state.update { it.copy(p2pState = P2PState.IDLE, p2pConnected = false, connectionPath = null) }
        updateConnection()
    }

    // ---------------------------------------------------------------------
    // Optional store-and-forward (off by default)
    // ---------------------------------------------------------------------

    private suspend fun relayPending() {
        val current = hub ?: return
        if (!networkConfig().storeForward || pinned?.dh == null || peer?.isReady == true) return
        if (current.status() != SignalingStatus.ONLINE) return
        for (message in sortedMessages()) {
            if (message.senderId != selfUid || !needsDelivery(message.deliveryState)) continue
            if (!relayed.add(message.messageId)) continue
            try {
                putToPeer(
                    JSONObject().put("t", "msg").put("id", message.messageId).put("text", message.text)
                        .put("at", message.clientCreatedAt),
                    "msg",
                    MSG_TTL_SEC,
                )
                messages[message.messageId] = message.copy(transport = TransportKind.RELAY, deliveryState = DeliveryState.SENT)
                store.updateMessage(message.messageId, deliveryState = DeliveryState.SENT, transport = TransportKind.RELAY)
                emitMessages()
            } catch (_: Exception) {
                relayed.remove(message.messageId)
            }
        }
    }

    private fun randomNonce(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private companion object {
        const val TICK_MS = 4_000L
        const val SIGNAL_TTL_SEC = 120
        const val MSG_TTL_SEC = 7 * 24 * 3600
        const val OFFER_TIMEOUT_MS = 40_000L
        /** How long one Bluetooth search lasts before backing off (the desktop uses 20 s). */
        const val BLE_SEARCH_MS = 20_000L
    }
}
