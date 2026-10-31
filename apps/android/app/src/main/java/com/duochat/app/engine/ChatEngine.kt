package com.duochat.app.engine

import com.duochat.app.ble.BleAvailability
import com.duochat.app.ble.BleEnvironment
import com.duochat.app.ble.bleReconnectDelayMs
import com.duochat.app.ble.bluetoothStatusFor
import com.duochat.app.data.BluetoothStatus
import com.duochat.app.data.ChatMessage
import com.duochat.app.data.ChatState
import com.duochat.app.data.ChatSummary
import com.duochat.app.data.ContactTrust
import com.duochat.app.data.ContactView
import com.duochat.app.data.ConnectionPath
import com.duochat.app.data.AssembleResult
import com.duochat.app.data.DeclineReason
import com.duochat.app.data.FileAssembler
import com.duochat.app.data.FileChunk
import com.duochat.app.data.FileMeta
import com.duochat.app.data.FileOffer
import com.duochat.app.data.MAX_FILE_BYTES
import com.duochat.app.data.MAX_GROUP_MEMBERS
import com.duochat.app.data.MessageType
import com.duochat.app.data.ReplyRef
import com.duochat.app.data.acceptsDirect
import com.duochat.app.data.canStartDirect
import com.duochat.app.data.declinedFrame
import com.duochat.app.data.fileChunks
import com.duochat.app.data.filePreviewText
import com.duochat.app.data.makeReplyRef
import com.duochat.app.data.parseDeclined
import com.duochat.app.data.sanitizeFileName
import com.duochat.app.data.validateFileSize
import com.duochat.app.data.DeliveryState
import com.duochat.app.data.EnginePhase
import com.duochat.app.data.GroupView
import com.duochat.app.data.LinkStatus
import com.duochat.app.data.MAX_LINKS
import com.duochat.app.data.MAX_TEXT_LENGTH
import com.duochat.app.data.ManualState
import com.duochat.app.data.MemberView
import com.duochat.app.data.MessageStore
import com.duochat.app.data.NetworkConfig
import com.duochat.app.data.OutboxRow
import com.duochat.app.data.P2PState
import com.duochat.app.data.PeerTrust
import com.duochat.app.data.TransportKind
import com.duochat.app.data.compareMessages
import com.duochat.app.data.countCodePoints
import com.duochat.app.data.createOutgoingMessage
import com.duochat.app.data.isValidClientMessageId
import com.duochat.app.data.local.ContactEntity
import com.duochat.app.data.needsDelivery
import com.duochat.app.data.normalizeNewlines
import com.duochat.app.groups.GroupCoordinator
import com.duochat.app.groups.GroupEvent
import com.duochat.app.groups.GroupException
import com.duochat.app.groups.GroupFrame
import com.duochat.app.groups.GroupResult
import com.duochat.app.groups.MAX_RELAY_HOPS
import com.duochat.app.groups.MessageVerdict
import com.duochat.app.groups.OutgoingFrame
import com.duochat.app.groups.parseGroupFrame
import com.duochat.app.p2p.ManualSignal
import com.duochat.app.p2p.ManualSignalCodec
import com.duochat.app.p2p.PeerSession
import com.duochat.app.p2p.iceServers
import com.duochat.app.security.AndroidIdentityManager
import com.duochat.app.security.Contact
import com.duochat.app.security.Channels
import com.duochat.app.ble.MeshNode
import com.duochat.app.ble.MeshOutgoing
import com.duochat.app.ble.MeshRadio
import com.duochat.app.data.ChannelView
import com.duochat.app.security.InviteCode
import com.duochat.app.data.ActiveInvite
import com.duochat.app.data.InviteRequest
import com.duochat.app.security.ContactCard
import com.duochat.app.security.ContactCards
import com.duochat.app.security.DeviceIdentity
import com.duochat.app.security.PinnedPeer
import com.duochat.app.security.PublicJwk
import com.duochat.app.security.Seal
import com.duochat.app.security.SealedBlob
import com.duochat.app.signaling.SignalingHub
import com.duochat.app.signaling.SignalingStatus
import com.duochat.app.signaling.SignalingTransport
import com.duochat.app.signaling.transportsFor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.security.SecureRandom

/** Something the user should hear about while the app is in the background. */
class IncomingNotice(val id: String, val conversationId: String, val title: String, val body: String, val isMessage: Boolean = true)

/**
 * Chat engine for many contacts and groups. No accounts, no required server.
 *
 * * One authenticated link per contact (WebRTC data channel, or Bluetooth LE). Unsent messages stay queued per
 *   recipient (encrypted at rest) and go out when that contact's link opens.
 * * One signaling hub for the whole app: our mailbox receives sealed blobs, each opened with the pinned key of
 *   the contact named in `blob.from`. When no signaling is reachable a sealed blob can be passed on by a mutual
 *   contact (`relay_blob`), which is how two people who only share a friend still find each other.
 * * Groups are signed event logs (see [GroupCoordinator]); a group message is sent to every member over that
 *   member's own link. People brought in by a member are pinned as "introduced" and connected automatically.
 *
 * Everything runs on [scope] (the main thread); callbacks from other threads hop onto it first.
 */
