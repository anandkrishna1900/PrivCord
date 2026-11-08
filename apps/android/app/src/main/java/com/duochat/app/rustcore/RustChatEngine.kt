package com.duochat.app.rustcore

import android.app.Application
import com.duochat.app.data.ActiveInvite
import com.duochat.app.data.AnswerState
import com.duochat.app.data.BluetoothStatus
import com.duochat.app.data.ChannelView
import com.duochat.app.data.ChatMessage
import com.duochat.app.data.ChatState
import com.duochat.app.data.ChatSummary
import com.duochat.app.data.ConnectionPath
import com.duochat.app.data.ContactTrust
import com.duochat.app.data.ContactView
import com.duochat.app.data.DeliveryState
import com.duochat.app.data.EnginePhase
import com.duochat.app.data.FileMeta
import com.duochat.app.data.GroupView
import com.duochat.app.data.InviteAnswer
import com.duochat.app.data.InviteRequest
import com.duochat.app.data.LinkStatus
import com.duochat.app.data.MemberView
import com.duochat.app.data.MessageType
import com.duochat.app.data.NetworkConfig
import com.duochat.app.data.ReplyRef
import com.duochat.app.data.filePreviewText
import com.duochat.app.engine.ChatEngine
import com.duochat.app.engine.ChatEngineApi
import com.duochat.app.engine.IncomingNotice
import com.duochat.app.p2p.WebRtcTransport
import com.duochat.app.p2p.iceServers
import com.duochat.app.security.Seal
import com.duochat.app.signaling.SignalingHub
import com.duochat.app.signaling.SignalingStatus
import com.duochat.app.signaling.transportsFor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.privcord_ffi.AnswerState as FfiAnswerState
import uniffi.privcord_ffi.Delivery
import uniffi.privcord_ffi.EventDto
import uniffi.privcord_ffi.LinkKind
import uniffi.privcord_ffi.LinkState
import uniffi.privcord_ffi.NotifierCallbacks
import uniffi.privcord_ffi.PathKind
import uniffi.privcord_ffi.PrivcordEngine
import uniffi.privcord_ffi.SignalKind
import uniffi.privcord_ffi.SignalKindDto
import uniffi.privcord_ffi.SnapshotDto
import uniffi.privcord_ffi.TransportCallbacks
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * The chat engine for the "rust" build flavor: every rule (identity, contacts, delivery, groups, files, channels,
 * backup, wipe) comes from the shared Rust engine. This class only
 *  * maps the engine's snapshot onto the screens' [ChatState],
 *  * carries out what the engine asks of the platform: WebRTC data channels for dialing ([links]) and the relay / Nostr
 *    sockets for signaling ([hub]),
 *  * turns screen actions into engine calls.
 *
 * Not in this build yet (they say so on screen instead of failing silently): Bluetooth links, the Bluetooth mesh and the
 * manual connection codes.
 */
