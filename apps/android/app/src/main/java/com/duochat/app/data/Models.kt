package com.duochat.app.data

import java.util.UUID

const val PROTOCOL_VERSION = 1
const val MAX_TEXT_LENGTH = 4000
const val MAX_CLIENT_MESSAGE_ID_LENGTH = 64
const val AUTH_TIMEOUT_MS = 15_000L
const val MANUAL_SIGNAL_PREFIX = "DUO1:"

enum class DeliveryState { QUEUED, SENT, DELIVERED, READ, FAILED }

/** `p2p`: direct data channel. `relay`: sealed blob held by a store-and-forward relay. */
enum class TransportKind(val wire: String) {
    P2P("p2p"),
    RELAY("relay");

    companion object {
        fun fromWire(value: String?): TransportKind? = entries.firstOrNull { it.wire == value }
    }
}

/** Own messages the peer has not acknowledged yet; resent whenever the direct channel opens. */
fun needsDelivery(state: DeliveryState): Boolean =
    state != DeliveryState.DELIVERED && state != DeliveryState.READ

data class ChatMessage(
    val messageId: String,
    val clientMessageId: String,
    val senderId: String,
    val text: String,
    val clientCreatedAt: Long,
    val transport: TransportKind = TransportKind.P2P,
    val deliveryState: DeliveryState = DeliveryState.QUEUED,
    val readAt: Long? = null,
    /** A contact's uid (direct chat) or a group id. Empty only for messages not yet placed in a chat. */
    val conversationId: String = "",
    /** Group messages: members it had to reach, and how many have confirmed it. */
    val totalRecipients: Int = 0,
    val deliveredTo: Int = 0,
    val type: MessageType = MessageType.TEXT,
    val replyTo: ReplyRef? = null,
    /** Set when [type] is FILE: the bytes live in the file store under the message id. */
    val file: FileMeta? = null,
    /** Channel messages: the sender's self-chosen name plus a short id (they are not in our contacts). */
    val senderName: String? = null,
    /** Deleted for everyone: only a tombstone is kept. */
    val deleted: Boolean = false,
    /** Who reacted with what (uid to emoji). */
    val reactions: Map<String, String> = emptyMap(),
)

/** One message waiting for one recipient. */
data class OutboxRow(
    val messageId: String,
    val recipientId: String,
    val payload: String,
    val createdAt: Long,
    val attemptCount: Int,
    val lastAttemptAt: Long?,
    val deliveryState: DeliveryState,
    val lastError: String?,
) {
    val key: String get() = "$messageId|$recipientId"
}

/** NEEDS_IDENTITY: first run, the 12-word phrase flow must finish before anything else. */
enum class EnginePhase { STARTING, NEEDS_IDENTITY, READY, ERROR, STOPPED }
enum class P2PState { IDLE, CONNECTING, CONNECTED, FAILED }
enum class PeerTrust { NONE, VERIFIED, UNVERIFIED, CONFIRMED }

enum class ConnectionMode {
    P2P_CONNECTED,
    CONNECTING,
    RECONNECTING,
    OFFLINE_QUEUED,
    CONNECTION_FAILED,
}

/** What the Bluetooth link is doing, for the Settings status row. */
enum class BluetoothStatus { DISABLED, UNSUPPORTED, NEEDS_PERMISSION, ADAPTER_OFF, NOT_PAIRED, READY, SEARCHING, CONNECTED }

enum class ConnectionTone { ONLINE, DIRECT, BUSY, OFFLINE, ERROR }

data class ConnectionPresentation(
    val label: String,
    val detail: String,
    val tone: ConnectionTone,
    val p2p: Boolean,
)

/**
 * How the open data channel is really routed, read from the selected ICE
 * candidate pair (never inferred from configuration).
 */
enum class ConnectionPath(val label: String, val detail: String) {
    BLUETOOTH(
        "Bluetooth, no internet",
        "Connected over Bluetooth LE within radio range. No internet or server is involved.",
    ),
    DIRECT_LAN(
        "Direct, same network",
        "Both devices are on the same network and talk straight to each other.",
    ),
    DIRECT_P2P(
        "Direct, peer to peer",
        "Connected straight to the other device through your routers (NAT traversed). No relay.",
    ),
    RELAYED(
        "Relayed through TURN",
        "No direct path was possible, so traffic passes through a TURN relay server. " +
            "It is still end-to-end encrypted, but the relay sees that you are talking and when.",
    ),
}

