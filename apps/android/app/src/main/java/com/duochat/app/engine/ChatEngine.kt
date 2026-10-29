package com.duochat.app.engine

import com.duochat.app.AppConfig
import com.duochat.app.data.ChatMessage
import com.duochat.app.data.ChatState
import com.duochat.app.data.CloudRepository
import com.duochat.app.data.ConnectionMode
import com.duochat.app.data.DeliveryState
import com.duochat.app.data.EnginePhase
import com.duochat.app.data.IncomingSignal
import com.duochat.app.data.MAX_TEXT_LENGTH
import com.duochat.app.data.MessageMode
import com.duochat.app.data.MessageStore
import com.duochat.app.data.OutboxRow
import com.duochat.app.data.P2PState
import com.duochat.app.data.PeerKeySource
import com.duochat.app.data.PeerTrust
import com.duochat.app.data.TransportKind
import com.duochat.app.data.allowsCloudWrites
import com.duochat.app.data.canAttemptDelivery
import com.duochat.app.data.compareMessages
import com.duochat.app.data.countCodePoints
import com.duochat.app.data.createOutgoingMessage
import com.duochat.app.data.deriveConnectionMode
import com.duochat.app.data.isValidClientMessageId
import com.duochat.app.p2p.ManualSignal
import com.duochat.app.p2p.ManualSignalCodec
import com.duochat.app.p2p.PeerSession
import com.duochat.app.security.AndroidIdentityManager
import com.duochat.app.security.DeviceIdentity
import com.duochat.app.security.PublicJwk
import com.duochat.app.security.ResolvedPeerKey
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.ListenerRegistration
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
import kotlin.math.min
import kotlin.math.pow