class RustChatEngine(
    private val app: Application,
    private val scope: CoroutineScope,
    private val conversationId: String,
    private val networkConfig: () -> NetworkConfig,
    private val ownName: () -> String,
    private val isMuted: (String) -> Boolean,
    private val onNotify: (IncomingNotice) -> Unit,
    initialGroupOnly: Boolean,
) : ChatEngineApi {
    private val _state = MutableStateFlow(ChatState(groupOnly = initialGroupOnly))
    override val state: StateFlow<ChatState> = _state.asStateFlow()

    private var engine: PrivcordEngine? = null
    private var stopped = false
    private var visible = false
    private var openChat: String? = null
    private var pump: Thread? = null
    private var refreshJob: Job? = null
    private val refreshRequests = Channel<Unit>(Channel.CONFLATED)
    private var last: SnapshotDto? = null
    private var notice: String? = null
    private var groupOnly = initialGroupOnly
    private val secure = KeystoreSecureStore(app, "main")

    // ------------------------------------------------------------------ platform side: links and signaling

    private val links = ConcurrentHashMap<String, WebRtcTransport>()
    private val dialStartedAt = ConcurrentHashMap<String, Long>()
    private var hub: SignalingHub? = null
    private var hubMailbox: String? = null

    private val transport = object : TransportCallbacks {
        override fun send(peer: String, frame: String): Boolean = links[peer]?.sendJson(frame) == true

        override fun sendRaw(link: String, frame: String): Boolean = false // the Bluetooth mesh is not in this build yet

        override fun close(peer: String) {
            links.remove(peer)?.close()
        }

        override fun signalAvailable(): Boolean = networkConfig().signaling.isNotEmpty()

        override fun signalSubscribe(mailbox: String): Boolean {
            if (networkConfig().signaling.isEmpty()) return false
            hub?.stop()
            val created = SignalingHub(transportsFor(networkConfig(), scope))
            hub = created
            hubMailbox = mailbox
            created.start(mailbox) { blob, id, via ->
                scope.launch {
                    withContext(Dispatchers.IO) { runCatching { engine?.signalBlob(mailbox, Seal.encode(blob)) } }
                    runCatching { created.remove(via, mailbox, id) }
                    requestRefresh()
                }
            }
            return true
        }

        override fun signalUnsubscribe(mailbox: String) {
            if (hubMailbox == mailbox) {
                hub?.stop()
                hub = null
                hubMailbox = null
            }
        }

        override fun signalPut(mailbox: String, blob: String, kind: SignalKind, ttlSec: UInt): Boolean {
            val current = hub ?: SignalingHub(transportsFor(networkConfig(), scope)).also { hub = it }
            val decoded = Seal.decode(blob) ?: return false
            val wire = if (kind == SignalKind.LIVE) "sig" else "msg"
            scope.launch {
                runCatching { current.put(mailbox, decoded, wire, ttlSec.toInt()) }
                requestRefresh()
            }
            return true
        }
    }

    private val notifier = object : NotifierCallbacks {
        override fun messageReceived(conversation: String, sender: String, preview: String) {}
    }

    // ------------------------------------------------------------------ lifecycle

    override suspend fun start() {
        try {
            val started = withContext(Dispatchers.IO) {
                PrivcordEngine.start(File(app.noBackupFilesDir, "privcord.db").path, conversationId, secure, transport, notifier)
            }
            engine = started
            applyOwnName()
            val snapshot = withContext(Dispatchers.IO) { started.snapshot() }
            last = snapshot
            if (snapshot.ownUid == null) {
                _state.update { it.copy(phase = EnginePhase.NEEDS_IDENTITY) }
            } else {
                _state.update { it.copy(phase = EnginePhase.READY, uid = snapshot.ownUid!!) }
                publish(snapshot)
            }
            startPump(started)
            refreshJob = scope.launch {
                for (signal in refreshRequests) {
                    delay(60) // coalesce bursts
                    refreshNow()
                }
            }
            runCatching { withContext(Dispatchers.IO) { started.setGroupOnly(groupOnly) } }
            requestRefresh()
        } catch (error: Throwable) {
            if (!stopped) _state.update { it.copy(phase = EnginePhase.ERROR, error = error.message ?: "Startup failed.") }
        }
    }

    /** First run: derive the identity from the recovery phrase in the engine (the Keystore keeps its keys). */
    suspend fun recoverIdentity(phrase: String, passphrase: String): Result<Unit> = runCatching {
        // The engine starts in the background; wait for it (a few seconds at most).
        var waited = 0
        while (engine == null && waited < 100) { delay(100); waited += 1 }
        val e = engine ?: throw IllegalStateException("The engine is not ready yet.")
        try {
            withContext(Dispatchers.IO) { e.recoverIdentity(phrase, passphrase) }
        } catch (t: uniffi.privcord_ffi.FfiException) {
            throw IllegalStateException(friendly(t))
        }
    }

    override fun stop() {
        stopped = true
        refreshJob?.cancel()
        refreshRequests.close()
        for (t in links.values) runCatching { t.close() }
        links.clear()
        hub?.stop()
        hub = null
        val e = engine
        engine = null
        Thread {
            runCatching { e?.shutdown() }
            runCatching { e?.close() }
        }.start()
        _state.update { it.copy(phase = EnginePhase.STOPPED) }
    }

    private fun startPump(e: PrivcordEngine) {
        pump = Thread {
            while (!stopped) {
                val event = runCatching { e.nextEvent(500u) }.getOrNull() ?: continue
                if (stopped) break
                scope.launch { onEvent(event) }
            }
        }.apply { isDaemon = true; name = "rust-engine-events"; start() }
    }

    private fun requestRefresh() {
        refreshRequests.trySend(Unit)
    }

    private suspend fun refreshNow() {
        val e = engine ?: return
        val snapshot = runCatching { withContext(Dispatchers.IO) { e.snapshot() } }.getOrNull() ?: return
        last = snapshot
        if (snapshot.ownUid != null) {
            _state.update { it.copy(phase = EnginePhase.READY, uid = snapshot.ownUid!!) }
            publish(snapshot)
        }
    }

    // ------------------------------------------------------------------ events from the engine

    private suspend fun onEvent(event: EventDto) {
        when (event) {
            is EventDto.DialRequested -> dial(event.peer, event.initiator)
            is EventDto.SignalReceived -> onSignal(event.peer, event.kind, event.sdp)
            is EventDto.MessageAdded -> {
                if (!event.own) notifyIncoming(event.conversation, event.messageId)
                requestRefresh()
            }
            is EventDto.PeerStateChanged -> requestRefresh()
            else -> requestRefresh()
        }
    }

    private fun notifyIncoming(conversation: String, messageId: String) {
        if (visible && openChat == conversation) return
        if (isMuted(conversation)) return
        scope.launch {
            val snapshot = last ?: return@launch
            val message = snapshot.conversations.firstOrNull { it.id == conversation }?.messages?.firstOrNull { it.id == messageId }
            val title = snapshot.contacts.firstOrNull { it.uid == conversation }?.displayName
                ?: snapshot.groups.firstOrNull { it.id == conversation }?.name ?: "New message"
            val body = message?.let { if (it.isFile) filePreviewText(it.text) else it.text } ?: "New message"
            onNotify(IncomingNotice(messageId, conversation, title, body))
        }
    }

    // ------------------------------------------------------------------ WebRTC links (platform adapter)

    private fun isInitiator(peer: String): Boolean = (last?.ownUid ?: "") < peer

    private suspend fun dial(peer: String, initiator: Boolean) {
        val now = System.currentTimeMillis()
        if (now - (dialStartedAt[peer] ?: 0L) < OFFER_TIMEOUT_MS && links[peer] != null) return
        dialStartedAt[peer] = now
        if (initiator) {
            offer(peer)
        } else {
            // The other side offers; tell them we are here.
            io { engine?.sendSignal(peer, SignalKindDto.READY, null) }
        }
    }

    private fun newTransport(peer: String): WebRtcTransport {
        links.remove(peer)?.close()
        val created = WebRtcTransport(
            networkConfig().iceServers(), networkConfig().forceRelay,
            object : WebRtcTransport.Handlers {
                override fun onOpen() {
                    scope.launch {
                        val current = links[peer] ?: return@launch
                        val path = runCatching { current.connectionPath() }.getOrNull()
                        io { engine?.linkUp(peer, path.toKind(), LinkKind.ENCRYPTED) }
                        requestRefresh()
                    }
                }

                override fun onClose() {
                    scope.launch {
                        io { runCatching { engine?.linkDown(peer) } }
                        requestRefresh()
                    }
                }

                override fun onFrame(data: String) {
                    scope.launch { io { runCatching { engine?.frameReceived(peer, data) } } }
                }

                override fun onError(message: String) {
                    scope.launch { requestRefresh() }
                }
            },
        )
        links[peer] = created
        return created
    }

    private suspend fun offer(peer: String) {
        val t = newTransport(peer)
        val sdp = runCatching { t.createOffer() }.getOrNull() ?: return
        io { engine?.sendSignal(peer, SignalKindDto.OFFER, sdp) }
    }

    private suspend fun onSignal(peer: String, kind: SignalKindDto, sdp: String?) {
        when (kind) {
            SignalKindDto.READY -> if (isInitiator(peer)) offer(peer)
            SignalKindDto.OFFER -> {
                if (sdp == null) return
                val t = newTransport(peer)
                val answer = runCatching { t.acceptOffer(sdp) }.getOrNull() ?: return
                io { engine?.sendSignal(peer, SignalKindDto.ANSWER, answer) }
            }
            SignalKindDto.ANSWER -> {
                if (sdp == null) return
                runCatching { links[peer]?.applyAnswer(sdp) }
            }
        }
    }

    private fun ConnectionPath?.toKind(): PathKind = when (this) {
        ConnectionPath.DIRECT_LAN -> PathKind.DIRECT_LAN
        ConnectionPath.DIRECT_P2P -> PathKind.DIRECT_NAT
        ConnectionPath.RELAYED -> PathKind.RELAYED
        ConnectionPath.BLUETOOTH -> PathKind.BLUETOOTH
        null -> PathKind.UNKNOWN
    }

    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }

    // ------------------------------------------------------------------ snapshot -> screens

    private fun nameOf(snapshot: SnapshotDto, uid: String): String =
        snapshot.contacts.firstOrNull { it.uid == uid }?.displayName ?: "Friend ${uid.take(4)}"

    private fun linkOf(state: LinkState): LinkStatus = when (state) {
        is LinkState.Connected -> LinkStatus.CONNECTED
        is LinkState.Connecting, is LinkState.Reconnecting -> LinkStatus.CONNECTING
        else -> LinkStatus.OFFLINE
    }

    private fun pathOf(state: LinkState): ConnectionPath? = (state as? LinkState.Connected)?.path?.let {
        when (it) {
            PathKind.DIRECT_LAN -> ConnectionPath.DIRECT_LAN
            PathKind.DIRECT_NAT -> ConnectionPath.DIRECT_P2P
            PathKind.RELAYED -> ConnectionPath.RELAYED
            PathKind.BLUETOOTH -> ConnectionPath.BLUETOOTH
            PathKind.UNKNOWN -> null
        }
    }

    private fun deliveryOf(d: Delivery): DeliveryState = when (d) {
        Delivery.QUEUED -> DeliveryState.QUEUED
        Delivery.SENT -> DeliveryState.SENT
        Delivery.DELIVERED -> DeliveryState.DELIVERED
        Delivery.READ -> DeliveryState.READ
        Delivery.FAILED -> DeliveryState.FAILED
    }

    private fun publish(s: SnapshotDto) {
        val self = s.ownUid ?: return
        val contacts = s.contacts.sortedBy { it.displayName.lowercase() }.map { c ->
            ContactView(
                c.uid, c.displayName, if (c.verified) ContactTrust.VERIFIED else ContactTrust.INTRODUCED,
                c.introducedBy?.let { nameOf(s, it) }, c.checked, linkOf(c.link), pathOf(c.link), c.safetyNumber,
                direct = c.canMessage,
            )
        }
        val groups = s.groups.map { g ->
            val members = g.members.map { m ->
                val contact = s.contacts.firstOrNull { it.uid == m.uid }
                MemberView(
                    m.uid, if (m.uid == self) "You" else nameOf(s, m.uid), m.uid == self, m.admin, null,
                    contact?.let { if (it.verified) ContactTrust.VERIFIED else ContactTrust.INTRODUCED },
                    if (m.uid == self) null else contact?.let { linkOf(it.link) },
                    canMessage = m.uid != self && (contact?.canMessage == true),
                )
            }.sortedWith(compareBy({ !it.isMe }, { !it.isAdmin }, { it.name.lowercase() }))
            val iAmMember = g.members.any { it.uid == self }
            GroupView(
                g.id, g.name, members, iAmMember, g.amAdmin, if (iAmMember) null else "You left",
                g.connected.toInt(), full = g.full, maxMembers = g.maxMembers.toInt(),
            )
        }.sortedBy { it.name.lowercase() }

        val shaped = HashMap<String, List<ChatMessage>>()
        for (conv in s.conversations) {
            val mapped = conv.messages.mapIndexed { index, m ->
                val replied = m.replyTo?.let { rid -> conv.messages.firstOrNull { it.id == rid } }
                val unreadFrom = conv.messages.size - conv.unread.toInt()
                val reactions = LinkedHashMap<String, String>()
                for (chip in m.reactions) {
                    if (chip.mine) reactions[self] = chip.emoji
                    val others = chip.count.toInt() - if (chip.mine) 1 else 0
                    for (i in 0 until others) reactions["r:${chip.emoji}:$i"] = chip.emoji
                }
                ChatMessage(
                    messageId = m.id, clientMessageId = m.id, senderId = m.sender, text = m.text,
                    clientCreatedAt = m.createdAt, deliveryState = deliveryOf(m.delivery),
                    readAt = if (m.sender == self || index < unreadFrom) 1L else null,
                    conversationId = conv.id, totalRecipients = m.total.toInt(),
                    deliveredTo = (m.total.toInt() - m.pending.toInt()).coerceAtLeast(0),
                    type = if (m.isFile) MessageType.FILE else MessageType.TEXT,
                    replyTo = m.replyTo?.let { ReplyRef(it, replied?.let { r -> nameOf(s, r.sender) } ?: "", replied?.text.orEmpty()) },
                    file = if (m.isFile) FileMeta(m.text, "", 0, "") else null,
                    senderName = if (conv.id.startsWith("chan:")) nameOf(s, m.sender) else null,
                    deleted = m.deleted, reactions = reactions,
                )
            }
            shaped[conv.id] = mapped
        }

        val summaries = ArrayList<ChatSummary>()
        for (c in contacts.filter { it.direct }) {
            val conv = s.conversations.firstOrNull { it.id == c.uid }
            summaries += ChatSummary(
                c.uid, false, c.name, conv?.last?.text, conv?.last?.at ?: 0L, conv?.unread?.toInt() ?: 0, c.link,
                when (c.link) {
                    LinkStatus.CONNECTED -> "Connected"
                    LinkStatus.CONNECTING -> "Connecting…"
                    LinkStatus.OFFLINE -> "Waiting for ${c.name}"
                },
            )
        }
        for (g in groups) {
            val conv = s.conversations.firstOrNull { it.id == g.groupId }
            val others = g.members.count { !it.isMe }
            summaries += ChatSummary(
                g.groupId, true, g.name,
                conv?.last?.let { (if (it.own) "You" else nameOf(s, it.sender)) + ": " + it.text },
                conv?.last?.at ?: 0L, conv?.unread?.toInt() ?: 0,
                if (g.connectedCount > 0) LinkStatus.CONNECTED else LinkStatus.OFFLINE,
                g.exitNote ?: "${g.members.size} members" + if (others > 0) " · ${g.connectedCount} connected" else "",
            )
        }
        val online = hub?.status() == SignalingStatus.ONLINE
        for (name in s.channels) {
            val id = "chan:$name"
            val conv = s.conversations.firstOrNull { it.id == id }
            summaries += ChatSummary(
                id, true, "# $name", conv?.last?.let { nameOf(s, it.sender) + ": " + it.text }, conv?.last?.at ?: 0L,
                conv?.unread?.toInt() ?: 0, if (online) LinkStatus.CONNECTED else LinkStatus.OFFLINE, "Public channel",
            )
        }
        summaries.sortByDescending { it.lastAt }

        _state.update {
            it.copy(
                contacts = contacts, groups = groups, chats = summaries, messages = shaped,
                queuedCount = s.queued.toInt(), groupOnly = groupOnly,
                channels = s.channels.map { name ->
                    ChannelView("chan:$name", name, s.conversations.firstOrNull { c -> c.id == "chan:$name" }?.unread?.toInt() ?: 0, online)
                },
                invite = s.invite?.let { inv -> ActiveInvite(inv.words, inv.expiresAt) },
                requests = s.requests.map { r -> InviteRequest(r.uid, r.name, r.safetyNumber) },
                answer = s.answer?.let { a ->
                    InviteAnswer(
                        a.uid, nameOf(s, a.uid),
                        if (a.status == FfiAnswerState.SENT) AnswerState.SENT else AnswerState.FAILED,
                        if (a.status == FfiAnswerState.SENT) null else "Could not reach them.",
                    )
                },
                linkCount = s.contacts.count { c -> c.link is LinkState.Connected },
                signaling = hub?.status() ?: SignalingStatus.IDLE,
                bluetooth = BluetoothStatus.UNSUPPORTED,
                notice = notice ?: it.notice,
            )
        }
    }

    // ------------------------------------------------------------------ screen actions

    private suspend fun <T> call(block: PrivcordEngine.() -> T): Result<T> = runCatching {
        val e = engine ?: throw IllegalStateException("Chat is not ready yet.")
        try {
            withContext(Dispatchers.IO) { e.block() }
        } catch (t: uniffi.privcord_ffi.FfiException) {
            throw IllegalStateException(friendly(t))
        }
    }.also { requestRefresh() }

    private fun friendly(t: uniffi.privcord_ffi.FfiException): String = when (t) {
        is uniffi.privcord_ffi.FfiException.EmptyMessage -> "Write something first."
        is uniffi.privcord_ffi.FfiException.MessageTooLong -> "That message is too long."
        is uniffi.privcord_ffi.FfiException.DirectNotAllowed -> "Direct messages with this person are off (group-only)."
        is uniffi.privcord_ffi.FfiException.InvalidCard -> "That is not a valid invite. Check the words, or ask your friend to share it again."
        is uniffi.privcord_ffi.FfiException.OwnCard -> "That is your own invite. Send it to a friend instead."
        is uniffi.privcord_ffi.FfiException.UnknownContact -> "Unknown friend."
        else -> t.message ?: "That did not work."
    }

    private fun say(text: String) {
        notice = text
        _state.update { it.copy(notice = text) }
    }

    private fun applyOwnName() {
        val name = ownName()
        if (name.isNotBlank()) runCatching { engine?.setDisplayName(name) }
    }

    override fun setVisible(isVisible: Boolean) {
        visible = isVisible
        openChat?.let { id -> if (isVisible) scope.launch { call { markRead(id) } } }
    }

    override fun setOpenChat(conversationId: String?) {
        openChat = conversationId
        if (conversationId != null) scope.launch { call { markRead(conversationId) } }
    }

    override fun clearNotice() {
        notice = null
        _state.update { it.copy(notice = null, error = null) }
    }

    override fun onOwnNameChanged() {
        scope.launch { io { applyOwnName() } }
    }

    override fun ownCard(): String = engine?.ownCard(ownName().ifBlank { null }) ?: ""

    override suspend fun addFriend(text: String): Result<String> = call { acceptInvite(text) }.also {
        if (it.isSuccess) say("Added. Connecting automatically whenever you are both online.")
    }

    override fun retryAnswer() { scope.launch { call { retryAnswer() } } }
    override fun clearAnswer() { scope.launch { call { clearAnswer() } } }

    override suspend fun deleteMessage(messageId: String, everyone: Boolean) { call { deleteMessage(messageId, everyone) } }
    override suspend fun react(messageId: String, emoji: String) { call { react(messageId, emoji) } }

    override fun search(query: String, limit: Int): List<ChatEngine.SearchHit> {
        val e = engine ?: return emptyList()
        val s = last ?: return emptyList()
        return runCatching {
            e.search(query, limit.toUInt()).map { h ->
                ChatEngine.SearchHit(
                    h.messageId, h.conversation,
                    s.contacts.firstOrNull { it.uid == h.conversation }?.displayName
                        ?: s.groups.firstOrNull { it.id == h.conversation }?.name ?: h.conversation,
                    nameOf(s, h.sender), h.text, h.at,
                )
            }
        }.getOrDefault(emptyList())
    }

    override suspend fun exportBackup(passphrase: String): Result<String> = call { exportBackup(passphrase) }

    override suspend fun importBackup(text: String, passphrase: String): Result<String> = call { importBackup(text, passphrase) }.map {
        "Restored ${it.friends} friends, ${it.groups} groups and ${it.messages} messages."
    }

    override suspend fun joinChannel(raw: String, persist: Boolean): Result<String> = call { joinChannel(raw) }
    override fun leaveChannel(conversationId: String) { scope.launch { call { leaveChannel(conversationId.removePrefix("chan:")) } } }
    override fun muteSender(uid: String) { scope.launch { call { setMuted(uid, true) } } }

    override fun setMeshEnabled(on: Boolean) {
        if (on) say("The Bluetooth mesh is not in the Rust build yet.")
    }

    override suspend fun createInvite(): Result<ActiveInvite> = call { createInvite() }.map { ActiveInvite(it.words, it.expiresAt) }
    override suspend fun acceptRequest(uid: String): Result<String> = call { acceptRequest(uid) }
    override fun dismissRequest(uid: String) { scope.launch { call { dismissRequest(uid) } } }

    override suspend fun markChecked(uid: String) { call { setChecked(uid, true) } }

    override suspend fun renameFriend(uid: String, name: String) {
        say("Renaming friends is not in the Rust build yet.")
    }

    override fun removeBlocker(uid: String): String? = null

    override suspend fun removeFriend(uid: String): Result<Unit> = call { removeContact(uid) }

    override fun setGroupOnly(value: Boolean) {
        groupOnly = value
        scope.launch { call { setGroupOnly(value) } }
    }

    override suspend fun createGroup(name: String, memberUids: List<String>): Result<String> = call { createGroup(name, memberUids) }
    override suspend fun addToGroup(groupId: String, uids: List<String>): Result<Unit> = call { uids.forEach { addGroupMember(groupId, it) } }
    override suspend fun removeFromGroup(groupId: String, uid: String): Result<Unit> = call { removeGroupMember(groupId, uid) }
    override suspend fun leaveGroup(groupId: String): Result<Unit> = call { leaveGroup(groupId) }
    override suspend fun renameGroup(groupId: String, name: String): Result<Unit> = call { renameGroup(groupId, name) }

    private fun isGroup(id: String): Boolean = last?.groups?.any { it.id == id } == true

    override suspend fun send(conversationId: String, rawText: String, replyToId: String?): Result<Unit> = call {
        when {
            conversationId.startsWith("chan:") -> sendChannelMessage(conversationId.removePrefix("chan:"), rawText)
            isGroup(conversationId) -> sendGroupMessage(conversationId, rawText, replyToId)
            else -> sendMessage(conversationId, rawText, replyToId)
        }
        Unit
    }

    override suspend fun sendFile(
        conversationId: String, rawName: String, mime: String, bytes: ByteArray, replyToId: String?,
    ): Result<Unit> = call {
        if (isGroup(conversationId)) sendGroupFile(conversationId, rawName, mime, bytes, replyToId)
        else sendFile(conversationId, rawName, mime, bytes, replyToId)
        Unit
    }

    override suspend fun getFile(messageId: String): Pair<FileMeta, ByteArray>? =
        call { loadFile(messageId) }.getOrNull()?.let { FileMeta(it.name, it.mime, it.data.size, "") to it.data }

    override suspend fun retry(messageId: String) { /* the engine resends on its own when the link opens */ }

    override suspend fun clearChat(conversationId: String) { call { wipeConversation(conversationId, false) } }

    override suspend fun clearLocalData() {
        call { wipeEverything() }
        secure.deleteIdentity()
    }

    override fun confirmManual() {}
    override fun reloadNetwork() {
        // Signaling picks up the new settings the next time the engine asks to listen; restart it now.
        val mailbox = hubMailbox ?: return
        transport.signalUnsubscribe(mailbox)
        transport.signalSubscribe(mailbox)
    }

    override fun onNetworkAvailable() {
        val mailbox = hubMailbox ?: return
        transport.signalSubscribe(mailbox)
    }

    override suspend fun createManualOffer(): String = throw UnsupportedOperationException("Manual codes are not in the Rust build yet.")
    override suspend fun applyManualAnswer(code: String) { throw UnsupportedOperationException("Manual codes are not in the Rust build yet.") }
    override suspend fun acceptManualOffer(code: String): String = throw UnsupportedOperationException("Manual codes are not in the Rust build yet.")
    override fun cancelManual() {}
    override fun refreshBluetooth() {}
    override suspend fun connectBluetooth(uid: String, manual: Boolean): Result<Unit> =
        Result.failure(UnsupportedOperationException("Bluetooth is not in the Rust build yet."))

    private companion object {
        const val OFFER_TIMEOUT_MS = 40_000L
    }
}