/**
 * Maps the selected candidate pair's types (host / srflx / prflx / relay) to the
 * route the traffic really takes. Null while either type is unknown.
 */
fun classifyConnectionPath(localType: String?, remoteType: String?): ConnectionPath? {
    if (localType.isNullOrEmpty() || remoteType.isNullOrEmpty()) return null
    return when {
        localType == "relay" || remoteType == "relay" -> ConnectionPath.RELAYED
        localType == "host" && remoteType == "host" -> ConnectionPath.DIRECT_LAN
        else -> ConnectionPath.DIRECT_P2P
    }
}

enum class ContactTrust(val wire: String) {
    /** We exchanged cards (QR / invite text), or compared the safety number. */
    VERIFIED("verified"),

    /** We learned the card from a group roster; the keys are pinned but nobody compared anything. */
    INTRODUCED("introduced");

    companion object {
        fun fromWire(value: String?): ContactTrust = entries.firstOrNull { it.wire == value } ?: VERIFIED
    }
}

enum class LinkStatus { CONNECTED, CONNECTING, OFFLINE }

data class ContactView(
    val uid: String,
    val name: String,
    val trust: ContactTrust,
    /** Display name of whoever introduced them (introduced contacts only). */
    val introducedByName: String?,
    /** Safety numbers were compared, or the card was exchanged in person. */
    val checked: Boolean,
    val link: LinkStatus,
    val path: ConnectionPath?,
    val safetyNumber: String,
    /** A direct chat is possible (friends you swapped invites with, or group people when neither side is group-only). */
    val direct: Boolean = true,
    /** Plain-language reason a direct link is not forming; null when fine or too early to say. */
    val diagnosis: Diagnosis? = null,
)

data class MemberView(
    val uid: String,
    val name: String,
    val isMe: Boolean,
    val isAdmin: Boolean,
    val addedByName: String?,
    val trust: ContactTrust?,
    val link: LinkStatus?,
    /** A direct chat with this member is possible. */
    val canMessage: Boolean = false,
)

data class GroupView(
    val groupId: String,
    val name: String,
    val members: List<MemberView>,
    val iAmMember: Boolean,
    val iAmAdmin: Boolean,
    /** "You were removed" / "You left" once we are out; the group stays visible and read-only. */
    val exitNote: String?,
    val connectedCount: Int,
    val full: Boolean = false,
    val maxMembers: Int = MAX_GROUP_MEMBERS,
)

/** One row of the home list: a person or a group. */
data class ChatSummary(
    val id: String,
    val isGroup: Boolean,
    val title: String,
    val lastText: String?,
    val lastAt: Long,
    val unread: Int,
    val link: LinkStatus,
    val subtitle: String,
)

/** The manual connection-code flow (Advanced). It is not tied to a saved friend until it is confirmed. */
data class ManualState(
    val p2pState: P2PState = P2PState.IDLE,
    val connected: Boolean = false,
    val trust: PeerTrust = PeerTrust.NONE,
    val safetyNumber: String? = null,
    val peerName: String? = null,
)

data class ChatState(
    val phase: EnginePhase = EnginePhase.STARTING,
    val uid: String = "",
    val contacts: List<ContactView> = emptyList(),
    val groups: List<GroupView> = emptyList(),
    val chats: List<ChatSummary> = emptyList(),
    /** Messages by conversation id (contact uid or group id), oldest first. */
    val messages: Map<String, List<ChatMessage>> = emptyMap(),
    val queuedCount: Int = 0,
    val linkCount: Int = 0,
    val error: String? = null,
    val notice: String? = null,
    val signaling: com.duochat.app.signaling.SignalingStatus = com.duochat.app.signaling.SignalingStatus.IDLE,
    val bluetooth: BluetoothStatus = BluetoothStatus.DISABLED,
    val manual: ManualState = ManualState(),
    /** 0..1 for files being sent or received, by message id. */
    val transfers: Map<String, Float> = emptyMap(),
    val groupOnly: Boolean = false,
    /** Our current six-word invite, if one is being shown. */
    val invite: ActiveInvite? = null,
    /** People who used our words and wait for us to accept them. */
    val requests: List<InviteRequest> = emptyList(),
    val answer: InviteAnswer? = null,
    val channels: List<ChannelView> = emptyList(),
    /** Phones currently linked over the Bluetooth mesh (0 when the mesh is off). */
    val meshLinks: Int = 0,
    /** New mesh messages this phone heard, and copies it passed on to other phones (for field testing). */
    val meshHeard: Int = 0,
    val meshPassedOn: Int = 0,
)