class ChatEngine(
    private val scope: CoroutineScope,
    private val uid: String,
    private val peerUid: String,
    private val conversationId: String,
    private val email: String,
    private val displayName: String,
    private val store: MessageStore,
    private val repository: CloudRepository,
    private val identityManager: AndroidIdentityManager,
    initialMessageMode: MessageMode = MessageMode.CLOUD,
    private val onNotify: (ChatMessage) -> Unit,
) {
    private val _state = MutableStateFlow(
        ChatState(
            uid = uid,
            peerUid = peerUid,
            conversationId = conversationId,
            messageMode = initialMessageMode,
        ),
    )
    val state: StateFlow<ChatState> = _state.asStateFlow()

    private var messageMode = initialMessageMode
    private val messages = linkedMapOf<String, ChatMessage>()
    private val outbox = linkedMapOf<String, OutboxRow>()
    private val knownIds = mutableSetOf<String>()
    private val cloudInFlight = mutableSetOf<String>()
    private val p2pSent = mutableSetOf<String>()
    private val unsubs = mutableListOf<ListenerRegistration>()

    private var identity: DeviceIdentity? = null
    private var peer: PeerSession? = null
    private var cursor: DocumentSnapshot? = null
    private var cloudOk = false
    private var draining = false
    private var stopped = false
    private var visible = false
    private var manualMode = false
    private var lastReadWritten: String? = null
    private var lastOfferAt = 0L
    private var lastPresenceAt = 0L
    private var tickJob: Job? = null
    private var healthJob: Job? = null
    private var offerJob: Job? = null

    suspend fun start() {
        try {
            val loadedIdentity = identityManager.loadOrCreate(uid)
            identity = loadedIdentity
            val ownProfile = runCatching { repository.loadProfile(uid) }.getOrNull()
            val peerProfile = runCatching { repository.loadProfile(peerUid) }.getOrNull()
            runCatching {
                repository.ensureOwnProfile(uid, email, displayName)
            }.onFailure { error ->
                _state.update { it.copy(notice = "Profile setup failed: ${error.message}") }
            }
            runCatching {
                repository.registerDevice(uid, loadedIdentity.deviceId, loadedIdentity.publicJwk)
            }.onFailure { error ->
                _state.update {
                    it.copy(notice = "Device identity could not be registered: ${error.message}")
                }
            }

            store.loadMessages().forEach { message ->
                messages[message.messageId] = message
                knownIds += message.messageId
            }
            runCatching { store.loadOutbox() }.getOrDefault(emptyList()).forEach { row ->
                outbox[row.messageId] = row
            }

            _state.update {
                it.copy(
                    phase = EnginePhase.READY,
                    selfProfile = ownProfile,
                    peerProfile = peerProfile,
                    messages = sortedMessages(),
                    queuedCount = outbox.size,
                )
            }

            peer = buildPeerSession()
            startSubscriptions()
            updateConnection()
            scheduleHealthCheck(0)
            startTicking()
            scope.launch { touchPresence() }
        } catch (error: Exception) {
            _state.update {
                it.copy(phase = EnginePhase.ERROR, error = error.message ?: "Startup failed.")
            }
        }
    }

    fun stop() {
        stopped = true
        tickJob?.cancel()
        healthJob?.cancel()
        offerJob?.cancel()
        unsubs.forEach { it.remove() }
        unsubs.clear()
        peer?.close()
        peer = null
        _state.update { it.copy(phase = EnginePhase.STOPPED) }
    }

    fun setVisible(isVisible: Boolean) {
        visible = isVisible
        if (isVisible) scope.launch { markRead() }
    }

    fun setMessageMode(mode: MessageMode) {
        if (mode == messageMode) return
        messageMode = mode
        _state.update {
            it.copy(
                messageMode = mode,
                notice = if (mode == MessageMode.DIRECT) {
                    "Direct mode enabled. New messages stay on this device until the direct channel accepts them."
                } else {
                    "Cloud mode enabled. Pending messages will be uploaded to the cloud."
                },
            )
        }
        if (mode == MessageMode.CLOUD) {
            lastReadWritten = null
            scope.launch { markRead() }
            if (cloudOk) scope.launch { drainOutbox() }
        } else {
            p2pSent.clear()
            scope.launch {
                requeueFailedMessages()
                drainOutbox()
            }
        }
    }

    fun clearNotice() {
        _state.update { it.copy(notice = null, error = null) }
    }

    fun confirmPeer() {
        peer?.confirmPeer()
    }

    fun requestDirectConnection() {
        lastOfferAt = 0
        _state.update {
            it.copy(
                notice = if (isInitiator()) {
                    "Looking for a direct peer path?"
                } else {
                    "Direct negotiation is initiated by the peer with the lower account ID. " +
                        "Use manual setup if automatic signaling is unavailable."
                },
            )
        }
        if (isInitiator()) scope.launch { maybeStartAutomaticOffer() }
    }

    suspend fun send(rawText: String): Result<Unit> {
        val currentIdentity = identity
            ?: return Result.failure(IllegalStateException("Identity is not ready yet."))
        return try {
            val message = createOutgoingMessage(uid, rawText)
            messages[message.messageId] = message
            knownIds += message.messageId
            store.putMessage(message)
            val row = OutboxRow(
                messageId = message.messageId,
                recipientId = peerUid,
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
        if (message.senderId != uid) return
        val updated = message.copy(deliveryState = DeliveryState.QUEUED)
        messages[messageId] = updated
        store.updateMessage(messageId, deliveryState = DeliveryState.QUEUED)
        val existing = outbox[messageId]
        val row = (existing ?: OutboxRow(
            messageId = messageId,
            recipientId = peerUid,
            payload = messageId,
            createdAt = System.currentTimeMillis(),
            attemptCount = 0,
            lastAttemptAt = null,
            deliveryState = DeliveryState.QUEUED,
            lastError = null,
        )).copy(
            deliveryState = DeliveryState.QUEUED,
            lastError = null,
            lastAttemptAt = null,
        )
        outbox[messageId] = row
        store.enqueueOutbox(row)
        p2pSent.remove(messageId)
        emitMessages()
        deliver(messageId)
    }

    private suspend fun requeueFailedMessages() {
        val failed = messages.values.filter {
            it.senderId == uid && it.deliveryState == DeliveryState.FAILED
        }
        if (failed.isEmpty()) return
        for (message in failed) {
            val queued = message.copy(deliveryState = DeliveryState.QUEUED)
            messages[queued.messageId] = queued
            store.updateMessage(queued.messageId, deliveryState = DeliveryState.QUEUED)
            val existing = outbox[queued.messageId]
            val row = (existing ?: OutboxRow(
                messageId = queued.messageId,
                recipientId = peerUid,
                payload = queued.messageId,
                createdAt = System.currentTimeMillis(),
                attemptCount = 0,
                lastAttemptAt = null,
                deliveryState = DeliveryState.QUEUED,
                lastError = null,
            )).copy(
                attemptCount = 0,
                lastAttemptAt = null,
                deliveryState = DeliveryState.QUEUED,
                lastError = null,
            )
            outbox[queued.messageId] = row
            store.enqueueOutbox(row)
            p2pSent.remove(queued.messageId)
        }
        emitMessages()
    }

    suspend fun loadOlder() {
        val activeCursor = cursor ?: return
        if (_state.value.loadingOlder || !cloudOk) return
        _state.update { it.copy(loadingOlder = true) }
        try {
            val page = repository.fetchOlderMessages(conversationId, activeCursor)
            cursor = page.cursor
            val changed = mutableListOf<ChatMessage>()
            for (message in page.messages) {
                if (!messages.containsKey(message.messageId)) {
                    messages[message.messageId] = message
                    knownIds += message.messageId
                    changed += message
                }
            }
            for (message in changed) store.putMessage(message)
            _state.update { it.copy(hasOlder = page.hasMore) }
            emitMessages()
        } catch (error: Exception) {
            _state.update { it.copy(notice = "Could not load older messages: ${error.message}") }
        } finally {
            _state.update { it.copy(loadingOlder = false) }
        }
    }

    suspend fun changeDisplayName(name: String) {
        repository.updateDisplayName(uid, name)
    }

    suspend fun clearLocalData() {
        store.clearAll()
        messages.clear()
        outbox.clear()
        knownIds.clear()
        p2pSent.clear()
        lastReadWritten = null
        emitMessages()
        _state.update {
            it.copy(notice = "Local messages, queue, and cached metadata were cleared.")
        }
    }

    suspend fun createManualOffer(): String {
        val currentIdentity = identity
            ?: throw IllegalStateException("Identity is not ready.")
        manualMode = true
        _state.update { it.copy(manualMode = true, notice = null) }
        val session = peer ?: throw IllegalStateException("Direct messaging is not ready.")
        session.setExpectedPeerKey(null)
        return try {
            val sdp = session.createOffer(PeerSession.Origin.MANUAL)
            ManualSignalCodec.encode(
                ManualSignal(
                    kind = "offer",
                    conversationId = conversationId,
                    fromUid = uid,
                    fromDeviceId = currentIdentity.deviceId,
                    publicKeyJwk = currentIdentity.publicJwk,
                    sdp = sdp,
                    nonce = randomNonce(),
                    createdAt = System.currentTimeMillis(),
                ),
            )
        } catch (error: Exception) {
            manualMode = false
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
        if (decoded.fromUid != peerUid) {
            throw IllegalArgumentException("This connection code belongs to a different account.")
        }
        val session = peer ?: throw IllegalStateException("Direct messaging is not ready.")
        if (!session.hasPendingConnection) {
            throw IllegalStateException("Create an offer before pasting an answer.")
        }
        val resolved = resolvePeerKey(decoded.fromDeviceId)
        if (resolved != null && !identityManager.publicKeysEqual(resolved.key, decoded.publicKeyJwk)) {
            throw IllegalArgumentException("This answer does not match the verified peer device key.")
        }
        session.setExpectedPeerKey(decoded.publicKeyJwk)
        session.applyAnswer(decoded.sdp)
        _state.update { it.copy(manualMode = true, p2pState = P2PState.CONNECTING) }
    }

    suspend fun acceptManualOffer(code: String): String {
        val currentIdentity = identity
            ?: throw IllegalStateException("Identity is not ready.")
        val decoded = ManualSignalCodec.decode(code, conversationId)
        if (decoded.kind != "offer") {
            throw IllegalArgumentException(
                "This code is an answer. Paste the offer from the other user instead.",
            )
        }
        if (decoded.fromUid != peerUid) {
            throw IllegalArgumentException("This connection code belongs to a different account.")
        }
        val resolved = resolvePeerKey(decoded.fromDeviceId)
        if (resolved != null && !identityManager.publicKeysEqual(resolved.key, decoded.publicKeyJwk)) {
            throw IllegalArgumentException("This offer does not match the verified peer device key.")
        }
        manualMode = true
        _state.update { it.copy(manualMode = true, notice = null) }
        val session = peer ?: throw IllegalStateException("Direct messaging is not ready.")
        session.setExpectedPeerKey(decoded.publicKeyJwk)
        return try {
            val sdp = session.acceptOffer(PeerSession.Origin.MANUAL, decoded.sdp)
            ManualSignalCodec.encode(
                ManualSignal(
                    kind = "answer",
                    conversationId = conversationId,
                    fromUid = uid,
                    fromDeviceId = currentIdentity.deviceId,
                    publicKeyJwk = currentIdentity.publicJwk,
                    sdp = sdp,
                    nonce = randomNonce(),
                    createdAt = System.currentTimeMillis(),
                ),
            )
        } catch (error: Exception) {
            session.close()
            manualMode = false
            throw error
        }
    }

    fun cancelManual() {
        manualMode = false
        peer?.setExpectedPeerKey(null)
        peer?.close()
        _state.update {
            it.copy(
                manualMode = false,
                p2pState = P2PState.IDLE,
                p2pConnected = false,
                peerTrust = PeerTrust.NONE,
                safetyNumber = null,
                peerKeySource = null,
            )
        }
        updateConnection()
    }

    private fun buildPeerSession(): PeerSession = PeerSession(
        scope = scope,
        conversationId = conversationId,
        selfUid = uid,
        peerUid = peerUid,
        identityManager = identityManager,
        identity = { identity },
        resolvePeerKey = { deviceId -> resolvePeerKey(deviceId) },
        cachePeerKey = { deviceId, key ->
            identityManager.cachePeerKey(peerUid, deviceId, key)
        },
        iceServers = AppConfig.iceServers(),
        listener = object : PeerSession.Listener {
            override fun onStateChanged(
                state: P2PState,
                connected: Boolean,
                trust: PeerTrust,
                safetyNumber: String?,
                keySource: PeerKeySource?,
            ) {
                _state.update {
                    it.copy(
                        p2pState = state,
                        p2pConnected = connected,
                        peerTrust = trust,
                        safetyNumber = safetyNumber,
                        peerKeySource = keySource,
                    )
                }
                if (connected) {
                    p2pSent.clear()
                    flushUnsynced()
                }
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
                        peerKeySource = null,
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

    private fun startSubscriptions() {
        unsubs += repository.subscribeLatestMessages(
            conversationId,
            onPage = { incoming, pageCursor ->
                cursor = pageCursor
                cloudOk = true
                _state.update {
                    it.copy(
                        cloudConnected = true,
                        lastSyncAt = System.currentTimeMillis(),
                        hasOlder = incoming.size >= 100,
                    )
                }
                scope.launch { mergeCloudMessages(incoming) }
                updateConnection()
            },
            onError = { error -> handleCloudError(error) },
        )
        unsubs += repository.subscribeProfile(
            uid,
            onChange = { profile -> _state.update { it.copy(selfProfile = profile) } },
            onError = { },
        )
        unsubs += repository.subscribeProfile(
            peerUid,
            onChange = { profile -> _state.update { it.copy(peerProfile = profile) } },
            onError = { },
        )
        unsubs += repository.subscribePeerReadState(
            conversationId,
            peerUid,
            onChange = { messageId ->
                if (messageId != null) scope.launch { applyPeerReadThrough(messageId) }
            },
            onError = { },
        )
        unsubs += repository.subscribeSignals(
            conversationId,
            uid,
            onSignal = { signal -> scope.launch { handleSignal(signal) } },
            onError = { error -> handleCloudError(error) },
        )
    }

    private fun handleCloudError(error: Exception) {
        cloudOk = false
        updateConnection()
        val text = error.message.orEmpty().lowercase()
        if (text.contains("permission")) {
            _state.update {
                it.copy(
                    error = "Firestore denied access. This account is not one of the two " +
                        "approved members, or setup is incomplete.",
                )
            }
        } else {
            _state.update {
                it.copy(
                    notice = "Cloud unavailable. Direct delivery and local queueing remain active.",
                )
            }
        }
    }

    private suspend fun mergeCloudMessages(cloudMessages: List<ChatMessage>) {
        val changed = mutableListOf<ChatMessage>()
        val newlyReceived = mutableListOf<ChatMessage>()
        for (cloud in cloudMessages) {
            val existing = messages[cloud.messageId]
            if (existing != null) {
                val merged = if (cloud.senderId == uid) {
                    val state = when (existing.deliveryState) {
                        DeliveryState.READ -> DeliveryState.READ
                        DeliveryState.DELIVERED -> DeliveryState.DELIVERED
                        else -> DeliveryState.SENT
                    }
                    cloud.copy(
                        deliveryState = state,
                        syncedToCloud = true,
                        readAt = existing.readAt,
                    )
                } else {
                    cloud.copy(
                        deliveryState = highestDelivery(existing.deliveryState, cloud.deliveryState),
                        syncedToCloud = true,
                        readAt = existing.readAt,
                    )
                }
                messages[merged.messageId] = merged
                changed += merged
            } else {
                messages[cloud.messageId] = cloud
                changed += cloud
                if (cloud.senderId != uid && cloud.messageId !in knownIds) {
                    newlyReceived += cloud
                }
            }
            knownIds += cloud.messageId
            if (cloud.senderId == uid) {
                outbox.remove(cloud.messageId)
                runCatching { store.removeOutbox(cloud.messageId) }
            }
        }
        for (message in changed) runCatching { store.putMessage(message) }
        emitMessages()
        for (message in newlyReceived) onNotify(message)
        if (newlyReceived.isNotEmpty() && visible) markRead()
    }

    private suspend fun applyPeerReadThrough(messageId: String) {
        val ordered = sortedMessages()
        val index = ordered.indexOfFirst { it.messageId == messageId }
        if (index < 0) return
        var changed = false
        val now = System.currentTimeMillis()
        for (i in 0..index) {
            val message = ordered[i]
            if (message.senderId != uid) continue
            if (message.deliveryState == DeliveryState.READ) continue
            val updated = message.copy(deliveryState = DeliveryState.READ, readAt = message.readAt ?: now)
            messages[updated.messageId] = updated
            store.updateMessage(updated.messageId, deliveryState = DeliveryState.READ, readAt = updated.readAt, setReadAt = true)
            changed = true
        }
        if (changed) emitMessages()
    }

    private suspend fun deliver(messageId: String) {
        val message = messages[messageId] ?: return
        if (message.senderId != uid || message.syncedToCloud) return
        var changed = false
        var sentDirect = false

        if (peer?.isReady == true && messageId !in p2pSent) {
            val frame = JSONObject()
                .put("v", 1)
                .put("kind", "message")
                .put("messageId", message.messageId)
                .put("clientMessageId", message.clientMessageId)
                .put("senderId", message.senderId)
                .put("text", message.text)
                .put("clientCreatedAt", message.clientCreatedAt)
            if (peer?.sendJson(frame) == true) {
                sentDirect = true
                p2pSent += messageId
                val updated = message.copy(
                    transport = TransportKind.P2P,
                    deliveryState = if (
                        message.deliveryState == DeliveryState.READ ||
                        message.deliveryState == DeliveryState.DELIVERED
                    ) {
                        message.deliveryState
                    } else {
                        DeliveryState.SENT
                    },
                )
                messages[messageId] = updated
                store.updateMessage(
                    messageId,
                    deliveryState = updated.deliveryState,
                    transport = TransportKind.P2P,
                )
                outbox[messageId]?.let { row ->
                    val now = System.currentTimeMillis()
                    outbox[messageId] = row.copy(
                        deliveryState = updated.deliveryState,
                        lastAttemptAt = now,
                    )
                    store.updateOutboxDelivery(messageId, updated.deliveryState, now)
                }
                changed = true
            }
        }

        if (messageMode == MessageMode.DIRECT) {
            if (changed) {
                emitMessages()
                updateConnection()
            }
            return
        }

        if (allowsCloudWrites(messageMode) && cloudOk && messageId !in cloudInFlight) {
            cloudInFlight += messageId
            try {
                repository.writeMessage(conversationId, message)
                val current = messages[messageId] ?: message
                val synced = current.copy(
                    syncedToCloud = true,
                    deliveryState = if (
                        current.deliveryState == DeliveryState.QUEUED ||
                        current.deliveryState == DeliveryState.FAILED
                    ) {
                        DeliveryState.SENT
                    } else {
                        current.deliveryState
                    },
                )
                messages[messageId] = synced
                store.putMessage(synced)
                store.removeOutbox(messageId)
                outbox.remove(messageId)
                changed = true
            } catch (error: Exception) {
                val row = outbox[messageId]
                if (row != null) {
                    val attempts = row.attemptCount + 1
                    val now = System.currentTimeMillis()
                    val newState = if (!sentDirect && attempts >= 5) {
                        DeliveryState.FAILED
                    } else {
                        row.deliveryState
                    }
                    outbox[messageId] = row.copy(
                        attemptCount = attempts,
                        lastAttemptAt = now,
                        lastError = error.message,
                        deliveryState = newState,
                    )
                    store.recordOutboxAttempt(
                        messageId,
                        attempts,
                        now,
                        newState,
                        error.message,
                    )
                    if (!sentDirect && attempts >= 5) {
                        val current = messages[messageId] ?: message
                        messages[messageId] = current.copy(deliveryState = DeliveryState.FAILED)
                        store.updateMessage(messageId, deliveryState = DeliveryState.FAILED)
                    }
                }
                if (error.message.orEmpty().lowercase().contains("permission")) {
                    _state.update {
                        it.copy(
                            error = "The cloud rejected this message. Check the two-user " +
                                "allowlist and security rules.",
                        )
                    }
                } else {
                    cloudOk = false
                }
                changed = true
            } finally {
                cloudInFlight -= messageId
            }
        }

        if (changed) {
            emitMessages()
            updateConnection()
        }
    }

    private suspend fun drainOutbox() {
        if (draining) return
        draining = true
        try {
            val rows = store.loadOutbox()
            outbox.clear()
            rows.forEach { outbox[it.messageId] = it }
            val now = System.currentTimeMillis()
            for (row in rows) {
                if (!shouldAttempt(row, now)) continue
                if (!canAttemptDelivery(messageMode, cloudOk, peer?.isReady == true)) continue
                deliver(row.messageId)
            }
            emitMessages()
        } catch (_: Exception) {
            // The outbox retries on the next tick.
        } finally {
            draining = false
        }
    }

    private fun flushUnsynced() {
        for (message in messages.values) {
            if (message.senderId == uid && !message.syncedToCloud) {
                scope.launch { deliver(message.messageId) }
            }
        }
    }

    private fun startTicking() {
        tickJob?.cancel()
        tickJob = scope.launch {
            while (!stopped) {
                delay(TICK_MS)
                tick()
            }
        }
    }

    private suspend fun tick() {
        if (stopped) return
        drainOutbox()
        if (identity != null && System.currentTimeMillis() - lastPresenceAt > PRESENCE_INTERVAL_MS) {
            touchPresence()
        }
        maybeStartAutomaticOffer()
        updateConnection()
    }

    private suspend fun touchPresence() {
        lastPresenceAt = System.currentTimeMillis()
        repository.touchLastSeen(uid)
    }

    private fun scheduleHealthCheck(delayMs: Long) {
        healthJob?.cancel()
        healthJob = scope.launch {
            delay(delayMs)
            if (stopped) return@launch
            val ok = repository.checkCloud()
            val wasOk = cloudOk
            cloudOk = ok
            if (ok) {
                _state.update { it.copy(lastSyncAt = System.currentTimeMillis()) }
                if (!wasOk) {
                    requeueFailedMessages()
                    p2pSent.clear()
                    drainOutbox()
                    _state.update {
                        it.copy(
                            notice = if (messageMode == MessageMode.DIRECT) {
                                "Cloud signaling restored. Direct messages remain on this device."
                            } else {
                                "Cloud synchronization restored. Reconciling queued messages."
                            },
                        )
                    }
                }
            } else if (wasOk) {
                _state.update {
                    it.copy(
                        notice = "Cloud unavailable. Existing direct connections and the local " +
                            "queue are still available.",
                    )
                }
            }
            updateConnection()
            scheduleHealthCheck(if (ok) HEALTH_CONNECTED_MS else HEALTH_OFFLINE_MS)
        }
    }

    private fun updateConnection() {
        val p2pReady = peer?.isReady == true
        val mode = deriveConnectionMode(
            cloudConnected = cloudOk,
            p2pConnected = p2pReady,
            connecting = _state.value.p2pState == P2PState.CONNECTING,
            reconnecting = !cloudOk && _state.value.p2pState == P2PState.IDLE,
            failed = !cloudOk && _state.value.p2pState == P2PState.FAILED,
        )
        _state.update {
            it.copy(
                connectionMode = mode,
                cloudConnected = cloudOk,
                queuedCount = outbox.size,
            )
        }
    }

    private suspend fun markRead() {
        val ordered = sortedMessages()
        val last = ordered.lastOrNull() ?: return
        var changed = false
        val now = System.currentTimeMillis()
        for (message in ordered) {
            if (message.senderId == uid) continue
            if (message.readAt == null) {
                val updated = message.copy(readAt = now)
                messages[updated.messageId] = updated
                store.updateMessage(updated.messageId, readAt = now, setReadAt = true)
                changed = true
            }
        }
        if (changed) emitMessages()
        if (lastReadWritten != last.messageId) {
            lastReadWritten = last.messageId
            if (allowsCloudWrites(messageMode) && cloudOk) {
                runCatching {
                    repository.writeReadState(conversationId, uid, last.messageId)
                }
            }
            peer?.sendJson(
                JSONObject()
                    .put("v", 1)
                    .put("kind", "read")
                    .put("lastReadMessageId", last.messageId)
                    .put("at", now),
            )
        }
    }

    private fun isInitiator(): Boolean = uid < peerUid

    private suspend fun maybeStartAutomaticOffer() {
        if (
            !isInitiator() ||
            !cloudOk ||
            manualMode ||
            peer?.isReady == true ||
            _state.value.p2pState == P2PState.CONNECTING ||
            System.currentTimeMillis() - lastOfferAt < OFFER_INTERVAL_MS
        ) {
            return
        }
        lastOfferAt = System.currentTimeMillis()
        val session = peer ?: return
        val currentIdentity = identity ?: return
        try {
            val sdp = session.createOffer(PeerSession.Origin.AUTO)
            repository.sendSignal(
                conversationId = conversationId,
                from = uid,
                to = peerUid,
                fromDeviceId = currentIdentity.deviceId,
                kind = "offer",
                sdp = sdp,
            )
            offerJob?.cancel()
            offerJob = scope.launch {
                delay(25_000)
                if (!session.isAuthenticated) {
                    if (peer === session) {
                        session.close()
                    }
                    _state.update { it.copy(p2pState = P2PState.FAILED) }
                    updateConnection()
                }
            }
        } catch (error: Exception) {
            session.close()
            _state.update {
                it.copy(
                    p2pState = P2PState.FAILED,
                    notice = "Direct connection offer failed: ${error.message}",
                )
            }
            updateConnection()
        }
    }

    private suspend fun handleSignal(signal: IncomingSignal) {
        if (signal.from != peerUid) {
            runCatching { repository.deleteSignals(conversationId, listOf(signal.id)) }
            return
        }
        if (manualMode) {
            runCatching { repository.deleteSignals(conversationId, listOf(signal.id)) }
            return
        }
        val session = peer ?: return
        val currentIdentity = identity ?: return
        try {
            if (signal.kind == "offer" && !isInitiator()) {
                if (session.isReady) return
                val answer = session.acceptOffer(PeerSession.Origin.AUTO, signal.sdp)
                repository.sendSignal(
                    conversationId = conversationId,
                    from = uid,
                    to = peerUid,
                    fromDeviceId = currentIdentity.deviceId,
                    kind = "answer",
                    sdp = answer,
                )
            } else if (signal.kind == "answer" && isInitiator()) {
                session.applyAnswer(signal.sdp)
            }
        } catch (error: Exception) {
            _state.update {
                it.copy(
                    p2pState = P2PState.FAILED,
                    notice = "Signaling failed: ${error.message}",
                )
            }
            updateConnection()
        } finally {
            runCatching { repository.deleteSignals(conversationId, listOf(signal.id)) }
        }
    }

    private suspend fun handlePeerMessage(message: ChatMessage) {
        if (message.senderId != peerUid) return
        val existing = messages[message.messageId]
        val merged = if (existing != null) {
            mergePeer(existing, message)
        } else {
            message
        }
        messages[merged.messageId] = merged
        knownIds += merged.messageId
        store.putMessage(merged)
        emitMessages()
        peer?.sendJson(
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
        val next = when {
            state == DeliveryState.READ -> DeliveryState.READ
            message.deliveryState == DeliveryState.READ -> DeliveryState.READ
            else -> DeliveryState.DELIVERED
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
        if (messageMode == MessageMode.DIRECT && updated.deliveryState != DeliveryState.FAILED) {
            outbox.remove(messageId)
            store.removeOutbox(messageId)
        }
        emitMessages()
    }

    private suspend fun resolvePeerKey(deviceId: String): ResolvedPeerKey? {
        val cloud = try {
            repository.fetchPeerDeviceKey(peerUid, deviceId)
        } catch (_: Exception) {
            null
        }
        if (cloud != null) {
            identityManager.cachePeerKey(peerUid, deviceId, cloud)
            return ResolvedPeerKey(cloud, "cloud")
        }
        val cached = identityManager.cachedPeerKey(peerUid, deviceId) ?: return null
        return ResolvedPeerKey(cached, "cache")
    }

    private fun mergePeer(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
        val base = if (incoming.syncedToCloud && !existing.syncedToCloud) incoming else existing
        val other = if (base === existing) incoming else existing
        return base.copy(
            deliveryState = highestDelivery(existing.deliveryState, incoming.deliveryState),
            syncedToCloud = existing.syncedToCloud || incoming.syncedToCloud,
            serverCreatedAt = base.serverCreatedAt ?: other.serverCreatedAt,
            readAt = existing.readAt ?: incoming.readAt,
        )
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
            DeliveryState.FAILED to 0,
        )
        return if ((rank[first] ?: 0) >= (rank[second] ?: 0)) first else second
    }

    private fun shouldAttempt(row: OutboxRow, now: Long): Boolean {
        if (row.deliveryState == DeliveryState.FAILED) return false
        val last = row.lastAttemptAt ?: return true
        return now - last >= retryDelayMs(row.attemptCount)
    }

    private fun retryDelayMs(attemptCount: Int): Long {
        val bounded = maxOf(0, min(attemptCount, 6))
        return min(30_000L, (2_000.0 * 2.0.pow(bounded)).toLong())
    }

    private fun sortedMessages(): List<ChatMessage> =
        messages.values.sortedWith { first, second -> compareMessages(first, second) }

    private fun emitMessages() {
        _state.update {
            it.copy(
                messages = sortedMessages(),
                queuedCount = outbox.size,
            )
        }
    }

    private fun randomNonce(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private companion object {
        const val TICK_MS = 4_000L
        const val HEALTH_CONNECTED_MS = 20_000L
        const val HEALTH_OFFLINE_MS = 8_000L
        const val OFFER_INTERVAL_MS = 20_000L
        const val PRESENCE_INTERVAL_MS = 120_000L
    }
}
