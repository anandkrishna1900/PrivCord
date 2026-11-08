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
import com.duochat.app.data.ConnectionFacts
import com.duochat.app.data.ManualState
import com.duochat.app.data.P2PState
import com.duochat.app.data.PeerTrust
import com.duochat.app.data.diagnoseConnection
import com.duochat.app.data.TransportMode
import com.duochat.app.ble.AndroidBleEnvironment
import com.duochat.app.ble.AndroidMeshRadio
import com.duochat.app.ble.BleAvailability
import com.duochat.app.ble.BleTransport
import com.duochat.app.ble.MeshRadio
import com.duochat.app.ble.bluetoothStatusFor
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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.withTimeoutOrNull
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

    /** Waits for the engine's answer when six words are looked up (it ends with InviteFound or InviteLookupFailed). */
    @Volatile private var lookup: CompletableDeferred<Boolean>? = null
    private val attempts = ConcurrentHashMap<String, Int>()
    private val heardFrom = ConcurrentHashMap<String, Boolean>()
    private val progress = ConcurrentHashMap<String, Float>()

    /** A file that has started to arrive but is not whole yet: shown in its chat with a progress bar. */
    private class Incoming(val conversation: String, val sender: String, val name: String, val size: Long, val since: Long = System.currentTimeMillis())
    private val incoming = ConcurrentHashMap<String, Incoming>()

    private class ManualHold {
        var transport: WebRtcTransport? = null
        var peerCard: String? = null
        var bound: String? = null
        val pending = ArrayDeque<String>()
    }

    private val manual = ManualHold()
    /**
     * Everything that flows INTO the engine from the radio links goes through this one queue, in order: link up and down and
     * every frame. Frames must reach the engine in the order they arrived (a file is chunks, the handshake is a sequence),
     * and the engine's own queue is bounded and refuses when full, so a refused call is retried rather than dropped.
     */
    private sealed class Inbound {
        class Up(val peer: String, val path: PathKind, val kind: LinkKind) : Inbound()
        class Down(val peer: String) : Inbound()
        class Frame(val peer: String, val text: String) : Inbound()
        class MeshUp(val link: String) : Inbound()
        class MeshDown(val link: String) : Inbound()
        class MeshFrame(val link: String, val text: String) : Inbound()
    }

    private val inbound = Channel<Inbound>(Channel.UNLIMITED)
    private var inboundJob: Job? = null

    private suspend fun deliver(block: () -> Unit) {
        var tries = 0
        while (true) {
            try {
                block()
                return
            } catch (busy: uniffi.privcord_ffi.FfiException.Busy) {
                if (++tries > 4000) return // the engine has been busy for 20 s: give up on this one
                delay(5)
            } catch (t: Throwable) {
                return
            }
        }
    }

    private suspend fun handleInbound(e: PrivcordEngine, op: Inbound) {
        when (op) {
            is Inbound.Up -> deliver { e.linkUp(op.peer, op.path, op.kind) }
            is Inbound.Down -> {
                // A transfer cut by the link going down is not coming back as it was: its half-file bubble goes.
                for ((id, f) in incoming.entries.toList()) if (f.conversation == op.peer) { incoming.remove(id); progress.remove(id) }
                deliver { e.linkDown(op.peer) }
            }
            is Inbound.Frame -> deliver { e.frameReceived(op.peer, op.text) }
            is Inbound.MeshUp -> deliver { e.meshLinkUp(op.link) }
            is Inbound.MeshDown -> deliver { e.meshLinkDown(op.link) }
            is Inbound.MeshFrame -> deliver { e.meshFrame(op.link, op.text) }
        }
    }

    /**
     * Frames the engine sends to one friend go out in order, one at a time, waiting while the data channel's buffer is full
     * (a photo is hundreds of chunks; pushing them all at once would overflow it and end the link).
     */
    private inner class Outbound(val peer: String) {
        private val queue = Channel<String>(Channel.UNLIMITED)
        private val enqueued = java.util.concurrent.atomic.AtomicLong()
        private val written = java.util.concurrent.atomic.AtomicLong()
        /** The file being written out: its id, the count at which it is complete, and how many frames it is. */
        @Volatile private var transfer: Triple<String, Long, Long>? = null
        private var lastShown = -1

        /** The engine has just queued a whole file of [frames] frames: show how far the link has got with it. */
        fun beginTransfer(messageId: String, frames: Long) {
            transfer = Triple(messageId, enqueued.get(), frames.coerceAtLeast(1))
            showProgress()
        }

        private fun showProgress() {
            val (id, end, frames) = transfer ?: return
            val left = (end - written.get()).coerceAtLeast(0)
            val percent = (((frames - left).coerceAtLeast(0)) * 100 / frames).toInt().coerceIn(0, 100)
            if (left == 0L) {
                transfer = null
                lastShown = -1
                progress.remove(id)
            } else if (percent - lastShown >= 2 || lastShown < 0) {
                lastShown = percent
                progress[id] = percent / 100f
            } else return
            _state.update { it.copy(transfers = progress.toMap()) }
        }

        private val job = scope.launch(Dispatchers.Default) {
            for (frame in queue) {
                val web = links[peer]
                val ok = if (web != null && web.isOpen) {
                    web.awaitWritable() && web.sendJson(frame)
                } else {
                    bleLinks[peer]?.takeIf { it.isOpen }?.sendJson(frame) == true
                }
                if (ok) {
                    written.incrementAndGet()
                    if (transfer != null) showProgress()
                }
                if (!ok) {
                    transfer?.let { progress.remove(it.first) }
                    transfer = null
                    senders.remove(peer, this@Outbound)
                    inbound.trySend(Inbound.Down(peer))
                    links.remove(peer)?.close()
                    bleLinks.remove(peer)?.close()
                    break
                }
            }
        }

        fun add(frame: String): Boolean = queue.trySend(frame).isSuccess.also { if (it) enqueued.incrementAndGet() }

        fun stop() {
            queue.close()
            job.cancel()
        }
    }

    private val senders = ConcurrentHashMap<String, Outbound>()

    private fun stopSender(peer: String) {
        senders.remove(peer)?.stop()
    }

    private val bleEnv = AndroidBleEnvironment(app)
    private val bleLinks = ConcurrentHashMap<String, BleTransport>()
    private val bleLastAttempt = ConcurrentHashMap<String, Long>()
    private var meshRadio: MeshRadio? = null
    private val links = ConcurrentHashMap<String, WebRtcTransport>()
    private val dialStartedAt = ConcurrentHashMap<String, Long>()
    /** One signaling hub per mailbox: our own, plus any the engine asks for (invites, channels). */
    private val hubs = ConcurrentHashMap<String, SignalingHub>()

    private fun hubStatus(): SignalingStatus {
        val all = hubs.values.map { it.status() }
        return when {
            all.any { it == SignalingStatus.ONLINE } -> SignalingStatus.ONLINE
            all.isEmpty() -> SignalingStatus.IDLE
            else -> all.first()
        }
    }

    private val transport = object : TransportCallbacks {
        override fun send(peer: String, frame: String): Boolean {
            val open = links[peer]?.isOpen == true || bleLinks[peer]?.isOpen == true
            if (!open) return false
            return senders.getOrPut(peer) { Outbound(peer) }.add(frame)
        }

        override fun sendRaw(link: String, frame: String): Boolean = meshRadio?.send(link, frame) == true

        override fun close(peer: String) {
            stopSender(peer)
            links.remove(peer)?.close()
            bleLinks.remove(peer)?.close()
        }

        override fun signalAvailable(): Boolean = networkConfig().signaling.isNotEmpty()

        override fun signalSubscribe(mailbox: String): Boolean {
            if (networkConfig().signaling.isEmpty()) return false
            hubs.remove(mailbox)?.stop()
            val created = SignalingHub(transportsFor(networkConfig(), scope))
            hubs[mailbox] = created
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
            hubs.remove(mailbox)?.stop()
        }

        override fun signalPut(mailbox: String, blob: String, kind: SignalKind, ttlSec: UInt): Boolean {
            // No relay configured, or every socket failed: say so, and the engine hands the blob to mutual friends instead.
            if (hubs.isEmpty() || hubs.values.all { it.status() == SignalingStatus.ERROR }) return false
            val decoded = Seal.decode(blob) ?: return false
            val wire = if (kind == SignalKind.LIVE) "sig" else "msg"
            // Right after start (or a network change) the sockets are still opening and a put would be refused. Keep the blob
            // and send it as soon as a relay is online, for up to LIVE_PUT_WAIT_MS; the engine republishes what matters.
            scope.launch {
                val deadline = System.currentTimeMillis() + PUT_WAIT_MS
                while (System.currentTimeMillis() < deadline && !stopped) {
                    val online = hubs.values.firstOrNull { it.status() == SignalingStatus.ONLINE }
                    if (online != null && runCatching { online.put(mailbox, decoded, wire, ttlSec.toInt()) }.isSuccess) {
                        android.util.Log.i("RustEngine", "put $wire to ${mailbox.take(8)} ok")
                        break
                    }
                    delay(PUT_RETRY_MS)
                }
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
            inboundJob = scope.launch(Dispatchers.IO) { for (op in inbound) handleInbound(started, op) }
            watchSignaling()
            refreshJob = scope.launch {
                for (signal in refreshRequests) {
                    delay(60) // coalesce bursts
                    refreshNow()
                }
            }
            runCatching { withContext(Dispatchers.IO) { started.setGroupOnly(groupOnly) } }
            runCatching { withContext(Dispatchers.IO) { started.setStoreForward(networkConfig().storeForward) } }
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
        inbound.close()
        for (peer in senders.keys.toList()) stopSender(peer)
        for (t in links.values) runCatching { t.close() }
        links.clear()
        for (t in bleLinks.values) runCatching { t.close() }
        bleLinks.clear()
        runCatching { meshRadio?.stop() }
        meshRadio = null
        for (h in hubs.values) runCatching { h.stop() }
        hubs.clear()
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
            is EventDto.DialRequested -> {
                android.util.Log.i("RustEngine", "dial ${event.peer.take(8)} initiator=${event.initiator} signaling=${hubStatus()}")
                dial(event.peer, event.initiator)
            }
            is EventDto.SignalReceived -> {
                android.util.Log.i("RustEngine", "signal ${event.kind} from ${event.peer.take(8)}")
                onSignal(event.peer, event.kind, event.sdp)
            }
            is EventDto.MessageAdded -> {
                if (!event.own) {
                    // The chat is open on screen: this message is read the moment it arrives (and the sender is told).
                    if (visible && openChat == event.conversation) markOpen(event.conversation)
                    else notifyIncoming(event.conversation, event.messageId)
                }
                requestRefresh()
            }
            is EventDto.InviteFound -> { lookup?.complete(true); requestRefresh() }
            is EventDto.InviteLookupFailed -> { lookup?.complete(false); requestRefresh() }
            is EventDto.FileProgress -> {
                if (event.percent >= 100u) progress.remove(event.messageId) else progress[event.messageId] = event.percent.toInt() / 100f
                _state.update { it.copy(transfers = progress.toMap()) }
                // The last chunk is the file arriving whole (it is in the snapshot now); a refused one has no message at all.
                if (event.percent >= 100u) { incoming.remove(event.messageId); requestRefresh() }
            }
            is EventDto.FileIncoming -> {
                incoming[event.messageId] = Incoming(event.conversation, event.conversation.removePrefix("chan:"), event.name, event.size.toLong())
                progress.putIfAbsent(event.messageId, 0f)
                _state.update { it.copy(transfers = progress.toMap()) }
                requestRefresh()
            }
            is EventDto.FileQueued -> senders[event.peer]?.beginTransfer(event.messageId, event.frames.toLong())
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
        val mode = networkConfig().transportMode
        if (mode != TransportMode.INTERNET_ONLY) tryBluetooth(peer)
        if (mode == TransportMode.BLUETOOTH_ONLY) return
        if (hubStatus() != SignalingStatus.ONLINE) {
            // The relays are not up yet, so this try could not have worked. Do not let it count against the retry delay:
            // the engine asks again at its next tick, and the watcher below dials the moment the relays are online.
            io { runCatching { engine?.resetDialBackoff(peer) } }
            return
        }
        val now = System.currentTimeMillis()
        val existing = links[peer]
        if (existing != null && !existing.isOpen && now - (dialStartedAt[peer] ?: 0L) < OFFER_TIMEOUT_MS) return
        dialStartedAt[peer] = now
        attempts.merge(peer, 1, Int::plus)
        if (initiator) {
            offer(peer)
        } else {
            // The other side offers; tell them we are here.
            io { engine?.sendSignal(peer, SignalKindDto.READY, null) }
        }
    }

    /**
     * Dial the moment the relays come online instead of waiting for the engine's retry delay, which grows after every try
     * and was being used up while the sockets were still opening.
     */
    private fun watchSignaling() {
        scope.launch {
            var wasOnline = false
            while (!stopped) {
                val online = hubStatus() == SignalingStatus.ONLINE
                if (online && !wasOnline) {
                    android.util.Log.i("RustEngine", "signaling online: dialing everyone not linked")
                    io { runCatching { engine?.resetDialBackoff(null) } }
                    val snapshot = last
                    if (snapshot != null) {
                        for (c in snapshot.contacts) {
                            if (c.link !is LinkState.Connected) dial(c.uid, isInitiator(c.uid))
                        }
                    }
                }
                wasOnline = online
                delay(250)
            }
        }
    }

    private fun newTransport(peer: String): WebRtcTransport {
        stopSender(peer)
        links.remove(peer)?.close()
        val created = WebRtcTransport(
            networkConfig().iceServers(), networkConfig().forceRelay,
            object : WebRtcTransport.Handlers {
                override fun onOpen() {
                    // Open the link in the engine at once; how it is routed (direct, relayed) is found out in the background and
                    // corrected afterwards, so connecting never waits for the statistics.
                    inbound.trySend(Inbound.Up(peer, PathKind.UNKNOWN, LinkKind.ENCRYPTED))
                    scope.launch {
                        val current = links[peer] ?: return@launch
                        for (wait in longArrayOf(0L, 1_500L)) {
                            delay(wait)
                            val path = runCatching { current.connectionPath() }.getOrNull()
                            if (path != null) {
                                io { runCatching { engine?.setLinkPath(peer, path.toKind()) } }
                                break
                            }
                        }
                        requestRefresh()
                    }
                }

                override fun onClose() {
                    stopSender(peer)
                    inbound.trySend(Inbound.Down(peer))
                    scope.launch { requestRefresh() }
                }

                override fun onFrame(data: String) {
                    inbound.trySend(Inbound.Frame(peer, data))
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
        heardFrom[peer] = true
        when (kind) {
            SignalKindDto.READY -> {
                // They are online right now: forget the retry delay for this friend and offer without waiting.
                io { runCatching { engine?.resetDialBackoff(peer) } }
                val ex = links[peer]
                val busy = ex != null && !ex.isOpen && System.currentTimeMillis() - (dialStartedAt[peer] ?: 0L) < READY_GUARD_MS
                if (isInitiator(peer) && !busy) {
                    dialStartedAt[peer] = System.currentTimeMillis()
                    offer(peer)
                }
            }
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

    // ------------------------------------------------------------------ Bluetooth (platform adapter)

    /** Automatic attempts: one friend at a time, never more than once a minute per friend, only when already allowed. */
    private fun tryBluetooth(peer: String) {
        if (!networkConfig().bluetooth || bleLinks.isNotEmpty()) return
        if (bleEnv.availability() != BleAvailability.READY) return
        val now = System.currentTimeMillis()
        if (now - (bleLastAttempt[peer] ?: 0L) < BLE_RETRY_MS) return
        bleLastAttempt[peer] = now
        scope.launch { connectBluetooth(peer, manual = false) }
    }

    override suspend fun connectBluetooth(uid: String, manual: Boolean): Result<Unit> {
        val failure = { message: String -> Result.failure<Unit>(IllegalStateException(message)) }
        val own = last?.ownUid ?: return failure("Identity is not ready yet.")
        if (last?.contacts?.none { it.uid == uid } != false) return failure("Add your friend first.")
        if (bleLinks[uid]?.isOpen == true) return Result.success(Unit)
        if (bleLinks.isNotEmpty() && !bleLinks.containsKey(uid)) return failure("Bluetooth is already in use for another friend.")
        when (bleEnv.availability()) {
            BleAvailability.UNSUPPORTED -> return failure("This phone has no Bluetooth LE.")
            BleAvailability.NEEDS_PERMISSION -> return failure("Bluetooth permission is needed. Allow it in Settings.")
            BleAvailability.ADAPTER_OFF -> return failure("Bluetooth is off. Turn it on, then try again.")
            BleAvailability.READY -> Unit
        }
        val secret = call { bleSecret(uid) }.getOrElse { return failure("Bluetooth could not start.") }
        return try {
            bleLinks.remove(uid)?.close()
            val created = BleTransport(
                app, { secret },
                // Two phones: the lower uid scans, the higher one is found.
                own < uid,
                object : BleTransport.Handlers {
                    override fun onOpen() {
                        inbound.trySend(Inbound.Up(uid, PathKind.BLUETOOTH, LinkKind.LAYERED))
                        scope.launch { requestRefresh() }
                    }

                    override fun onClose() {
                        bleLinks.remove(uid)
                        stopSender(uid)
                        inbound.trySend(Inbound.Down(uid))
                        scope.launch { requestRefresh() }
                    }

                    override fun onFrame(data: String) {
                        inbound.trySend(Inbound.Frame(uid, data))
                    }

                    override fun onError(message: String) {
                        if (manual) say(message)
                    }
                },
            )
            bleLinks[uid] = created
            created.start()
            scope.launch {
                delay(BLE_SEARCH_MS)
                val t = bleLinks[uid]
                if (t != null && !t.isOpen) {
                    bleLinks.remove(uid)
                    t.close()
                    if (manual) say("No friend found nearby over Bluetooth. Check that they have DuoChat open with Bluetooth on.")
                    requestRefresh()
                }
            }
            requestRefresh()
            Result.success(Unit)
        } catch (error: Exception) {
            bleLinks.remove(uid)?.close()
            failure("Bluetooth could not start: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    override fun refreshBluetooth() {
        val open = bleLinks.values.any { it.isOpen }
        val status = bluetoothStatusFor(
            enabledInSettings = networkConfig().bluetooth,
            hasEnvironment = true,
            linkIsBluetooth = bleLinks.isNotEmpty(),
            linkReady = open,
            availability = bleEnv.availability(),
            paired = (last?.contacts?.isNotEmpty() == true),
        )
        if (_state.value.bluetooth != status) _state.update { it.copy(bluetooth = status) }
    }

    override fun setMeshEnabled(on: Boolean) {
        if (on && meshRadio == null) {
            val radio = AndroidMeshRadio(app)
            meshRadio = radio
            radio.start(object : MeshRadio.Listener {
                override fun onLinkUp(link: String) {
                    inbound.trySend(Inbound.MeshUp(link))
                    scope.launch { requestRefresh() }
                }

                override fun onLinkDown(link: String) {
                    inbound.trySend(Inbound.MeshDown(link))
                    scope.launch { requestRefresh() }
                }

                override fun onPacket(link: String, json: String) {
                    inbound.trySend(Inbound.MeshFrame(link, json))
                }
            })
        } else if (!on) {
            meshRadio?.stop()
            meshRadio = null
        }
        _state.update { it.copy(meshLinks = meshRadio?.linkCount ?: 0) }
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

    private fun diagnosisOf(c: uniffi.privcord_ffi.ContactDto): com.duochat.app.data.Diagnosis? {
        if (c.link is LinkState.Connected) {
            attempts.remove(c.uid)
            heardFrom.remove(c.uid)
            return null
        }
        val tried = attempts[c.uid] ?: return null
        val web = links[c.uid]
        val cfg = networkConfig()
        return diagnoseConnection(
            ConnectionFacts(
                signaling = hubStatus(),
                attempts = tried,
                sawPeerReply = heardFrom[c.uid] == true,
                localCandidates = web?.lastCandidates,
                iceState = web?.iceState,
                hasTurn = cfg.turn.isNotEmpty(),
                storeForward = cfg.storeForward,
            ),
            c.displayName,
        )
    }

    private fun publish(s: SnapshotDto) {
        val self = s.ownUid ?: return
        refreshBluetooth()
        val contacts = s.contacts.sortedBy { it.displayName.lowercase() }.map { c ->
            ContactView(
                c.uid, c.displayName, if (c.verified) ContactTrust.VERIFIED else ContactTrust.INTRODUCED,
                c.introducedBy?.let { nameOf(s, it) }, c.checked, linkOf(c.link), pathOf(c.link), c.safetyNumber,
                direct = c.canMessage,
                diagnosis = diagnosisOf(c),
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
        val people = s.channelPeople.associate { it.uid to it.name }
        val muted = s.muted.toSet()
        // A person we only know from a channel: the name they chose plus a short id, so two "Alex" can be told apart.
        fun channelLabel(uid: String): String =
            (if (uid == self) ownName().takeIf { it.isNotBlank() } else people[uid]).let { (it ?: "Anonymous") + " #" + uid.take(4) }
        for (conv in s.conversations) {
            val visibleMessages = if (conv.id.startsWith("chan:")) conv.messages.filter { it.sender !in muted } else conv.messages
            val mapped = visibleMessages.mapIndexed { index, m ->
                val replied = m.replyTo?.let { rid -> conv.messages.firstOrNull { it.id == rid } }
                val unreadFrom = visibleMessages.size - conv.unread.toInt()
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
                    file = if (m.isFile) FileMeta(m.text, m.fileMime, m.fileSize.toLong().coerceAtMost(Int.MAX_VALUE.toLong()).toInt(), "") else null,
                    senderName = if (conv.id.startsWith("chan:")) channelLabel(m.sender) else null,
                    deleted = m.deleted, reactions = reactions,
                )
            }
            shaped[conv.id] = mapped
        }

        // Files still arriving: a bubble per file with its progress bar, replaced by the real message when it is whole.
        incoming.entries.removeIf { (id, f) ->
            (System.currentTimeMillis() - f.since > 10 * 60_000L).also { old -> if (old) progress.remove(id) }
        }
        for ((id, f) in incoming) {
            val have = shaped[f.conversation].orEmpty()
            if (have.any { it.messageId == id }) continue
            val sender = if (f.conversation.startsWith("chan:")) f.sender else f.conversation
            val placeholder = ChatMessage(
                messageId = id, clientMessageId = id, senderId = sender, text = f.name,
                clientCreatedAt = System.currentTimeMillis(), deliveryState = DeliveryState.DELIVERED, readAt = null,
                conversationId = f.conversation, type = MessageType.FILE,
                file = FileMeta(f.name, "application/octet-stream", f.size.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(), ""),
            )
            shaped[f.conversation] = have + placeholder
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
        val online = hubStatus() == SignalingStatus.ONLINE
        for (name in s.channels) {
            val id = "chan:$name"
            val conv = s.conversations.firstOrNull { it.id == id }
            summaries += ChatSummary(
                id, true, "# $name", conv?.last?.takeIf { it.sender !in muted }?.let { channelLabel(it.sender) + ": " + it.text }, conv?.last?.at ?: 0L,
                conv?.unread?.toInt() ?: 0, if (online || (meshRadio?.linkCount ?: 0) > 0) LinkStatus.CONNECTED else LinkStatus.OFFLINE, "Public channel",
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
                signaling = hubStatus(),
                transfers = progress.toMap(),
                meshLinks = meshRadio?.linkCount ?: 0,
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
        is uniffi.privcord_ffi.FfiException.BadFile -> "That file cannot be sent. It must not be empty and can be 8 MB at most."
        is uniffi.privcord_ffi.FfiException.Busy -> "The app is busy. Try again in a moment."
        is uniffi.privcord_ffi.FfiException.GroupFull -> "That group is full (10 members at most)."
        is uniffi.privcord_ffi.FfiException.NoSuchGroup -> "That group no longer exists."
        is uniffi.privcord_ffi.FfiException.Storage, is uniffi.privcord_ffi.FfiException.SecureStorage -> "This phone could not save that. Check free storage and try again."
        is uniffi.privcord_ffi.FfiException.InviteNotFound -> "Could not find that invite. Check the words, or ask your friend to share it again."
        is uniffi.privcord_ffi.FfiException.InvalidInvite -> "That is not a valid invite. Check the words, or ask your friend to share it again."
        is uniffi.privcord_ffi.FfiException.NoSignaling -> "No connection service is set up, so six words cannot be looked up. Turn one on in Settings > Connection, or use the long invite."
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

    private fun markOpen(id: String) {
        scope.launch {
            if (id.startsWith("chan:") || isGroup(id)) call { markConversationRead(id) } else call { markRead(id) }
        }
    }

    override fun setVisible(isVisible: Boolean) {
        visible = isVisible
        openChat?.let { id -> if (isVisible) markOpen(id) }
    }

    override fun setOpenChat(conversationId: String?) {
        openChat = conversationId
        if (conversationId != null) markOpen(conversationId)
    }

    override fun clearNotice() {
        notice = null
        _state.update { it.copy(notice = null, error = null) }
    }

    override fun onOwnNameChanged() {
        scope.launch { io { applyOwnName() } }
    }

    override fun ownCard(): String = engine?.ownCard(ownName().ifBlank { null }) ?: ""

    /**
     * A full invite (long text) is accepted at once. Six words start a search on the signaling relays: the engine tells
     * us with InviteFound or InviteLookupFailed (15 seconds at most), and only then can the words be accepted.
     */
    override suspend fun addFriend(text: String): Result<String> {
        val waiter = CompletableDeferred<Boolean>()
        lookup = waiter
        try {
            val preview = call { previewInvite(text) }
            if (preview.isFailure) return Result.failure(preview.exceptionOrNull() ?: IllegalStateException("That did not work."))
            if (preview.getOrNull() == null) {
                // Six words: the search is running.
                val found = withTimeoutOrNull(LOOKUP_WAIT_MS) { waiter.await() } ?: false
                if (!found) {
                    return Result.failure(
                        IllegalStateException(
                            if (hubStatus() == SignalingStatus.ONLINE) "Could not find that invite. Check the words, make sure your friend still has the invite screen open, then try again. (${hubs.values.map { it.describe() }.distinct().joinToString(" | ")})"
                            else "Could not reach the connection service to look up those words. Check your internet, then try again. (${hubs.values.map { it.describe() }.distinct().joinToString(" | ")})",
                        ),
                    )
                }
            }
            return call { acceptInvite(text) }.also {
                if (it.isSuccess) say("Added. Connecting automatically whenever you are both online.")
            }
        } finally {
            lookup = null
        }
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

    override suspend fun joinChannel(raw: String, persist: Boolean): Result<String> {
        // A channel needs the connection service or the Bluetooth mesh; with neither it could never carry a message.
        if (networkConfig().signaling.isEmpty() && meshRadio == null) {
            return Result.failure(IllegalStateException("Channels need a connection service (Settings > Connection) or the Bluetooth mesh (Settings)."))
        }
        return call { joinChannel(raw) }
    }
    override fun leaveChannel(conversationId: String) { scope.launch { call { leaveChannel(conversationId.removePrefix("chan:")) } } }
    override fun muteSender(uid: String) { scope.launch { call { setMuted(uid, true) } } }

    override suspend fun createInvite(): Result<ActiveInvite> = call { createInvite() }.map { ActiveInvite(it.words, it.expiresAt) }
    override suspend fun acceptRequest(uid: String): Result<String> = call { acceptRequest(uid) }
    override fun dismissRequest(uid: String) { scope.launch { call { dismissRequest(uid) } } }

    override suspend fun markChecked(uid: String) { call { setChecked(uid, true) } }

    override suspend fun renameFriend(uid: String, name: String) { call { renameContact(uid, name) } }

    /** Why a friend cannot be removed right now, or null: someone you share a group with stays until you leave the group. */
    override fun removeBlocker(uid: String): String? {
        val snapshot = last ?: return null
        val me = snapshot.ownUid ?: return null
        val shared = snapshot.groups.firstOrNull { g -> g.members.any { it.uid == uid } && g.members.any { it.uid == me } } ?: return null
        return "${nameOf(snapshot, uid)} is in the group \"${shared.name}\" with you. Leave that group first."
    }

    override suspend fun removeFriend(uid: String): Result<Unit> {
        removeBlocker(uid)?.let { return Result.failure(IllegalStateException(it)) }
        return call { removeContact(uid) }
    }

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

    override suspend fun retry(messageId: String) {
        // Send it again from the start (a refused file, say), and dial now instead of waiting out the retry delay.
        call { retryMessage(messageId) }
        io { runCatching { engine?.resetDialBackoff(null) } }
        requestRefresh()
    }

    override suspend fun clearChat(conversationId: String) { call { wipeConversation(conversationId, false) } }

    override suspend fun clearLocalData() {
        call { wipeEverything() }
        secure.deleteIdentity()
        // The engine's database (erased in place above) is removed as well once it is closed.
        scope.launch(Dispatchers.IO) {
            delay(1500)
            for (suffix in listOf("", "-wal", "-shm", "-journal")) runCatching { File(app.noBackupFilesDir, "privcord.db$suffix").delete() }
        }
    }

    /** Settings changed: the sockets follow the new settings, so reopen every mailbox. */
    override fun reloadNetwork() {
        scope.launch { call { setStoreForward(networkConfig().storeForward) } }
        for (mailbox in hubs.keys.toList()) transport.signalSubscribe(mailbox)
    }

    /**
     * A network came up (Android also reports this once at start-up). Only mailboxes whose sockets failed are reopened:
     * tearing down sockets that are online or still connecting would drop signals that are in flight.
     */
    override fun onNetworkAvailable() {
        for ((mailbox, h) in hubs.entries.toList()) {
            if (h.status() == SignalingStatus.ERROR) transport.signalSubscribe(mailbox)
        }
    }

    // ------------------------------------------------------------------ manual connection codes

    private fun encodeCode(kind: String, sdp: String, card: String): String {
        val json = org.json.JSONObject().put("v", 1).put("kind", kind).put("sdp", sdp).put("card", card).toString()
        return MANUAL_PREFIX + android.util.Base64.encodeToString(
            json.toByteArray(Charsets.UTF_8), android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING,
        )
    }

    private fun decodeCode(code: String, expected: String): Pair<String, String> {
        val text = code.trim()
        if (!text.startsWith(MANUAL_PREFIX)) {
            throw IllegalArgumentException("That is not a code from the Rust build. Both phones need the Rust build for manual codes.")
        }
        val json = try {
            org.json.JSONObject(
                String(android.util.Base64.decode(text.removePrefix(MANUAL_PREFIX), android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP), Charsets.UTF_8),
            )
        } catch (e: Exception) {
            throw IllegalArgumentException("That code is damaged. Copy it again, in full.")
        }
        if (json.optString("kind") != expected) {
            throw IllegalArgumentException(
                if (expected == "answer") "This code is an offer. The other user must paste your offer and send back an answer."
                else "This code is an answer. Paste the offer from the other user instead.",
            )
        }
        return json.getString("sdp") to json.getString("card")
    }

    private fun manualTransport(): WebRtcTransport {
        manual.transport?.close()
        manual.pending.clear()
        manual.bound = null
        val created = WebRtcTransport(
            networkConfig().iceServers(), networkConfig().forceRelay,
            object : WebRtcTransport.Handlers {
                override fun onOpen() { scope.launch { onManualOpen() } }

                override fun onClose() {
                    scope.launch {
                        val bound = manual.bound
                        if (bound != null) inbound.trySend(Inbound.Down(bound)) else _state.update { it.copy(manual = ManualState()) }
                        requestRefresh()
                    }
                }

                override fun onFrame(data: String) {
                    val bound = manual.bound
                    if (bound != null) inbound.trySend(Inbound.Frame(bound, data))
                    else if (manual.pending.size < 20) manual.pending.addLast(data)
                }

                override fun onError(message: String) { say(message) }
            },
        )
        manual.transport = created
        return created
    }

    private suspend fun onManualOpen() {
        val card = manual.peerCard ?: return
        val preview = call { previewInvite(card) }.getOrNull()
        _state.update {
            it.copy(
                manual = ManualState(
                    p2pState = P2PState.CONNECTED, connected = true, trust = PeerTrust.UNVERIFIED,
                    safetyNumber = preview?.safetyNumber, peerName = preview?.name,
                ),
            )
        }
    }

    override suspend fun createManualOffer(): String {
        val card = engine?.ownCard(ownName().ifBlank { null }) ?: throw IllegalStateException("Identity is not ready.")
        val t = manualTransport()
        manual.peerCard = null
        return try {
            encodeCode("offer", t.createOffer(), card)
        } catch (e: Exception) {
            manual.transport?.close()
            throw e
        }
    }

    override suspend fun applyManualAnswer(code: String) {
        val (sdp, card) = decodeCode(code, "answer")
        val t = manual.transport ?: throw IllegalStateException("Create an offer before pasting an answer.")
        manual.peerCard = card
        t.applyAnswer(sdp)
    }

    override suspend fun acceptManualOffer(code: String): String {
        val (sdp, card) = decodeCode(code, "offer")
        val own = engine?.ownCard(ownName().ifBlank { null }) ?: throw IllegalStateException("Identity is not ready.")
        val t = manualTransport()
        manual.peerCard = card
        return try {
            encodeCode("answer", t.acceptOffer(sdp), own)
        } catch (e: Exception) {
            manual.transport?.close()
            throw e
        }
    }

    /** The user compared the safety number: save the friend and hand the open channel to the engine. */
    override fun confirmManual() {
        scope.launch {
            val card = manual.peerCard ?: return@launch
            val t = manual.transport ?: return@launch
            val uid = call { acceptInvite(card) }.getOrElse { say(it.message ?: "Could not add them."); return@launch }
            call { setChecked(uid, true) }
            links.remove(uid)?.close()
            links[uid] = t
            manual.bound = uid
            manual.transport = null
            inbound.trySend(Inbound.Up(uid, PathKind.UNKNOWN, LinkKind.ENCRYPTED))
            // Frames the other side sent while we were still comparing numbers, in the order they came.
            while (manual.pending.isNotEmpty()) inbound.trySend(Inbound.Frame(uid, manual.pending.removeFirst()))
            scope.launch {
                val path = runCatching { t.connectionPath() }.getOrNull()
                if (path != null) io { runCatching { engine?.setLinkPath(uid, path.toKind()) } }
            }
            _state.update { it.copy(manual = ManualState()) }
            say("Added. Both phones have to confirm within a few seconds for the secure link to finish.")
            requestRefresh()
        }
    }

    override fun cancelManual() {
        manual.transport?.close()
        manual.transport = null
        manual.pending.clear()
        manual.peerCard = null
        _state.update { it.copy(manual = ManualState()) }
    }

    private companion object {
        const val OFFER_TIMEOUT_MS = 25_000L
        const val LOOKUP_WAIT_MS = 42_000L
        const val PUT_WAIT_MS = 30_000L
        const val PUT_RETRY_MS = 100L
        const val READY_GUARD_MS = 8_000L
        const val MANUAL_PREFIX = "RUST1:"
        const val BLE_SEARCH_MS = 30_000L
        const val BLE_RETRY_MS = 60_000L
    }
}