/** A public channel we have joined. */
data class ChannelView(val id: String, val name: String, val unread: Int, val connected: Boolean)

data class ActiveInvite(val words: String, val expiresAt: Long)

/** After typing a friend's words: did our own invite reach them? (They then confirm us on their side.) */
enum class AnswerState { SENDING, SENT, FAILED }

data class InviteAnswer(val uid: String, val name: String, val state: AnswerState, val error: String? = null)

data class InviteRequest(val uid: String, val name: String, val safetyNumber: String)

data class PendingContact(val uid: String, val safetyNumber: String, val name: String?)

/** Soft cap on simultaneous links (full mesh: N members means N-1 links per phone). */
const val MAX_LINKS = 30
const val MAX_CONNECTING = 3

fun deriveConnectionMode(
    p2pConnected: Boolean,
    connecting: Boolean,
    reconnecting: Boolean,
    failed: Boolean,
): ConnectionMode {
    if (p2pConnected) return ConnectionMode.P2P_CONNECTED
    if (connecting) return ConnectionMode.CONNECTING
    if (reconnecting) return ConnectionMode.RECONNECTING
    if (failed) return ConnectionMode.CONNECTION_FAILED
    return ConnectionMode.OFFLINE_QUEUED
}

fun presentConnection(mode: ConnectionMode, queuedMessages: Int = 0): ConnectionPresentation =
    when (mode) {
        ConnectionMode.P2P_CONNECTED -> ConnectionPresentation(
            "Direct",
            "Connected straight to the other device. Messages never touch a server.",
            ConnectionTone.DIRECT,
            p2p = true,
        )

        ConnectionMode.CONNECTING -> ConnectionPresentation(
            "Connecting",
            "Establishing a direct connection to the other device.",
            ConnectionTone.BUSY,
            p2p = false,
        )

        ConnectionMode.RECONNECTING -> ConnectionPresentation(
            "Reconnecting",
            "Connection lost. Reconnecting automatically when signaling is configured, otherwise exchange a new connection code.",
            ConnectionTone.BUSY,
            p2p = false,
        )

        ConnectionMode.CONNECTION_FAILED -> ConnectionPresentation(
            "Connection failed",
            "The direct connection could not be established. Messages stay queued on this device.",
            ConnectionTone.ERROR,
            p2p = false,
        )

        ConnectionMode.OFFLINE_QUEUED -> ConnectionPresentation(
            if (queuedMessages > 0) "Not connected · $queuedMessages queued" else "Not connected",
            "No direct connection. Messages are saved locally and sent once you connect.",
            ConnectionTone.OFFLINE,
            p2p = false,
        )
    }

fun compareMessages(a: ChatMessage, b: ChatMessage): Int {
    if (a.clientCreatedAt != b.clientCreatedAt) {
        return a.clientCreatedAt.compareTo(b.clientCreatedAt)
    }
    return a.messageId.compareTo(b.messageId)
}

fun normalizeNewlines(text: String): String = text.replace("\r\n", "\n").replace('\r', '\n')

fun countCodePoints(text: String): Int = text.codePointCount(0, text.length)

fun validateOutgoingText(raw: String): Result<String> {
    val text = normalizeNewlines(raw)
    if (text.trim().isEmpty()) return Result.failure(IllegalArgumentException("Message cannot be empty."))
    if (countCodePoints(text) > MAX_TEXT_LENGTH) {
        return Result.failure(
            IllegalArgumentException("Message exceeds the ${MAX_TEXT_LENGTH} character limit."),
        )
    }
    return Result.success(text)
}

fun isValidClientMessageId(value: String?): Boolean =
    value != null && value.isNotEmpty() && value.length <= MAX_CLIENT_MESSAGE_ID_LENGTH

fun createOutgoingMessage(senderId: String, text: String, replyTo: ReplyRef? = null): ChatMessage {
    val normalized = validateOutgoingText(text).getOrThrow()
    require(senderId.isNotEmpty()) { "A sender is required." }
    val id = UUID.randomUUID().toString()
    return ChatMessage(
        messageId = id,
        clientMessageId = id,
        senderId = senderId,
        text = normalized,
        clientCreatedAt = System.currentTimeMillis(),
        transport = TransportKind.P2P,
        deliveryState = DeliveryState.QUEUED,
        readAt = null,
        replyTo = replyTo,
    )
}