class ChatEngine(
    private val scope: CoroutineScope,
    /** Fixed id mixed into the identity handshake (kept for compatibility with older installs and the desktop). */
    private val handshakeId: String,
    private val store: MessageStore,
    private val identityManager: AndroidIdentityManager,
    private val networkConfig: () -> NetworkConfig,
    private val ownName: () -> String,
    private val legacyNickname: () -> String,
    private val isMuted: (String) -> Boolean,
    private val onNotify: (IncomingNotice) -> Unit,
    /** The "stay group-only" privacy setting when the engine starts; later changes arrive via [setGroupOnly]. */
    initialGroupOnly: Boolean = false,
    /** Null where Bluetooth cannot be used at all (for example in unit tests). */
    private val ble: BleEnvironment? = null,
    /** Makes the Bluetooth mesh radio; null where it cannot exist (unit tests, no Bluetooth). */
    private val meshRadioFactory: (() -> com.duochat.app.ble.MeshRadio)? = null,
) {
    private val _state = MutableStateFlow(ChatState())
    val state: StateFlow<ChatState> = _state.asStateFlow()

    /** A saved friend (or someone introduced to us). Keys are pinned from [card]. */
    private class Friend(
        val uid: String,
        var name: String,
        var card: ContactCard,
        var trust: ContactTrust,
        var introducedBy: String?,
        /** When the safety numbers were compared (or confirmed in the manual flow); null if never. */
        var checkedAt: Long?,
        val createdAt: Long,
    ) {
        val checked: Boolean get() = checkedAt != null
    }

    /** Which friend a [PeerSession] belongs to; null while a manual connection is not saved yet. */
    private class Binding(var uid: String?)

    private inner class Link(val binding: Binding, var session: PeerSession) {
        var p2pState = P2PState.IDLE
        var ready = false
        var trust = PeerTrust.NONE
        var path: ConnectionPath? = null
        var lastOfferAt = 0L
        var attempt = 0
        var offerTimeout: Job? = null
        var pathJob: Job? = null
        val sent = mutableSetOf<String>()
        var lastReadWritten: String? = null
        var lastBleAt = 0L
        var bleAttempt = 0
        var lastInfoAt = 0L
        val relayWindow = ArrayDeque<Long>()
    }

    private val friends = linkedMapOf<String, Friend>()
    private val links = HashMap<String, Link>()
    private val messages = linkedMapOf<String, ChatMessage>()
    private val outbox = linkedMapOf<String, OutboxRow>()
    private val pendingGroup = PendingGroupBuffer<ChatMessage>()
    private val seenBlobs = SeenSet()
    private val savedGroups = mutableSetOf<String>()

    private var identity: DeviceIdentity? = null
    private var coordinator: GroupCoordinator? = null
    private var stopped = false
    private var appVisible = false
    private var openChat: String? = null
    private var tickJob: Job? = null
    private var hub: SignalingHub? = null
    private var manualLink: Link? = null
    private var bleSearch: Job? = null
    private var bleUid: String? = null
    private var bleManualAttempt = false
    private val relayed = mutableSetOf<String>()
    private var notice: String? = null

    /** Privacy: people we only know through a group stay group-only for us. */
    private var groupOnly = initialGroupOnly

    /** What each connected friend told us about their own setting (re-announced on every link). */
    private val peerGroupOnly = HashMap<String, Boolean>()
    private val assemblers = HashMap<String, FileAssembler>()
    private val lastChunkAt = HashMap<String, Long>()
    private val sendingFiles = mutableSetOf<String>()
    private val progress = HashMap<String, Float>()

    private val selfUid: String
        get() = identity?.uid.orEmpty()

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    suspend fun start() {
        try {
            val loadedIdentity = identityManager.load()
            if (loadedIdentity == null) {
                // First run: nothing works until the 12-word phrase flow has created an identity.
                _state.update { it.copy(phase = EnginePhase.NEEDS_IDENTITY) }
                return
            }
            identity = loadedIdentity
            for (row in store.loadContacts()) friends[row.uid] = friendFrom(row)
            migrateLegacyPeer(loadedIdentity)
            store.loadMessages().forEach { messages[it.messageId] = it }
            runCatching { store.loadOutbox() }.getOrDefault(emptyList()).forEach { outbox[it.key] = it }
            rebuildCoordinator()
            coordinator?.load(runCatching { store.loadGroupLogs() }.getOrDefault(emptyMap()))
            savedGroups += coordinator?.groupIds().orEmpty()
            repairOutbox()
            store.getKv("muted")?.let { a -> for (i in 0 until a.length()) muted += a.getString(i) }
            if (stopped) return
            _state.update { it.copy(phase = EnginePhase.READY, uid = loadedIdentity.uid) }
            for (uid in friends.keys) ensureLink(uid)
            emit()
            startSignaling()
            store.getKv("channels")?.let { a -> for (i in 0 until a.length()) runCatching { joinChannel(a.getString(i), persist = false) } }
            startTicking()
            refreshBluetooth()
        } catch (error: Exception) {
            if (!stopped) {
                _state.update { it.copy(phase = EnginePhase.ERROR, error = error.message ?: "Startup failed.") }
            }
        }
    }

    fun stop() {
        stopped = true
        tickJob?.cancel()
        bleSearch?.cancel()
        hub?.stop()
        hub = null
        for (link in links.values) closeLink(link)
        links.clear()
        manualLink?.session?.close()
        manualLink = null
        _state.update { it.copy(phase = EnginePhase.STOPPED) }
    }

    /** The app is in the foreground (used to decide about notifications). */
    fun setVisible(isVisible: Boolean) {
        appVisible = isVisible
        openChat?.let { id -> if (isVisible) scope.launch { markRead(id) } }
    }

    /** The conversation on screen (null on the home list). */
    fun setOpenChat(conversationId: String?) {
        openChat = conversationId
        if (conversationId != null) scope.launch { markRead(conversationId) }
    }

    fun clearNotice() {
        notice = null
        _state.update { it.copy(notice = null, error = null) }
    }

    private fun say(text: String) {
        notice = text
        _state.update { it.copy(notice = text) }
    }

    private fun friendFrom(row: ContactEntity): Friend {
        val card = ContactCard(
            PublicJwk(row.signPubX, row.signPubY), PublicJwk(row.dhPubX, row.dhPubY), row.identityProof, row.cardName,
        )
        return Friend(row.uid, row.name, card, ContactTrust.fromWire(row.trust), row.introducedBy, row.verifiedAt, row.createdAt)
    }

    private fun entityFrom(friend: Friend): ContactEntity {
        val identityKey = identity?.publicJwk
        return ContactEntity(
            uid = friend.uid,
            name = friend.name,
            signPubX = friend.card.sign.x,
            signPubY = friend.card.sign.y,
            dhPubX = friend.card.dh.x,
            dhPubY = friend.card.dh.y,
            identityProof = friend.card.proof,
            safetyNumber = if (friend.trust == ContactTrust.INTRODUCED) "introduced" else
                runCatching { identityManager.deriveSafetyNumber(identityKey!!, friend.card.sign) }.getOrDefault(""),
            verifiedAt = friend.checkedAt,
            createdAt = friend.createdAt,
            trust = friend.trust.wire,
            introducedBy = friend.introducedBy,
            cardName = friend.card.name,
        )
    }

    /**
     * The single-friend version pinned one peer in preferences and kept every message under one fixed
     * conversation id. Turn that peer into a saved friend and move its messages, once.
     */
    private suspend fun migrateLegacyPeer(current: DeviceIdentity) {
        val legacy = identityManager.loadPinnedPeer() ?: return
        val dh = legacy.dh
        if (dh != null && legacy.uid != current.uid && friends[legacy.uid] == null) {
            val nickname = legacyNickname().ifBlank { "Friend ${legacy.uid.take(4)}" }
            // The pinned record never kept the identity proof; it is learned from the next handshake.
            val friend = Friend(legacy.uid, nickname, ContactCard(legacy.key, dh, "", null), ContactTrust.VERIFIED, null, null, System.currentTimeMillis())
            friends[legacy.uid] = friend
            store.putContact(entityFrom(friend))
        }
        if (friends.containsKey(legacy.uid)) {
            store.adoptLegacyConversation(legacy.uid)
            identityManager.erasePeerKey(null)
        }
    }

    /**
     * Queue rows saved by the single-friend version have no recipient: they belong to the friend of their chat.
     * Rows whose message is gone or already delivered are dropped.
     */
    private suspend fun repairOutbox() {
        for (row in outbox.values.toList()) {
            val message = messages[row.messageId]
            val done = message == null || message.deliveryState == DeliveryState.DELIVERED || message.deliveryState == DeliveryState.READ
            if (done) {
                outbox.remove(row.key)
                store.removeOutbox(row.messageId, row.recipientId)
            } else if (row.recipientId.isEmpty()) {
                outbox.remove(row.key)
                store.removeOutbox(row.messageId, "")
                val target = message!!.conversationId
                if (friends.containsKey(target)) {
                    val fixed = row.copy(recipientId = target)
                    outbox[fixed.key] = fixed
                    store.enqueueOutbox(fixed, target)
                }
            }
        }
    }

    private fun rebuildCoordinator() {
        val current = identity ?: return
        val saved = coordinator?.export().orEmpty()
        val name = ownName().trim().ifEmpty { null }
        val own = ContactCard(current.publicJwk, current.dhJwk, current.identityProof, name?.take(40))
        coordinator = GroupCoordinator(
            current.uid, own, { identityManager.signRaw(it) }, { friends.keys },
        ).also { it.load(saved) }
    }

    /** The name friends see changed: new groups carry the new name. */
    fun onOwnNameChanged() {
        if (identity != null) rebuildCoordinator()
    }

    // ---------------------------------------------------------------------
    // Names
    // ---------------------------------------------------------------------

    private fun nameOf(uid: String): String {
        if (uid == selfUid) return "You"
        friends[uid]?.let { return it.name }
        coordinator?.myGroups()?.forEach { g -> g.members[uid]?.card?.name?.let { return it } }
        return "Member ${uid.take(4)}"
    }

    // ---------------------------------------------------------------------
    // Friends
    // ---------------------------------------------------------------------

    fun ownCard(): String {
        val current = identity ?: throw IllegalStateException("Identity is not ready.")
        return ContactCards.encode(ContactCard(current.publicJwk, current.dhJwk, current.identityProof, ownName().ifBlank { null }))
    }

    /** Save the friend whose invite was scanned or pasted. Returns their uid. */
    suspend fun addFriend(text: String): Result<String> = runCatching {
        val current = identity ?: throw IllegalStateException("Identity is not ready.")
        val words = InviteCode.parse(text)
        val found = words?.let { lookUpInvite(it) }
        val contact: Contact = found?.second ?: ContactCards.decode(text)
            ?: throw IllegalArgumentException("That is not a valid invite. Check the words, or ask your friend to share it again.")
        if (contact.uid == current.uid) throw IllegalArgumentException("That is your own invite. Send it to a friend instead.")
        val existing = friends[contact.uid]
        if (existing != null) {
            if (!identityManager.publicKeysEqual(existing.card.sign, contact.card.sign)) {
                throw IllegalArgumentException("This invite does not match ${existing.name}'s saved identity.")
            }
            existing.card = contact.card
            existing.trust = ContactTrust.VERIFIED
            store.putContact(entityFrom(existing))
            say("${existing.name} is already in your list.")
        } else {
            val friend = Friend(
                contact.uid, contact.card.name ?: "Friend ${contact.uid.take(4)}", contact.card,
                ContactTrust.VERIFIED, null, null, System.currentTimeMillis(),
            )
            friends[friend.uid] = friend
            store.putContact(entityFrom(friend))
            ensureLink(friend.uid)
            startSignaling(force = hub == null)
            say("${friend.name} was added. Connecting automatically whenever you are both online.")
        }
        emit()
        // Used someone's words: answer with our own card so they can accept us (they confirm it on their side).
        found?.let { (rv, _) ->
            lastAnswer = rv to contact.uid
            scope.launch { runAnswer() }
        }
        contact.uid
    }

    private var lastAnswer: Pair<InviteCode.Rendezvous, String>? = null

    /** Sends our invite back and keeps the result where the screen can show it. */
    private suspend fun runAnswer() {
        val (rv, uid) = lastAnswer ?: return
        val name = friends[uid]?.name ?: "your friend"
        _state.update { it.copy(answer = com.duochat.app.data.InviteAnswer(uid, name, com.duochat.app.data.AnswerState.SENDING)) }
        val result = runCatching { answerInvite(rv) }
        _state.update {
            it.copy(
                answer = if (result.isSuccess) com.duochat.app.data.InviteAnswer(uid, name, com.duochat.app.data.AnswerState.SENT)
                else com.duochat.app.data.InviteAnswer(uid, name, com.duochat.app.data.AnswerState.FAILED, result.exceptionOrNull()?.message ?: "Could not reach them."),
            )
        }
    }

    fun retryAnswer() {
        scope.launch { runAnswer() }
    }

    fun clearAnswer() {
        _state.update { it.copy(answer = null) }
    }

    // ---------------------------------------------------------------------
    // Open channels and the Bluetooth mesh
    // ---------------------------------------------------------------------

    private class JoinedChannel(val keys: Channels.Keys, val hub: SignalingHub)

    private val joinedChannels = LinkedHashMap<String, JoinedChannel>()
    private val muted = HashSet<String>()
    private val meshNode = MeshNode()
    private var meshRadio: MeshRadio? = null

    /** A readable name for someone we only know from a channel: their chosen name plus a short id. */
    private fun channelLabel(card: ContactCard, uid: String) = "${card.name?.trim().takeUnless { it.isNullOrEmpty() } ?: "Anonymous"} #${uid.take(4)}"

    /** Join (or create: there is no difference) a public channel. Returns its conversation id. */
    suspend fun joinChannel(raw: String, persist: Boolean = true): Result<String> = runCatching {
        val name = Channels.normalize(raw) ?: throw IllegalArgumentException("Type a channel name, for example general.")
        if (joinedChannels.containsKey(name)) return@runCatching "chan:$name"
        if (joinedChannels.size >= MAX_CHANNELS) throw IllegalStateException("You can be in at most $MAX_CHANNELS channels. Leave one first.")
        val keys = Channels.derive(name)
        val hub = if (networkConfig().signaling.isEmpty()) null else SignalingHub(transportsFor(networkConfig(), scope))
        // A channel needs the internet connection service or the Bluetooth mesh; with neither it could never carry a message.
        if (hub == null && meshRadio == null) {
            throw IllegalStateException("Channels need a connection service (Settings > Connection) or the Bluetooth mesh (Settings).")
        }
        val joined = JoinedChannel(keys, hub ?: SignalingHub(emptyList()))
        hub?.start(keys.mailbox) { blob, _, _ -> scope.launch { onChannelBlob(keys, blob) } }
        joinedChannels[name] = joined
        if (persist) persistChannels()
        emit()
        "chan:$name"
    }

    fun leaveChannel(conversationId: String) {
        val name = conversationId.removePrefix("chan:")
        joinedChannels.remove(name)?.hub?.stop()
        messages.values.removeAll { it.conversationId == "chan:$name" }
        scope.launch { store.clearConversation("chan:$name") }
        persistChannels()
        emit()
    }

    private fun persistChannels() {
        scope.launch { runCatching { store.putKv("channels", org.json.JSONArray(joinedChannels.keys.toList())) } }
    }

    /** Stop showing a person's channel messages (kept on this phone only). */
    fun muteSender(uid: String) {
        muted += uid
        scope.launch { runCatching { store.putKv("muted", org.json.JSONArray(muted.toList())) } }
        emit()
    }

    private suspend fun sendChannel(name: String, rawText: String): Result<Unit> {
        val c = joinedChannels[name] ?: return Result.failure(IllegalStateException("You left this channel."))
        val text = normalizeNewlines(rawText).trim()
        if (text.isEmpty()) return Result.failure(IllegalArgumentException("Message cannot be empty."))
        if (countCodePoints(text) > Channels.MAX_TEXT) return Result.failure(IllegalArgumentException("Channel messages are limited to ${Channels.MAX_TEXT} characters."))
        val online = c.hub.status() == SignalingStatus.ONLINE
        if (!online && meshRadio?.linkCount.let { it == null || it == 0 }) {
            return Result.failure(IllegalStateException("Not connected to the connection service or to any nearby phone yet. Try again in a moment."))
        }
        val at = System.currentTimeMillis()
        val card = inviteCard()
        val blob = withContext(Dispatchers.Default) { Channels.seal(c.keys, text, at, card, selfUid) { identityManager.signRaw(it) } }
        var sent = false
        if (online) {
            // Live copy always; a stored copy (history for people who join later) only if store-and-forward is on.
            val live = runCatching { c.hub.put(c.keys.mailbox, blob, "sig", 120) }
            val stored = if (networkConfig().storeForward) runCatching { c.hub.put(c.keys.mailbox, blob, "msg", Channels.TTL_SEC) } else null
            sent = live.isSuccess || stored?.isSuccess == true
        }
        if (meshInject(blob)) sent = true
        if (!sent) return Result.failure(IllegalStateException("Could not send. Check your connection."))
        storeChannelMessage(name, "c-${blob.sig.take(24)}", selfUid, text, at, channelLabel(card, selfUid))
        return Result.success(Unit)
    }

    private suspend fun storeChannelMessage(name: String, messageId: String, senderId: String, text: String, at: Long, label: String) {
        if (messages.containsKey(messageId)) return
        val convId = "chan:$name"
        val own = senderId == selfUid
        val m = ChatMessage(
            messageId = messageId, clientMessageId = messageId, senderId = senderId, text = text,
            clientCreatedAt = minOf(at, System.currentTimeMillis() + 5 * 60_000), transport = TransportKind.P2P,
            deliveryState = if (own) DeliveryState.SENT else DeliveryState.DELIVERED,
            readAt = if (own || (appVisible && openChat == convId)) System.currentTimeMillis() else null,
            conversationId = convId, senderName = label,
        )
        messages[messageId] = m
        store.putMessage(m)
        emit()
    }

    private suspend fun onChannelBlob(keys: Channels.Keys, blob: SealedBlob) {
        val message = withContext(Dispatchers.Default) { Channels.open(keys, blob) } ?: return
        val uid = message.contact.uid
        if (uid == selfUid || uid in muted) return
        storeChannelMessage(keys.name, "c-${blob.sig.take(24)}", uid, message.text, message.at, channelLabel(message.contact.card, uid))
    }

    /** Turns the Bluetooth mesh on or off (Settings). Nothing is advertised or scanned while it is off. */
    fun setMeshEnabled(on: Boolean) {
        if (on && meshRadio == null) {
            val radio = meshRadioFactory?.invoke() ?: return
            meshRadio = radio
            radio.start(object : MeshRadio.Listener {
                override fun onLinkUp(link: String) {
                    scope.launch { meshNode.linkUp(link, System.currentTimeMillis()).forEach(::sendMesh); emit() }
                }

                override fun onLinkDown(link: String) {
                    meshNode.linkDown(link)
                    emit()
                }

                override fun onPacket(link: String, json: String) {
                    scope.launch { onMeshPacket(link, json) }
                }
            })
        } else if (!on) {
            meshRadio?.stop()
            meshRadio = null
            for (l in meshNode.neighbours) meshNode.linkDown(l)
        }
        emit()
    }

    private fun sendMesh(o: MeshOutgoing) {
        meshRadio?.send(o.link, o.packet.toJson().toString())
    }

    /** Hands a signed or sealed message to every nearby phone. False when the mesh is off. */
    private fun meshInject(blob: SealedBlob): Boolean {
        if (meshRadio == null) return false
        meshNode.inject(blob, System.currentTimeMillis()).forEach(::sendMesh)
        return true
    }

    private suspend fun onMeshPacket(link: String, json: String) {
        val parsed = try { JSONObject(json) } catch (_: Exception) { return }
        val handled = meshNode.handle(parsed, link, System.currentTimeMillis())
        handled.forward.forEach(::sendMesh)
        val blob = handled.accepted ?: return
        if (blob.to == selfUid) {
            handleBlob(blob, "mesh", null) // a direct message (or ack) sealed to us, relayed by strangers
        } else {
            joinedChannels.values.firstOrNull { it.keys.tag == blob.to }?.let { onChannelBlob(it.keys, blob) }
        }
    }

    /** Queued direct messages for friends we are not linked to go out over the mesh too. */
    private suspend fun meshPending() {
        if (meshRadio == null || meshNode.neighbours.isEmpty()) return
        for (row in outbox.values.toList()) {
            val message = messages[row.messageId] ?: continue
            if (message.senderId != selfUid || !needsDelivery(message.deliveryState) || message.type != MessageType.TEXT) continue
            if (coordinator?.state(message.conversationId) != null) continue
            if (links[row.recipientId]?.session?.isReady == true) continue
            if (!relayed.add("mesh|${row.key}")) continue
            val friend = friends[row.recipientId] ?: continue
            val blob = sealTo(friend, JSONObject().put("t", "msg").put("id", message.messageId).put("text", message.text).put("at", message.clientCreatedAt))
            meshInject(blob)
        }
    }

    // ---------------------------------------------------------------------
    // Six-word invites
    // ---------------------------------------------------------------------

    private class ActiveInviteState(val words: List<String>, val rv: InviteCode.Rendezvous, val hub: SignalingHub, val expiresAt: Long, val job: Job)

    private var activeInvite: ActiveInviteState? = null
    private val requestCards = linkedMapOf<String, Pair<Contact, String>>()
    private val inviteMutex = kotlinx.coroutines.sync.Mutex()

    private fun inviteHub(): SignalingHub {
        val config = networkConfig()
        if (config.signaling.isEmpty()) {
            throw IllegalStateException("Six-word invites need a connection service (Settings > Connection). The QR code and the full invite text work without one.")
        }
        return SignalingHub(transportsFor(config, scope))
    }

    private suspend fun waitOnline(hub: SignalingHub, ms: Long = 8_000) {
        val end = System.currentTimeMillis() + ms
        while (hub.status() != SignalingStatus.ONLINE) {
            if (System.currentTimeMillis() > end) {
                hub.stop()
                throw IllegalStateException("Could not reach the connection service. Check your internet and try again.")
            }
            delay(100)
        }
    }

    /** Live copy (works on relays that store nothing) plus a stored copy (works for late arrivals where allowed). */
    private suspend fun putEverywhere(hub: SignalingHub, mailbox: String, blob: SealedBlob) {
        // A live copy always (re-sent every few seconds while the invite is open); a stored copy only when the user
        // turned store-and-forward on: with it off, nothing may be kept on a relay.
        val live = runCatching { hub.put(mailbox, blob, "sig", 120) }
        val stored = if (networkConfig().storeForward) runCatching { hub.put(mailbox, blob, "msg", InviteCode.TTL_SEC) } else null
        if (live.isFailure && (stored == null || stored.isFailure)) throw IllegalStateException("Could not publish the invite.")
    }

    private fun inviteCard(): ContactCard {
        val current = identity ?: throw IllegalStateException("Identity is not ready.")
        return ContactCard(current.publicJwk, current.dhJwk, current.identityProof, ownName().ifBlank { null })
    }

    /** Show-your-words: publish our card under fresh words and listen for people who answer. */
    suspend fun createInvite(): Result<ActiveInvite> = runCatching {
        inviteMutex.withLock {
            activeInvite?.takeIf { it.expiresAt > System.currentTimeMillis() + 30_000 }?.let {
                return@runCatching ActiveInvite(it.words.joinToString(" "), it.expiresAt)
            }
            stopInvite()
            val hub = inviteHub()
            val words = InviteCode.newWords()
            val rv = withContext(Dispatchers.Default) { InviteCode.derive(words) }
            hub.start(rv.mailbox) { blob, _, _ -> scope.launch { onInviteBlob(rv, blob) } }
            waitOnline(hub)
            suspend fun publish() {
                val blob = InviteCode.seal(rv, InviteCode.Kind.CARD, inviteCard(), selfUid) { identityManager.signRaw(it) }
                putEverywhere(hub, rv.mailbox, blob)
            }
            publish()
            val expiresAt = System.currentTimeMillis() + InviteCode.TTL_SEC * 1000L
            // Relays differ in what they keep, so the card is also published again every few seconds.
            val job = scope.launch {
                while (System.currentTimeMillis() < expiresAt) {
                    delay(8_000)
                    runCatching { publish() }
                }
                inviteMutex.withLock { if (activeInvite?.rv === rv) stopInvite() }
            }
            activeInvite = ActiveInviteState(words, rv, hub, expiresAt, job)
            val view = ActiveInvite(words.joinToString(" "), expiresAt)
            _state.update { it.copy(invite = view) }
            view
        }
    }

    private fun stopInvite() {
        activeInvite?.let {
            it.job.cancel()
            it.hub.stop()
        }
        activeInvite = null
        _state.update { it.copy(invite = null) }
    }

    private suspend fun onInviteBlob(rv: InviteCode.Rendezvous, blob: SealedBlob) {
        val message = withContext(Dispatchers.Default) { InviteCode.open(rv, blob) } ?: return
        if (message.kind != InviteCode.Kind.REPLY) return
        val contact = message.contact
        if (contact.uid == selfUid || friends[contact.uid]?.trust == ContactTrust.VERIFIED) return
        val current = identity ?: return
        requestCards[contact.uid] = contact to runCatching { identityManager.deriveSafetyNumber(current.publicJwk, contact.card.sign) }.getOrDefault("")
        emit()
    }

    /** Accept somebody who used our words. */
    suspend fun acceptRequest(uid: String): Result<String> {
        val request = requestCards.remove(uid) ?: return Result.failure(IllegalStateException("That request is no longer there."))
        return addFriend(ContactCards.encode(request.first.card))
    }

    fun dismissRequest(uid: String) {
        requestCards.remove(uid)
        emit()
    }

    /** Enter-their-words: fetch their card from the meeting point. */
    private suspend fun lookUpInvite(words: List<String>): Pair<InviteCode.Rendezvous, Contact> {
        val rv = withContext(Dispatchers.Default) { InviteCode.derive(words) }
        val hub = inviteHub()
        val found = kotlinx.coroutines.CompletableDeferred<Contact?>()
        hub.start(rv.mailbox) { blob, _, _ ->
            scope.launch {
                val m = withContext(Dispatchers.Default) { InviteCode.open(rv, blob) }
                if (m != null && m.kind == InviteCode.Kind.CARD && m.contact.uid != selfUid) found.complete(m.contact)
            }
        }
        val contact = kotlinx.coroutines.withTimeoutOrNull(15_000) { found.await() }
        hub.stop()
        return rv to (contact ?: throw IllegalStateException("Could not find that invite. Check the words, make sure your friend still has the invite open, and that you are both online."))
    }

    private suspend fun answerInvite(rv: InviteCode.Rendezvous) {
        val hub = inviteHub()
        hub.start(rv.mailbox) { _, _, _ -> }
        try {
            waitOnline(hub)
            val blob = InviteCode.seal(rv, InviteCode.Kind.REPLY, inviteCard(), selfUid) { identityManager.signRaw(it) }
            putEverywhere(hub, rv.mailbox, blob)
            delay(1_500)
        } finally {
            hub.stop()
        }
    }

    /** "Check it's really them": the safety numbers matched. */
    suspend fun markChecked(uid: String) {
        val friend = friends[uid] ?: return
        // A safety-number check is not a pairing: direct messages follow the group-only rules, and swapping
        // invites (addFriend) is what pairs two people for good.
        friend.checkedAt = System.currentTimeMillis()
        store.putContact(entityFrom(friend))
        emit()
    }

    suspend fun renameFriend(uid: String, name: String) {
        val friend = friends[uid] ?: return
        val clean = name.trim().take(40)
        if (clean.isEmpty()) return
        friend.name = clean
        store.renameContact(uid, clean)
        emit()
    }

    /** Why a friend cannot be removed right now, or null. */
    fun removeBlocker(uid: String): String? {
        val shared = coordinator?.myGroups()?.firstOrNull { it.members.containsKey(uid) }
        return if (shared != null) "${nameOf(uid)} is in the group \"${shared.name}\" with you. Leave that group first." else null
    }

    suspend fun removeFriend(uid: String): Result<Unit> {
        removeBlocker(uid)?.let { return Result.failure(IllegalStateException(it)) }
        links.remove(uid)?.let { closeLink(it) }
        friends.remove(uid)
        store.deleteContact(uid)
        clearConversationData(uid)
        emit()
        return Result.success(Unit)
    }

    // ---------------------------------------------------------------------
    // Groups
    // ---------------------------------------------------------------------

    private fun cardOfFriend(uid: String): ContactCard {
        val friend = friends[uid] ?: throw IllegalArgumentException("Unknown friend.")
        if (friend.card.proof.isEmpty()) {
            throw IllegalStateException("${friend.name} has to connect with you once before they can join a group.")
        }
        return friend.card
    }

    /** Can we start or continue a direct chat with them? See [canStartDirect]. */
    private fun canDirect(uid: String): Boolean {
        val f = friends[uid] ?: return false
        return canStartDirect(f.trust, groupOnly, peerGroupOnly[uid])
    }

    private fun acceptsDirectFrom(uid: String): Boolean {
        val f = friends[uid] ?: return false
        return acceptsDirect(f.trust, groupOnly)
    }

    /** Turn the group-only privacy setting on or off and tell everyone we are connected to. */
    fun setGroupOnly(value: Boolean) {
        if (groupOnly == value) return
        groupOnly = value
        for (link in links.values) if (link.session.isReady) link.session.sendJson(privacyFrame())
        emit()
    }

    private fun privacyFrame() = JSONObject().put("v", 1).put("kind", "privacy").put("groupOnly", groupOnly)

    /** Why this conversation cannot be written to right now, or null if it can. */
    private fun cannotWrite(conversationId: String): String? {
        val friend = friends[conversationId]
        if (friend != null) {
            if (canDirect(conversationId)) return null
            return if (groupOnly) {
                "You stay group-only with people you meet in groups. To message ${friend.name} directly, swap invites (Add friend)."
            } else {
                "${friend.name} stays group-only, so you can talk in your groups but not directly. To message them, swap invites (Add friend)."
            }
        }
        if (conversationId.startsWith("chan:")) return if (joinedChannels.containsKey(conversationId.removePrefix("chan:"))) null else "You left this channel."
        val group = coordinator?.state(conversationId) ?: return "Unknown chat."
        return if (group.members.containsKey(selfUid)) null else "You are no longer in this group."
    }

    suspend fun createGroup(name: String, memberUids: List<String>): Result<String> = runCatching {
        val coordinator = coordinator ?: throw IllegalStateException("Identity is not ready.")
        val clean = name.trim()
        if (clean.isEmpty()) throw IllegalArgumentException("Give the group a name.")
        val cards = memberUids.distinct().map { requireDirect(it); cardOfFriend(it) }
        val created = coordinator.createGroup(clean, cards)
        applyGroupResult(created.result, null)
        say("Group \"$clean\" created.")
        created.groupId
    }

    /** Group-only people are not offered for groups: their identity is not spread through us. */
    private fun requireDirect(uid: String) {
        if (!canDirect(uid)) throw IllegalArgumentException("Pick friends you can message directly.")
    }

    suspend fun addToGroup(groupId: String, uids: List<String>): Result<Unit> = runCatching {
        val coordinator = coordinator ?: throw IllegalStateException("Identity is not ready.")
        for (uid in uids.distinct()) {
            requireDirect(uid)
            val card = cardOfFriend(uid)
            try {
                applyGroupResult(coordinator.addMember(groupId, card), null)
            } catch (e: GroupException) {
                throw IllegalStateException(e.message)
            }
        }
    }

    suspend fun removeFromGroup(groupId: String, uid: String): Result<Unit> = runCatching {
        applyGroupResult((coordinator ?: throw IllegalStateException("Not ready.")).removeMember(groupId, uid), null)
    }.mapError()

    suspend fun leaveGroup(groupId: String): Result<Unit> = runCatching {
        applyGroupResult((coordinator ?: throw IllegalStateException("Not ready.")).leave(groupId), null)
    }.mapError()

    suspend fun renameGroup(groupId: String, name: String): Result<Unit> = runCatching {
        if (name.isBlank()) throw IllegalArgumentException("Give the group a name.")
        applyGroupResult((coordinator ?: throw IllegalStateException("Not ready.")).rename(groupId, name), null)
    }.mapError()

    private fun <T> Result<T>.mapError(): Result<T> =
        if (isFailure && exceptionOrNull() is GroupException) Result.failure(IllegalStateException(exceptionOrNull()!!.message)) else this

    /**
     * Apply what the group core decided: persist logs, deliver frames to the links that are up (sync repairs
     * the rest), meet new members, wake up held messages.
     */
    private suspend fun applyGroupResult(result: GroupResult, from: String?) {
        val coordinator = coordinator ?: return
        for (groupId in result.changed.distinct()) {
            coordinator.exportGroup(groupId)?.let {
                store.saveGroupLog(groupId, it)
                savedGroups += groupId
            }
        }
        for (gone in savedGroups - coordinator.groupIds().toSet()) {
            store.deleteGroupLog(gone)
            savedGroups -= gone
        }
        for (c in result.newContacts) introduce(c.card, c.uid, c.introducedBy, c.groupId)
        for (out in result.outgoing) sendFrame(out)
        for (groupId in result.joined.distinct()) {
            val state = coordinator.state(groupId) ?: continue
            val adder = state.members[selfUid]?.addedBy
            if (adder != null && adder != selfUid) {
                val text = "${nameOf(adder)} added you to \"${state.name}\"."
                say(text)
                if (!isMuted(groupId)) onNotify(IncomingNotice("join-$groupId", groupId, state.name, text, isMessage = false))
            }
        }
        for (groupId in result.changed.distinct()) pruneOutbox(groupId)
        releasePending()
        emit()
    }

    /** A member we have no contact for: pin their card as "introduced" and start connecting. */
    private suspend fun introduce(card: ContactCard, uid: String, addedBy: String, groupId: String) {
        if (friends.containsKey(uid) || uid == selfUid) return
        // The creator's own entry says "added by themselves"; for us the useful name is whoever brought us in.
        val introducer = if (addedBy == uid) {
            coordinator?.state(groupId)?.members?.get(selfUid)?.addedBy ?: addedBy
        } else {
            addedBy
        }
        val friend = Friend(
            uid, card.name ?: "Member ${uid.take(4)}", card, ContactTrust.INTRODUCED,
            introducer.takeIf { it != selfUid }, null, System.currentTimeMillis(),
        )
        friends[uid] = friend
        store.putContact(entityFrom(friend))
        ensureLink(uid)
        startSignaling(force = hub == null)
    }

    /** Rows for people who are no longer in a group would wait forever; drop them and shrink the message's audience. */
    private suspend fun pruneOutbox(groupId: String) {
        val coordinator = coordinator ?: return
        val state = coordinator.state(groupId)
        val members = state?.members?.keys.orEmpty()
        val iAmIn = state?.members?.containsKey(selfUid) == true
        val removed = HashMap<String, Int>()
        for (row in outbox.values.toList()) {
            val message = messages[row.messageId] ?: continue
            if (message.conversationId != groupId) continue
            if (row.recipientId !in members || !iAmIn) {
                outbox.remove(row.key)
                store.removeOutbox(row.messageId, row.recipientId)
                removed[row.messageId] = (removed[row.messageId] ?: 0) + 1
            }
        }
        for ((messageId, count) in removed) {
            val message = messages[messageId] ?: continue
            val total = maxOf(0, message.totalRecipients - count)
            messages[messageId] = message.copy(totalRecipients = total)
            store.updateRecipients(messageId, total)
            refreshGroupMessage(messageId)
        }
    }

    private suspend fun releasePending() {
        val coordinator = coordinator ?: return
        val ready = pendingGroup.release(System.currentTimeMillis()) { groupId, from ->
            coordinator.checkMessage(from, groupId) == MessageVerdict.OK
        }
        for ((_, from, message) in ready) acceptGroupMessage(from, message)
    }

    // ---------------------------------------------------------------------
    // Sending
    // ---------------------------------------------------------------------

    /** The quote that goes with a reply, taken from our own copy of the message. */
    private fun replyFor(conversationId: String, replyToId: String?): ReplyRef? {
        val original = replyToId?.let { messages[it] } ?: return null
        return if (original.conversationId == conversationId) makeReplyRef(original) else null
    }

    suspend fun send(conversationId: String, rawText: String, replyToId: String? = null): Result<Unit> {
        if (identity == null) return Result.failure(IllegalStateException("Identity is not ready yet."))
        return try {
            val coordinator = coordinator ?: throw IllegalStateException("Identity is not ready yet.")
            cannotWrite(conversationId)?.let { throw IllegalStateException(it) }
            if (conversationId.startsWith("chan:")) return sendChannel(conversationId.removePrefix("chan:"), rawText)
            val isGroup = coordinator.state(conversationId) != null
            val recipients: List<String> = if (isGroup) {
                if (!coordinator.isMember(conversationId, selfUid)) throw IllegalStateException("You are no longer in this group.")
                coordinator.recipients(conversationId).also {
                    if (it.isEmpty()) throw IllegalStateException("Add someone to this group first.")
                }
            } else {
                if (!friends.containsKey(conversationId)) throw IllegalStateException("This friend is no longer in your list.")
                listOf(conversationId)
            }
            val base = createOutgoingMessage(selfUid, rawText, replyFor(conversationId, replyToId))
            val message = base.copy(conversationId = conversationId, totalRecipients = if (isGroup) recipients.size else 0)
            messages[message.messageId] = message
            store.putMessage(message)
            val now = System.currentTimeMillis()
            for (uid in recipients) {
                val row = OutboxRow(message.messageId, uid, message.messageId, now, 0, null, DeliveryState.QUEUED, null)
                outbox[row.key] = row
                store.enqueueOutbox(row, conversationId)
            }
            emit()
            scope.launch {
                for (uid in recipients) deliverTo(uid)
                relayPending()
            }
            Result.success(Unit)
        } catch (error: Exception) {
            Result.failure(error)
        }
    }

    /** Send a file (at most 8 MB) to a friend or a group. It goes straight to each person over the direct link. */
    suspend fun sendFile(
        conversationId: String, rawName: String, mime: String, bytes: ByteArray, replyToId: String? = null,
    ): Result<Unit> {
        if (identity == null) return Result.failure(IllegalStateException("Identity is not ready yet."))
        return try {
            val coordinator = coordinator ?: throw IllegalStateException("Identity is not ready yet.")
            cannotWrite(conversationId)?.let { throw IllegalStateException(it) }
            validateFileSize(bytes.size)?.let { throw IllegalArgumentException(it) }
            val isGroup = coordinator.state(conversationId) != null
            val recipients = if (isGroup) coordinator.recipients(conversationId) else listOf(conversationId)
            if (recipients.isEmpty()) throw IllegalStateException("Add someone to this group first.")
            val id = java.util.UUID.randomUUID().toString()
            val offer = FileOffer.create(id, if (isGroup) conversationId else null, rawName, mime, bytes, System.currentTimeMillis(), replyFor(conversationId, replyToId))
            withContext(Dispatchers.IO) { store.putFile(id, bytes) }
            val message = ChatMessage(
                messageId = id, clientMessageId = id, senderId = selfUid, text = offer.name,
                clientCreatedAt = offer.clientCreatedAt, conversationId = conversationId,
                totalRecipients = if (isGroup) recipients.size else 0,
                type = MessageType.FILE, replyTo = offer.replyTo,
                file = FileMeta(offer.name, offer.mime, offer.size, offer.sha256),
            )
            messages[id] = message
            store.putMessage(message)
            val now = System.currentTimeMillis()
            for (uid in recipients) {
                val row = OutboxRow(id, uid, id, now, 0, null, DeliveryState.QUEUED, null)
                outbox[row.key] = row
                store.enqueueOutbox(row, conversationId)
            }
            emit()
            scope.launch { for (uid in recipients) deliverTo(uid) }
            Result.success(Unit)
        } catch (error: Exception) {
            Result.failure(error)
        }
    }

    /** The bytes of a stored file, for showing or saving it. */
    suspend fun getFile(messageId: String): Pair<FileMeta, ByteArray>? {
        val meta = messages[messageId]?.file ?: return null
        val bytes = withContext(Dispatchers.IO) { runCatching { store.getFile(messageId) }.getOrNull() } ?: return null
        return meta to bytes
    }

    suspend fun retry(messageId: String) {
        val message = messages[messageId] ?: return
        if (message.senderId != selfUid) return
        for (row in outbox.values.filter { it.messageId == messageId }) {
            // A refused message (FAILED) is tried again from the start.
            if (row.deliveryState == DeliveryState.FAILED) {
                val again = row.copy(deliveryState = DeliveryState.QUEUED)
                outbox[row.key] = again
                store.updateOutboxDelivery(again, DeliveryState.QUEUED, null)
            }
            links[row.recipientId]?.sent?.remove(messageId)
            deliverTo(row.recipientId)
        }
        if (coordinator?.state(message.conversationId) != null) refreshGroupMessage(messageId)
        else setDirectState(message.copy(deliveryState = DeliveryState.QUEUED), DeliveryState.QUEUED, null)
    }

    /** Sends everything queued for [uid] over their link if it is up; otherwise it stays queued. */
    private suspend fun deliverTo(uid: String) {
        val link = links[uid] ?: return
        val session = link.session
        if (!session.isReady) return
        val coordinator = coordinator
        for (row in outbox.values.filter { it.recipientId == uid }.sortedBy { it.createdAt }) {
            val message = messages[row.messageId] ?: continue
            if (message.senderId != selfUid || row.messageId in link.sent) continue
            if (row.deliveryState == DeliveryState.FAILED) continue
            if (message.type == MessageType.FILE) {
                pushFile(uid, link, message, row)
                continue
            }
            val isGroup = coordinator?.state(message.conversationId) != null
            val frame = if (isGroup) {
                if (coordinator?.isMember(message.conversationId, uid) != true) continue
                GroupFrame.Message(message.conversationId, message.messageId, message.text, message.clientCreatedAt, message.replyTo).toJson()
            } else {
                JSONObject().put("v", 1).put("kind", "message")
                    .put("messageId", message.messageId).put("clientMessageId", message.clientMessageId)
                    .put("senderId", message.senderId).put("text", message.text)
                    .put("clientCreatedAt", message.clientCreatedAt)
                    .also { o -> message.replyTo?.let { o.put("replyTo", it.toJson()) } }
            }
            if (!session.sendJson(frame)) return
            link.sent += row.messageId
            val now = System.currentTimeMillis()
            outbox[row.key] = row.copy(deliveryState = DeliveryState.SENT, lastAttemptAt = now)
            store.updateOutboxDelivery(row, DeliveryState.SENT, now)
            if (isGroup) refreshGroupMessage(message.messageId) else setDirectState(message, DeliveryState.SENT, TransportKind.P2P)
        }
        emit()
    }

    /** Stream one file to one recipient: offer, then ordered chunks, pausing while the channel is backed up. */
    private fun pushFile(uid: String, link: Link, message: ChatMessage, row: OutboxRow) {
        val key = "$uid|${message.messageId}"
        if (!link.session.isWebRtc || key in sendingFiles) return // too slow over Bluetooth: it waits for an internet link
        sendingFiles += key
        scope.launch {
            try {
                val meta = message.file ?: return@launch
                val bytes = withContext(Dispatchers.IO) { runCatching { store.getFile(message.messageId) }.getOrNull() }
                if (bytes == null) {
                    failRow(row, "This file is no longer stored on this phone.")
                    return@launch
                }
                val isGroup = coordinator?.state(message.conversationId) != null
                val offer = FileOffer(
                    message.messageId, if (isGroup) message.conversationId else null, meta.name, meta.mime, meta.size, meta.sha256,
                    message.clientCreatedAt, message.replyTo,
                )
                if (!link.session.sendJson(offer.toJson())) return@launch
                val total = (bytes.size + com.duochat.app.data.FILE_CHUNK_BYTES - 1) / com.duochat.app.data.FILE_CHUNK_BYTES
                var sentChunks = 0
                for (chunk in fileChunks(message.messageId, bytes)) {
                    if (!link.session.isReady || !link.session.awaitWritable()) return@launch // the next link opening starts over
                    if (!link.session.sendJson(chunk.toJson())) return@launch
                    sentChunks++
                    if (sentChunks % PROGRESS_EVERY == 0) {
                        progress[message.messageId] = sentChunks.toFloat() / total
                        emit()
                    }
                }
                link.sent += message.messageId
                val now = System.currentTimeMillis()
                outbox[row.key] = row.copy(deliveryState = DeliveryState.SENT, lastAttemptAt = now)
                store.updateOutboxDelivery(row, DeliveryState.SENT, now)
                if (isGroup) refreshGroupMessage(message.messageId) else setDirectState(message, DeliveryState.SENT, TransportKind.P2P)
            } finally {
                sendingFiles -= key
                progress.remove(message.messageId)
                emit()
            }
        }
    }

    /** The receiver refused (or we cannot send): mark just this recipient as failed and say why. */
    private suspend fun failRow(row: OutboxRow, why: String) {
        val failed = row.copy(deliveryState = DeliveryState.FAILED)
        outbox[row.key] = failed
        store.updateOutboxDelivery(row, DeliveryState.FAILED, System.currentTimeMillis())
        val message = messages[row.messageId]
        if (message != null) {
            if (coordinator?.state(message.conversationId) != null) {
                refreshGroupMessage(row.messageId)
            } else {
                val updated = message.copy(deliveryState = DeliveryState.FAILED)
                messages[message.messageId] = updated
                store.updateMessage(message.messageId, deliveryState = DeliveryState.FAILED)
            }
        }
        say(why)
        emit()
    }

    private suspend fun setDirectState(message: ChatMessage, state: DeliveryState, transport: TransportKind? = null) {
        val current = messages[message.messageId] ?: return
        if (rank(current.deliveryState) >= rank(state) && transport == null) return
        val updated = current.copy(deliveryState = if (rank(current.deliveryState) > rank(state)) current.deliveryState else state, transport = transport ?: current.transport)
        messages[updated.messageId] = updated
        store.updateMessage(updated.messageId, deliveryState = updated.deliveryState, transport = updated.transport)
    }

    private fun rank(state: DeliveryState) = when (state) {
        DeliveryState.QUEUED -> 0
        DeliveryState.FAILED -> 0
        DeliveryState.SENT -> 1
        DeliveryState.DELIVERED -> 2
        DeliveryState.READ -> 3
    }

    /** A group message shows one tick: the weakest recipient. The detail is "Delivered to 3 of 5". */
    private suspend fun refreshGroupMessage(messageId: String) {
        val message = messages[messageId] ?: return
        val rows = outbox.values.filter { it.messageId == messageId }
        val state = when {
            rows.isEmpty() -> DeliveryState.DELIVERED
            rows.any { it.deliveryState == DeliveryState.FAILED } -> DeliveryState.FAILED
            rows.any { it.deliveryState == DeliveryState.SENT } -> DeliveryState.SENT
            else -> DeliveryState.QUEUED
        }
        val total = message.totalRecipients
        val (delivered, _) = groupDeliveryDetail(total, rows.size)
        val updated = message.copy(deliveryState = state, deliveredTo = delivered)
        messages[messageId] = updated
        if (state != message.deliveryState) store.updateMessage(messageId, deliveryState = state)
    }

    private fun flushUndelivered() {
        val recipients = outbox.values.map { it.recipientId }.toSet()
        for (uid in recipients) if (links[uid]?.session?.isReady == true) scope.launch { deliverTo(uid) }
    }

    // ---------------------------------------------------------------------
    // Clearing
    // ---------------------------------------------------------------------

    private suspend fun clearConversationData(conversationId: String) {
        store.clearConversation(conversationId)
        messages.values.removeAll { it.conversationId == conversationId }
        outbox.values.removeAll { row -> row.messageId !in messages }
    }

    suspend fun clearChat(conversationId: String) {
        clearConversationData(conversationId)
        links[conversationId]?.lastReadWritten = null
        emit()
        say("The chat was cleared on this phone.")
    }

    suspend fun clearLocalData() {
        store.clearAll()
        messages.clear()
        outbox.clear()
        links.values.forEach { it.sent.clear(); it.lastReadWritten = null }
        emit()
        say("All messages and the send queue were cleared on this phone.")
    }

    // ---------------------------------------------------------------------
    // Links
    // ---------------------------------------------------------------------

    private fun ensureLink(uid: String): Link {
        links[uid]?.let { return it }
        val binding = Binding(uid)
        val link = Link(binding, newSession(binding))
        links[uid] = link
        return link
    }

    private fun pinnedFor(binding: Binding): PinnedPeer? {
        val friend = binding.uid?.let { friends[it] } ?: return null
        return PinnedPeer(friend.uid, "card", friend.card.sign, friend.card.dh)
    }

    private fun newSession(binding: Binding): PeerSession = PeerSession(
        scope = scope,
        conversationId = handshakeId,
        selfUid = selfUid,
        identityManager = identityManager,
        identity = { identity },
        pinned = { pinnedFor(binding) },
        pinPeer = { uid, _, _, _ -> scope.launch { onPinRequested(binding, uid) } },
        iceServers = { networkConfig().iceServers() },
        forceRelay = { networkConfig().forceRelay },
        listener = object : com.duochat.app.p2p.PeerSession.Listener {
            override fun onStateChanged(state: P2PState, connected: Boolean, trust: PeerTrust, safetyNumber: String?, peerUid: String?) {
                scope.launch { onLinkState(binding, state, connected, trust, safetyNumber) }
            }

            override fun onNotice(message: String) {
                scope.launch { say(message) }
            }

            override fun onFailure(message: String) {
                scope.launch {
                    say(message)
                    onLinkState(binding, P2PState.FAILED, false, PeerTrust.NONE, null)
                }
            }

            override fun onPeerMessage(message: ChatMessage) {
                scope.launch { binding.uid?.let { handleDirectMessage(it, message) } }
            }

            override fun onAck(messageId: String, state: DeliveryState, at: Long) {
                scope.launch { binding.uid?.let { handleAck(it, messageId, state, at) } }
            }

            override fun onRead(lastReadMessageId: String) {
                scope.launch { binding.uid?.let { applyPeerReadThrough(it, lastReadMessageId) } }
            }

            override fun onFrame(frame: JSONObject) {
                scope.launch { binding.uid?.let { handleFrame(it, frame) } }
            }
        },
    )

    private fun closeLink(link: Link) {
        link.offerTimeout?.cancel()
        link.pathJob?.cancel()
        link.session.close()
        link.p2pState = P2PState.IDLE
        link.ready = false
        link.path = null
        link.sent.clear()
    }

    private fun linkOf(binding: Binding): Link? = binding.uid?.let { links[it] } ?: manualLink?.takeIf { it.binding === binding }

    private suspend fun onLinkState(binding: Binding, state: P2PState, connected: Boolean, trust: PeerTrust, safetyNumber: String?) {
        val link = linkOf(binding) ?: return
        val wasReady = link.ready
        link.ready = connected
        link.p2pState = state
        link.trust = trust
        if (link.binding.uid == null) {
            _state.update {
                it.copy(manual = ManualState(state, connected, trust, safetyNumber))
            }
        } else {
            if (state != P2PState.CONNECTED) link.path = null
            if (state == P2PState.CONNECTED) detectPath(link)
            if (connected && !wasReady) onChannelReady(link.binding.uid!!)
            if (!connected) link.sent.clear()
            refreshBluetooth()
        }
        emit()
    }

    /** Reads the real route (host / srflx / relay) once the channel is up; retries while stats settle. */
    private fun detectPath(link: Link) {
        link.pathJob?.cancel()
        link.pathJob = scope.launch {
            for (attempt in 1..5) {
                delay(400L * attempt)
                val path = link.session.connectionPath()
                if (path != null) {
                    link.path = path
                    emit()
                    return@launch
                }
            }
        }
    }

    /** The link to [uid] is authenticated: learn missing identity data, sync groups, send what is queued. */
    private suspend fun onChannelReady(uid: String) {
        val link = links[uid] ?: return
        link.attempt = 0
        link.bleAttempt = 0
        link.offerTimeout?.cancel()
        link.sent.clear()
        link.lastReadWritten = null
        if (bleUid == uid) bleSearch?.cancel()
        val friend = friends[uid]
        val peerCard = link.session.peerCard()
        if (friend != null && peerCard != null && friend.card.proof.isEmpty()) {
            // Friends migrated from the single-friend version have no identity proof yet; the handshake just verified it.
            friend.card = peerCard.copy(name = friend.card.name)
            store.setContactProof(uid, peerCard.proof)
        }
        assemblers[uid]?.clear()
        link.session.sendJson(privacyFrame())
        coordinator?.onLinkOpen(uid)?.forEach { sendFrame(it) }
        deliverTo(uid)
        if (openChat == uid && appVisible) markRead(uid)
    }

    /** Called for the manual flow (user confirmed a safety number) and when a verified reconnect refreshes the pin. */
    private suspend fun onPinRequested(binding: Binding, uid: String) {
        if (binding.uid != null) return // a saved friend reconnecting: nothing to change
        val pairing = manualLink?.takeIf { it.binding === binding } ?: return
        val card = pairing.session.peerCard() ?: return
        if (uid == selfUid) return
        val friend = friends[uid] ?: Friend(
            uid, "Friend ${uid.take(4)}", card, ContactTrust.VERIFIED, null, null, System.currentTimeMillis(),
        ).also { friends[uid] = it }
        friend.card = card.copy(name = friend.card.name)
        friend.trust = ContactTrust.VERIFIED
        friend.checkedAt = System.currentTimeMillis()
        store.putContact(entityFrom(friend))
        // The session that just proved itself becomes this friend's link.
        links.remove(uid)?.let { closeLink(it) }
        binding.uid = uid
        manualLink = null
        links[uid] = pairing
        _state.update { it.copy(manual = ManualState()) }
        startSignaling(force = true)
        say("${friend.name} was added.")
        emit()
    }

    /** The user compared the safety number of a manual connection. */
    fun confirmManual() {
        manualLink?.session?.confirmPeer()
    }

    // ---------------------------------------------------------------------
    // Incoming messages and frames
    // ---------------------------------------------------------------------

    private suspend fun handleDirectMessage(uid: String, message: ChatMessage) {
        val link = links[uid] ?: return
        if (!link.session.isReady || message.senderId != uid || !friends.containsKey(uid)) return
        // People we only know through a group can message the group, not us, if we chose to stay group-only.
        if (!acceptsDirectFrom(uid)) {
            link.session.sendJson(declinedFrame(message.messageId, DeclineReason.DIRECT_NOT_ACCEPTED))
            return
        }
        ingest(message.copy(conversationId = uid), uid) { ack -> link.session.sendJson(ack) }
    }

    /** Store a message from a friend, acknowledge it, notify. Shared by the direct, group and relay paths. */
    private suspend fun ingest(message: ChatMessage, fromUid: String, sendAck: (JSONObject) -> Unit) {
        val existing = messages[message.messageId]
        val merged = if (existing != null) {
            existing.copy(
                deliveryState = if (rank(existing.deliveryState) >= rank(message.deliveryState)) existing.deliveryState else message.deliveryState,
                readAt = existing.readAt ?: message.readAt,
            )
        } else {
            message
        }
        messages[merged.messageId] = merged
        store.putMessage(merged)
        sendAck(
            JSONObject().put("v", 1).put("kind", "ack").put("messageId", merged.messageId)
                .put("state", "DELIVERED").put("at", System.currentTimeMillis()),
        )
        emit()
        if (existing == null) notifyIncoming(merged, fromUid)
        if (openChat == merged.conversationId && appVisible) markRead(merged.conversationId)
    }

    private fun notifyIncoming(message: ChatMessage, fromUid: String) {
        if (isMuted(message.conversationId)) return
        if (appVisible && openChat == message.conversationId) return
        val group = coordinator?.state(message.conversationId)
        val title = if (group != null) group.name else nameOf(fromUid)
        val text = if (message.type == MessageType.FILE) filePreviewText(message.text) else message.text
        val body = if (group != null) "${nameOf(fromUid)}: $text" else text
        onNotify(IncomingNotice(message.messageId, message.conversationId, title, body))
    }

    private suspend fun handleFrame(fromUid: String, frame: JSONObject) {
        if (!friends.containsKey(fromUid)) return
        when (frame.optString("kind")) {
            "privacy" -> {
                (frame.opt("groupOnly") as? Boolean)?.let { peerGroupOnly[fromUid] = it; emit() }
                return
            }
            "declined" -> {
                parseDeclined(frame)?.let { (id, reason) -> handleDeclined(fromUid, id, reason) }
                return
            }
            "file_offer" -> {
                FileOffer.parse(frame)?.let { receiveOffer(fromUid, it) }
                return
            }
            "file_chunk" -> {
                FileChunk.parse(frame)?.let { receiveChunk(fromUid, it) }
                return
            }
        }
        val parsed = parseGroupFrame(frame) ?: return
        val coordinator = coordinator ?: return
        when (parsed) {
            is GroupFrame.Message -> {
                val message = ChatMessage(
                    messageId = parsed.messageId, clientMessageId = parsed.messageId, senderId = fromUid, text = parsed.text,
                    clientCreatedAt = parsed.clientCreatedAt, transport = TransportKind.P2P,
                    deliveryState = DeliveryState.DELIVERED, conversationId = parsed.groupId,
                    replyTo = parsed.replyTo,
                )
                if (messages.containsKey(message.messageId)) {
                    // Duplicate (resend after a lost ack): just acknowledge again.
                    links[fromUid]?.session?.sendJson(
                        JSONObject().put("v", 1).put("kind", "ack").put("messageId", message.messageId)
                            .put("state", "DELIVERED").put("at", System.currentTimeMillis()),
                    )
                    return
                }
                when (coordinator.checkMessage(fromUid, parsed.groupId)) {
                    MessageVerdict.OK -> acceptGroupMessage(fromUid, message)
                    else -> {
                        // We may just be behind: hold it for up to 60 s and ask the sender for the group's history.
                        if (pendingGroup.hold(parsed.groupId, fromUid, message, System.currentTimeMillis())) {
                            coordinator.requestSync(fromUid, parsed.groupId).forEach { sendFrame(it) }
                        }
                    }
                }
            }
            is GroupFrame.RelayBlob -> handleRelay(fromUid, parsed)
            else -> applyGroupResult(coordinator.handle(fromUid, parsed), fromUid)
        }
    }

    private suspend fun handleDeclined(uid: String, messageId: String, reason: DeclineReason) {
        val row = outbox["$messageId|$uid"] ?: return
        val who = nameOf(uid)
        if (reason == DeclineReason.DIRECT_NOT_ACCEPTED && friends[uid]?.trust == ContactTrust.INTRODUCED) peerGroupOnly[uid] = true
        failRow(
            row,
            when (reason) {
                DeclineReason.DIRECT_NOT_ACCEPTED -> "$who stays group-only, so this was not delivered. You can still talk in your groups, or swap invites to message directly."
                DeclineReason.TOO_LARGE -> "$who refused the file because it is too large."
                DeclineReason.BUSY -> "$who is receiving other files right now. Try again in a moment."
                DeclineReason.BAD_FILE -> "$who could not receive the file."
            },
        )
    }

    private fun assembler(uid: String): FileAssembler = assemblers.getOrPut(uid) { FileAssembler() }

    private fun receiveOffer(uid: String, offer: FileOffer) {
        val link = links[uid] ?: return
        fun decline(reason: DeclineReason) { link.session.sendJson(declinedFrame(offer.messageId, reason)) }
        val groupId = offer.groupId
        if (groupId != null) {
            if (coordinator?.checkMessage(uid, groupId) != MessageVerdict.OK) return decline(DeclineReason.BAD_FILE)
        } else if (!acceptsDirectFrom(uid)) {
            return decline(DeclineReason.DIRECT_NOT_ACCEPTED)
        }
        if (offer.size > MAX_FILE_BYTES) return decline(DeclineReason.TOO_LARGE)
        // Already have it (the sender is retrying after a dropped link): just confirm.
        if (messages.containsKey(offer.messageId)) {
            link.session.sendJson(
                JSONObject().put("v", 1).put("kind", "ack").put("messageId", offer.messageId)
                    .put("state", "DELIVERED").put("at", System.currentTimeMillis()),
            )
            return
        }
        assembler(uid).begin(offer)?.let { return decline(it) }
        lastChunkAt[uid] = System.currentTimeMillis()
    }

    private suspend fun receiveChunk(uid: String, chunk: FileChunk) {
        val link = links[uid] ?: return
        lastChunkAt[uid] = System.currentTimeMillis()
        val asm = assembler(uid)
        if (asm.progress(chunk.messageId) == null) return // not a transfer we accepted
        when (val result = asm.chunk(chunk)) {
            is AssembleResult.More -> {
                if (chunk.index % PROGRESS_EVERY == 0) {
                    progress[chunk.messageId] = (asm.progress(chunk.messageId) ?: 0.0).toFloat()
                    emit()
                }
            }
            is AssembleResult.Failed -> {
                progress.remove(chunk.messageId)
                link.session.sendJson(declinedFrame(chunk.messageId, result.reason))
                emit()
            }
            is AssembleResult.Done -> {
                progress.remove(chunk.messageId)
                val offer = result.offer
                val convId = offer.groupId ?: uid
                if (offer.groupId != null && coordinator?.checkMessage(uid, offer.groupId) != MessageVerdict.OK) return
                withContext(Dispatchers.IO) { store.putFile(offer.messageId, result.bytes) }
                ingest(
                    ChatMessage(
                        messageId = offer.messageId, clientMessageId = offer.messageId, senderId = uid, text = offer.name,
                        clientCreatedAt = offer.clientCreatedAt, transport = TransportKind.P2P,
                        deliveryState = DeliveryState.DELIVERED, conversationId = convId,
                        type = MessageType.FILE, replyTo = offer.replyTo,
                        file = FileMeta(offer.name, offer.mime, offer.size, offer.sha256),
                    ),
                    uid,
                ) { ack -> link.session.sendJson(ack) }
            }
        }
    }

    private suspend fun acceptGroupMessage(fromUid: String, message: ChatMessage) {
        val link = links[fromUid] ?: return
        ingest(message, fromUid) { ack -> link.session.sendJson(ack) }
    }

    private suspend fun handleAck(uid: String, messageId: String, state: DeliveryState, at: Long) {
        val message = messages[messageId] ?: return
        if (message.senderId != selfUid) return
        val row = outbox.remove("$messageId|$uid")
        if (row != null) store.removeOutbox(messageId, uid)
        if (coordinator?.state(message.conversationId) != null) {
            refreshGroupMessage(messageId)
        } else {
            val next = if (state == DeliveryState.READ || message.deliveryState == DeliveryState.READ) DeliveryState.READ else DeliveryState.DELIVERED
            val updated = message.copy(deliveryState = next, readAt = if (state == DeliveryState.READ) at else message.readAt)
            messages[messageId] = updated
            store.updateMessage(messageId, deliveryState = updated.deliveryState, readAt = updated.readAt, setReadAt = updated.readAt != null)
        }
        emit()
    }

    private suspend fun applyPeerReadThrough(uid: String, messageId: String) {
        val ordered = conversation(uid)
        val index = ordered.indexOfFirst { it.messageId == messageId }
        if (index < 0) return
        val now = System.currentTimeMillis()
        var changed = false
        for (i in 0..index) {
            val message = ordered[i]
            if (message.senderId != selfUid || message.deliveryState == DeliveryState.READ) continue
            val updated = message.copy(deliveryState = DeliveryState.READ, readAt = message.readAt ?: now)
            messages[updated.messageId] = updated
            store.updateMessage(updated.messageId, deliveryState = DeliveryState.READ, readAt = updated.readAt, setReadAt = true)
            if (outbox.remove("${updated.messageId}|$uid") != null) store.removeOutbox(updated.messageId, uid)
            changed = true
        }
        if (changed) emit()
    }

    private suspend fun markRead(conversationId: String) {
        val ordered = conversation(conversationId)
        val last = ordered.lastOrNull { it.senderId != selfUid } ?: return
        val now = System.currentTimeMillis()
        var changed = false
        for (message in ordered) {
            if (message.senderId == selfUid || message.readAt != null) continue
            messages[message.messageId] = message.copy(readAt = now)
            store.updateMessage(message.messageId, readAt = now, setReadAt = true)
            changed = true
        }
        if (changed) emit()
        val link = links[conversationId] // read receipts are for direct chats only
        if (link != null && link.lastReadWritten != last.messageId && link.session.isReady) {
            link.lastReadWritten = last.messageId
            link.session.sendJson(JSONObject().put("v", 1).put("kind", "read").put("lastReadMessageId", last.messageId).put("at", now))
        }
    }

    private fun conversation(id: String): List<ChatMessage> =
        messages.values.filter { it.conversationId == id }.sortedWith { a, b -> compareMessages(a, b) }

    private fun sendFrame(out: OutgoingFrame) {
        val link = links[out.to] ?: return
        if (link.session.isReady) link.session.sendJson(out.frame.toJson())
    }

    // ---------------------------------------------------------------------
    // Signaling: find friends again without typing codes
    // ---------------------------------------------------------------------

    /** Apply changed STUN/TURN/signaling settings; they take effect on the next connection. */
    fun reloadNetwork() {
        startSignaling(force = true)
        say("Network settings applied. They take effect on the next connection.")
    }

    /** The device gained a network: reconnect the signaling sockets now instead of waiting out the backoff. */
    fun onNetworkAvailable() {
        if (stopped || identity == null) return
        for (link in links.values) {
            link.attempt = 0
            link.lastOfferAt = 0
        }
        if (hub?.status() != SignalingStatus.ONLINE) startSignaling(force = true)
    }

    private fun startSignaling(force: Boolean = false) {
        if (stopped || identity == null) return
        if (hub != null && !force) return
        hub?.stop()
        hub = null
        val config = networkConfig()
        if (friends.isEmpty() || config.signaling.isEmpty()) {
            _state.update { it.copy(signaling = SignalingStatus.IDLE) }
            return
        }
        val created = SignalingHub(transportsFor(config, scope))
        hub = created
        created.start(Seal.mailboxFor(selfUid)) { blob, id, via -> scope.launch { handleBlob(blob, id, via) } }
        for (link in links.values) {
            link.attempt = 0
            link.lastOfferAt = 0
        }
        _state.update { it.copy(signaling = created.status()) }
    }

    private fun sealTo(friend: Friend, payload: JSONObject): SealedBlob =
        Seal.seal(payload, selfUid, friend.uid, friend.card.dh) { identityManager.signRaw(it) }

    /**
     * Send a sealed payload to a friend through the signaling hub. If signaling is unreachable, or the last attempts
     * got nowhere, also hand the blob to mutual friends who are linked to us so they can pass it on.
     */
    private suspend fun putToFriend(uid: String, payload: JSONObject, kind: String, ttlSec: Int) {
        val friend = friends[uid] ?: throw IllegalStateException("Unknown friend.")
        val blob = sealTo(friend, payload)
        val current = hub
        var delivered = false
        var failure: Exception? = null
        if (current != null && current.status() == SignalingStatus.ONLINE) {
            try {
                current.put(Seal.mailboxFor(uid), blob, kind, ttlSec)
                delivered = true
            } catch (e: Exception) {
                failure = e
            }
        }
        if (kind == "msg" && meshInject(blob)) delivered = true
        val struggling = (links[uid]?.attempt ?: 0) >= 2
        if (kind == "sig" && (!delivered || struggling)) {
            if (relayThroughLinks(blob, uid, 0, exclude = null)) delivered = true
        }
        if (!delivered) throw failure ?: IllegalStateException("No signaling is available.")
    }

    /** Pass a sealed blob to up to three linked friends, preferring people who share a group with [target]. */
    private fun relayThroughLinks(blob: SealedBlob, target: String, hops: Int, exclude: String?): Boolean {
        val ready = links.filter { (uid, link) -> uid != target && uid != exclude && link.session.isReady }.keys
        if (ready.isEmpty()) return false
        val coordinator = coordinator
        val shared = ready.filter { uid ->
            coordinator?.myGroups()?.any { it.members.containsKey(uid) && it.members.containsKey(target) } == true
        }
        val chosen = (shared + (ready - shared.toSet())).take(3)
        val frame = GroupFrame.RelayBlob(blob.toJson(), hops).toJson()
        var sent = false
        for (uid in chosen) if (links[uid]?.session?.sendJson(frame) == true) sent = true
        return sent
    }

    private suspend fun handleRelay(fromUid: String, frame: GroupFrame.RelayBlob) {
        val link = links[fromUid] ?: return
        // A friend may relay a handful of blobs per minute; more is spam.
        val now = System.currentTimeMillis()
        while (link.relayWindow.isNotEmpty() && now - link.relayWindow.first() > 60_000L) link.relayWindow.removeFirst()
        if (link.relayWindow.size >= MAX_RELAYS_PER_MINUTE) return
        link.relayWindow.addLast(now)
        val blob = sealedBlobFromJson(frame.blob) ?: return
        if (!seenBlobs.firstTime(blob.sig)) return
        if (blob.to == selfUid) {
            handleBlob(blob, "", null)
            return
        }
        if (frame.hops >= MAX_RELAY_HOPS) return
        val target = links[blob.to]
        if (target != null && target.session.isReady) {
            target.session.sendJson(GroupFrame.RelayBlob(frame.blob, frame.hops + 1).toJson())
        } else {
            relayThroughLinks(blob, blob.to, frame.hops + 1, exclude = fromUid)
        }
    }

    private suspend fun handleBlob(blob: SealedBlob, id: String, via: SignalingTransport?) {
        val friend = friends[blob.from] ?: return
        val payload = Seal.open(blob, selfUid, identityManager::dhAgree, friend.card.sign, friend.uid) ?: return
        val link = ensureLink(friend.uid)
        try {
            when (payload.optString("t")) {
                "ready" -> if (isInitiator(selfUid, friend.uid)) link.lastOfferAt = 0
                "offer" -> {
                    val sdp = payload.optString("sdp")
                    if (isInitiator(selfUid, friend.uid) || link.session.isReady || sdp.isEmpty()) return
                    if (!LinkScheduler.acceptIncoming(links.values.count { it.session.isReady })) return
                    link.session.setExpectedPeerKey(null)
                    val answer = link.session.acceptOffer(sdp)
                    putToFriend(friend.uid, JSONObject().put("t", "answer").put("sdp", answer), "sig", SIGNAL_TTL_SEC)
                    armOfferTimeout(friend.uid)
                }
                "answer" -> {
                    val sdp = payload.optString("sdp")
                    if (!isInitiator(selfUid, friend.uid) || !link.session.hasPendingConnection || link.session.isReady || sdp.isEmpty()) return
                    link.session.applyAnswer(sdp)
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
                            messageId = messageId, clientMessageId = messageId, senderId = friend.uid, text = text,
                            clientCreatedAt = at, transport = TransportKind.RELAY, deliveryState = DeliveryState.DELIVERED,
                            conversationId = friend.uid,
                        ),
                        friend.uid,
                    ) {
                        scope.launch {
                            runCatching { putToFriend(friend.uid, JSONObject().put("t", "ack").put("id", messageId), "msg", MSG_TTL_SEC) }
                        }
                    }
                    if (via != null) hub?.remove(via, Seal.mailboxFor(selfUid), id)
                }
                "ack" -> {
                    val messageId = payload.optString("id")
                    val message = messages[messageId] ?: return
                    if (message.senderId != selfUid) return
                    handleAck(friend.uid, messageId, DeliveryState.DELIVERED, System.currentTimeMillis())
                    if (via != null) hub?.remove(via, Seal.mailboxFor(selfUid), id)
                }
            }
        } catch (error: Exception) {
            say("Could not reach ${friend.name} yet. Retrying...")
        }
    }

    private fun armOfferTimeout(uid: String) {
        val link = links[uid] ?: return
        link.offerTimeout?.cancel()
        link.offerTimeout = scope.launch {
            delay(OFFER_TIMEOUT_MS)
            if (!link.session.isReady && !link.session.isBluetooth) {
                closeLink(link)
                link.p2pState = P2PState.FAILED
                emit()
            }
        }
    }

    // ---------------------------------------------------------------------
    // Ticking: reconnect, flush, liveness is per link inside PeerSession
    // ---------------------------------------------------------------------

    private fun startTicking() {
        tickJob?.cancel()
        tickJob = scope.launch {
            while (!stopped) {
                delay(TICK_MS)
                _state.update { it.copy(signaling = hub?.status() ?: SignalingStatus.IDLE) }
                dropBluetoothIfDisabled()
                pendingGroup.expire(System.currentTimeMillis())
                val nowMs = System.currentTimeMillis()
                for ((uid, asm) in assemblers) {
                    if (asm.activeCount > 0 && nowMs - (lastChunkAt[uid] ?: 0L) > STALL_MS) asm.clear()
                }
                flushUndelivered()
                connectDueLinks()
                maybeBluetooth()
                relayPending()
                meshPending()
                refreshBluetooth()
                emit()
            }
        }
    }

    /** Reach out to friends we are not linked to: at most [com.duochat.app.data.MAX_CONNECTING] at once, each with its own backoff. */
    private suspend fun connectDueLinks() {
        val current = hub
        val hubOnline = current != null && current.status() == SignalingStatus.ONLINE
        val canRelay = links.values.any { it.session.isReady }
        if (!hubOnline && !canRelay) return
        val infos = links.map { (uid, link) ->
            LinkInfo(
                uid, link.session.isReady,
                link.p2pState == P2PState.CONNECTING || link.session.isBluetooth && link.session.isOpen && !link.session.isReady,
                link.lastOfferAt, link.attempt, dialable = friends.containsKey(uid),
            )
        }
        val now = System.currentTimeMillis()
        for (uid in LinkScheduler.due(infos, now)) {
            val link = links[uid] ?: continue
            link.lastOfferAt = now
            link.attempt += 1
            try {
                if (!isInitiator(selfUid, uid)) {
                    // Tell the friend we are online so they can offer straight away.
                    putToFriend(uid, JSONObject().put("t", "ready"), "sig", SIGNAL_TTL_SEC)
                    continue
                }
                link.session.setExpectedPeerKey(null)
                val sdp = link.session.createOffer()
                putToFriend(uid, JSONObject().put("t", "offer").put("sdp", sdp), "sig", SIGNAL_TTL_SEC)
                armOfferTimeout(uid)
            } catch (error: Exception) {
                closeLink(link)
            }
        }
    }

    // ---------------------------------------------------------------------
    // Manual connection codes (Advanced): pair without any signaling
    // ---------------------------------------------------------------------

    private fun checkSignalIdentity(signal: ManualSignal) {
        if (signal.fromUid == selfUid) throw IllegalArgumentException("This code was created on this device.")
        if (!identityManager.verifyIdentityProof(signal.publicKeyJwk, signal.dhJwk, signal.identityProof)) {
            throw IllegalArgumentException("This connection code is corrupted: its identity proof is invalid.")
        }
        if (identityManager.uidFor(signal.dhJwk) != signal.fromUid) {
            throw IllegalArgumentException("This connection code is corrupted: its identity does not match its key.")
        }
        val known = friends[signal.fromUid]
        if (known != null && !identityManager.publicKeysEqual(known.card.sign, signal.publicKeyJwk)) {
            throw IllegalArgumentException("This code comes from a different device than the one you saved as ${known.name}.")
        }
    }

    private fun localSignal(kind: String, sdp: String, current: DeviceIdentity) = ManualSignal(
        kind = kind, conversationId = handshakeId, fromUid = current.uid, fromDeviceId = current.deviceId,
        publicKeyJwk = current.publicJwk, dhJwk = current.dhJwk, identityProof = current.identityProof,
        sdp = sdp, nonce = randomNonce(), createdAt = System.currentTimeMillis(),
    )

    /** The pairing slot: a session that is not tied to a saved friend until its safety number is confirmed. */
    private fun pairingLink(replace: Boolean): Link {
        val existing = manualLink
        if (existing != null && !replace) return existing
        existing?.session?.close()
        val binding = Binding(null)
        return Link(binding, newSession(binding)).also { manualLink = it }
    }

    suspend fun createManualOffer(): String {
        val current = identity ?: throw IllegalStateException("Identity is not ready.")
        val pairing = pairingLink(replace = true)
        pairing.session.setExpectedPeerKey(null)
        return try {
            ManualSignalCodec.encode(localSignal("offer", pairing.session.createOffer(), current))
        } catch (error: Exception) {
            pairing.session.close()
            throw error
        }
    }

    suspend fun applyManualAnswer(code: String) {
        val decoded = ManualSignalCodec.decode(code, handshakeId)
        if (decoded.kind != "answer") throw IllegalArgumentException("This code is an offer. The other user must paste your offer and send back an answer.")
        checkSignalIdentity(decoded)
        val pairing = manualLink ?: throw IllegalStateException("Create an offer before pasting an answer.")
        if (!pairing.session.hasPendingConnection) throw IllegalStateException("Create an offer before pasting an answer.")
        pairing.session.setExpectedPeerKey(decoded.publicKeyJwk)
        pairing.session.applyAnswer(decoded.sdp)
    }

    suspend fun acceptManualOffer(code: String): String {
        val current = identity ?: throw IllegalStateException("Identity is not ready.")
        val decoded = ManualSignalCodec.decode(code, handshakeId)
        if (decoded.kind != "offer") throw IllegalArgumentException("This code is an answer. Paste the offer from the other user instead.")
        checkSignalIdentity(decoded)
        val pairing = pairingLink(replace = true)
        pairing.session.setExpectedPeerKey(decoded.publicKeyJwk)
        return try {
            ManualSignalCodec.encode(localSignal("answer", pairing.session.acceptOffer(decoded.sdp), current))
        } catch (error: Exception) {
            pairing.session.close()
            throw error
        }
    }

    fun cancelManual() {
        manualLink?.session?.close()
        manualLink = null
        _state.update { it.copy(manual = ManualState()) }
    }

    // ---------------------------------------------------------------------
    // Bluetooth LE: works with no internet, within radio range. UNTESTED on a real radio.
    // ---------------------------------------------------------------------

    fun refreshBluetooth() {
        val bleLink = bleUid?.let { links[it] }?.takeIf { it.session.isBluetooth }
        val any = links.values.firstOrNull { it.session.isBluetooth }
        val status = bluetoothStatusFor(
            enabledInSettings = networkConfig().bluetooth,
            hasEnvironment = ble != null,
            linkIsBluetooth = (bleLink ?: any) != null,
            linkReady = (bleLink ?: any)?.session?.isReady == true,
            availability = ble?.availability(),
            paired = friends.isNotEmpty(),
        )
        if (_state.value.bluetooth != status) _state.update { it.copy(bluetooth = status) }
    }

    /**
     * Looks for [uid] over Bluetooth for [BLE_SEARCH_MS]. Only one Bluetooth search or link at a time (the radio
     * code was written for one). Never prompts for permissions: when missing it fails with a message and the UI asks.
     */
    suspend fun connectBluetooth(uid: String, manual: Boolean = true): Result<Unit> {
        val failure = { message: String -> Result.failure<Unit>(IllegalStateException(message)) }
        val environment = ble ?: return failure("Bluetooth is not available in this build.")
        val current = identity ?: return failure("Identity is not ready yet.")
        val friend = friends[uid] ?: return failure("Add your friend first.")
        val link = ensureLink(uid)
        if (link.session.isReady) return Result.success(Unit)
        if (bleUid != null && bleUid != uid && links[bleUid]?.session?.isBluetooth == true) return failure("Bluetooth is already in use for another friend.")
        when (environment.availability()) {
            BleAvailability.UNSUPPORTED -> return failure("This phone has no Bluetooth LE.")
            BleAvailability.NEEDS_PERMISSION -> return failure("Bluetooth permission is needed. Allow it in Settings.")
            BleAvailability.ADAPTER_OFF -> return failure("Bluetooth is off. Turn it on, then try again.")
            BleAvailability.READY -> Unit
        }
        return try {
            val secret = identityManager.dhAgree(friend.card.dh)
            bleManualAttempt = manual
            bleUid = uid
            val created = link.session.newBluetoothLink { handlers ->
                environment.createLink(
                    secret = secret,
                    // Two phones: the lower uid scans, the higher one is found. A desktop is always the scanner.
                    initiateAsCentral = current.uid < uid,
                    ownUid = current.uid,
                    peerUid = uid,
                    sign = identityManager::signRaw,
                    peerSign = friend.card.sign,
                    handlers = handlers,
                )
            }
            created.start()
            armBluetoothSearch(uid)
            refreshBluetooth()
            Result.success(Unit)
        } catch (error: Exception) {
            closeLink(link)
            bleUid = null
            failure("Bluetooth could not start: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    private fun armBluetoothSearch(uid: String) {
        bleSearch?.cancel()
        bleSearch = scope.launch {
            delay(BLE_SEARCH_MS)
            val link = links[uid]
            if (link != null && link.session.isBluetooth && !link.session.isAuthenticated) {
                closeLink(link)
                bleUid = null
                say(if (bleManualAttempt) "No friend found nearby over Bluetooth. Check that they have DuoChat open with Bluetooth on." else notice.orEmpty())
                emit()
                refreshBluetooth()
            }
        }
    }

    /** Automatic attempts with backoff, round-robin over friends, only when Bluetooth is already allowed and on. */
    private suspend fun maybeBluetooth() {
        val environment = ble ?: return
        if (!networkConfig().bluetooth || friends.isEmpty()) return
        if (links.values.any { it.session.isBluetooth }) return
        if (environment.availability() != BleAvailability.READY) return
        val now = System.currentTimeMillis()
        val target = links.entries
            .filter { !it.value.session.isReady && it.value.p2pState != P2PState.CONNECTING && friends.containsKey(it.key) }
            .filter { now - it.value.lastBleAt >= bleReconnectDelayMs(it.value.bleAttempt) }
            .minByOrNull { it.value.lastBleAt } ?: return
        target.value.lastBleAt = now
        target.value.bleAttempt += 1
        connectBluetooth(target.key, manual = false)
    }

    private fun dropBluetoothIfDisabled() {
        if (networkConfig().bluetooth) return
        for (link in links.values) {
            if (link.session.isBluetooth) closeLink(link)
        }
        bleSearch?.cancel()
        bleUid = null
    }

    // ---------------------------------------------------------------------
    // Optional store-and-forward (off by default; direct chats only)
    // ---------------------------------------------------------------------

    private suspend fun relayPending() {
        val current = hub ?: return
        if (!networkConfig().storeForward || current.status() != SignalingStatus.ONLINE) return
        for (row in outbox.values.toList()) {
            val message = messages[row.messageId] ?: continue
            if (message.senderId != selfUid || !needsDelivery(message.deliveryState)) continue
            if (coordinator?.state(message.conversationId) != null) continue
            if (links[row.recipientId]?.session?.isReady == true) continue
            if (!relayed.add(row.key)) continue
            try {
                putToFriend(
                    row.recipientId,
                    JSONObject().put("t", "msg").put("id", message.messageId).put("text", message.text).put("at", message.clientCreatedAt),
                    "msg", MSG_TTL_SEC,
                )
                messages[message.messageId] = message.copy(transport = TransportKind.RELAY, deliveryState = DeliveryState.SENT)
                store.updateMessage(message.messageId, deliveryState = DeliveryState.SENT, transport = TransportKind.RELAY)
                emit()
            } catch (_: Exception) {
                relayed.remove(row.key)
            }
        }
    }

    // ---------------------------------------------------------------------
    // Presentation
    // ---------------------------------------------------------------------

    private fun linkStatus(uid: String): LinkStatus {
        val link = links[uid] ?: return LinkStatus.OFFLINE
        return when {
            link.session.isReady -> LinkStatus.CONNECTED
            link.p2pState == P2PState.CONNECTING -> LinkStatus.CONNECTING
            else -> LinkStatus.OFFLINE
        }
    }

    private fun emit() {
        val current = identity ?: return
        val coordinator = coordinator
        val byConversation = messages.values.filter { it.senderId !in muted }.groupBy { it.conversationId }
            .mapValues { (_, list) -> list.sortedWith { a, b -> compareMessages(a, b) } }
        val pendingByMessage = outbox.values.groupingBy { it.messageId }.eachCount()
        val shaped = byConversation.mapValues { (_, list) ->
            list.map { m ->
                if (m.totalRecipients > 0 && m.senderId == selfUid) {
                    m.copy(deliveredTo = groupDeliveryDetail(m.totalRecipients, pendingByMessage[m.messageId] ?: 0).first)
                } else m
            }
        }
        val contacts = friends.values.sortedBy { it.name.lowercase() }.map { f ->
            ContactView(
                f.uid, f.name, f.trust, f.introducedBy?.let { nameOf(it) }, f.checked, linkStatus(f.uid),
                links[f.uid]?.path.takeIf { linkStatus(f.uid) == LinkStatus.CONNECTED },
                runCatching { identityManager.deriveSafetyNumber(current.publicJwk, f.card.sign) }.getOrDefault(""),
                direct = canDirect(f.uid),
            )
        }
        val groups = coordinator?.groupIds().orEmpty().mapNotNull { id ->
            val s = coordinator?.state(id) ?: return@mapNotNull null
            val iAmMember = s.members.containsKey(current.uid)
            val everLeft = !iAmMember
            val members = s.members.values.map { m ->
                MemberView(
                    m.uid, nameOf(m.uid), m.uid == current.uid, m.role == "admin",
                    if (m.addedBy == m.uid) null else nameOf(m.addedBy),
                    friends[m.uid]?.trust, if (m.uid == current.uid) null else linkStatus(m.uid),
                    canMessage = m.uid != current.uid && canDirect(m.uid),
                )
            }.sortedWith(compareBy({ !it.isMe }, { !it.isAdmin }, { it.name.lowercase() }))
            val removedBySomeoneElse = everLeft && coordinator?.let { c ->
                c.exportGroup(id)?.any { e -> e.optString("type") == "remove" && e.optString("target") == current.uid && e.optString("actor") != current.uid } == true
            } == true
            GroupView(
                id, s.name, members, iAmMember, s.members[current.uid]?.role == "admin",
                if (iAmMember) null else if (removedBySomeoneElse) "You were removed" else "You left",
                members.count { it.link == LinkStatus.CONNECTED },
                full = s.members.size >= MAX_GROUP_MEMBERS,
            )
        }.sortedBy { it.name.lowercase() }
        val summaries = ArrayList<ChatSummary>()
        for (c in contacts.filter { it.direct }) {
            val list = shaped[c.uid].orEmpty()
            summaries += ChatSummary(
                c.uid, false, c.name, list.lastOrNull()?.let { previewOf(it) }, list.lastOrNull()?.clientCreatedAt ?: c.uid.let { friends[it]?.createdAt ?: 0L },
                list.count { it.senderId != selfUid && it.readAt == null }, c.link,
                when (c.link) {
                    LinkStatus.CONNECTED -> "Connected"
                    LinkStatus.CONNECTING -> "Connecting…"
                    LinkStatus.OFFLINE -> "Waiting for ${c.name}"
                },
            )
        }
        for (g in groups) {
            val list = shaped[g.groupId].orEmpty()
            val others = g.members.count { !it.isMe }
            summaries += ChatSummary(
                g.groupId, true, g.name, list.lastOrNull()?.let { m -> (if (m.senderId == selfUid) "You" else nameOf(m.senderId)) + ": " + previewOf(m) },
                list.lastOrNull()?.clientCreatedAt ?: 0L, list.count { it.senderId != selfUid && it.readAt == null },
                if (g.connectedCount > 0) LinkStatus.CONNECTED else if (others == 0) LinkStatus.OFFLINE else LinkStatus.OFFLINE,
                g.exitNote ?: "${g.members.size} members" + if (others > 0) " · ${g.connectedCount} connected" else "",
            )
        }
        for ((name, c) in joinedChannels) {
            val list = shaped["chan:$name"].orEmpty().filter { it.senderId !in muted }
            summaries += ChatSummary(
                "chan:$name", true, "# $name",
                list.lastOrNull()?.let { m -> (m.senderName ?: "Someone") + ": " + m.text },
                list.lastOrNull()?.clientCreatedAt ?: 0L, list.count { it.senderId != selfUid && it.readAt == null },
                if (c.hub.status() == SignalingStatus.ONLINE || (meshRadio?.linkCount ?: 0) > 0) LinkStatus.CONNECTED else LinkStatus.OFFLINE,
                "Public channel",
            )
        }
        summaries.sortByDescending { it.lastAt }
        _state.update {
            it.copy(
                contacts = contacts, groups = groups, chats = summaries, messages = shaped,
                queuedCount = outbox.values.count { r -> r.deliveryState != DeliveryState.FAILED },
                transfers = progress.toMap(), groupOnly = groupOnly,
                channels = joinedChannels.map { (name, c) ->
                    ChannelView("chan:$name", name, shaped["chan:$name"].orEmpty().count { m -> m.senderId != selfUid && m.readAt == null }, c.hub.status() == SignalingStatus.ONLINE)
                },
                meshLinks = meshRadio?.linkCount ?: 0,
                requests = requestCards.map { (uid, r) -> InviteRequest(uid, r.first.card.name ?: "Friend ${uid.take(4)}", r.second) },
                linkCount = links.values.count { l -> l.session.isReady },
                notice = notice ?: it.notice,
            )
        }
    }

    private fun previewOf(m: ChatMessage): String = if (m.type == MessageType.FILE) filePreviewText(m.text) else m.text

    private fun randomNonce(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private companion object {
        const val MAX_CHANNELS = 8
        const val PROGRESS_EVERY = 8
        const val STALL_MS = 30_000L
        const val TICK_MS = 4_000L
        const val SIGNAL_TTL_SEC = 120
        const val MSG_TTL_SEC = 7 * 24 * 3600
        const val OFFER_TIMEOUT_MS = 40_000L
        const val MAX_RELAYS_PER_MINUTE = 40

        /** How long one Bluetooth search lasts before backing off (the desktop uses 20 s). */
        const val BLE_SEARCH_MS = 20_000L
    }
}

/** A sealed blob from JSON that already passed `parseGroupFrame`'s shape check. */
internal fun sealedBlobFromJson(json: JSONObject): SealedBlob? = try {
    SealedBlob(
        json.getString("to"), json.getString("from"), json.getJSONObject("epk"),
        json.getString("iv"), json.getString("ct"), json.getString("sig"),
    )
} catch (_: Exception) {
    null
}
