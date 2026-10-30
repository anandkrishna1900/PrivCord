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
)

data class OutboxRow(
    val messageId: String,
    val recipientId: String,
    val payload: String,
    val createdAt: Long,
    val attemptCount: Int,
    val lastAttemptAt: Long?,
    val deliveryState: DeliveryState,
    val lastError: String?,
)

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

data class ChatState(
    val phase: EnginePhase = EnginePhase.STARTING,
    val uid: String = "",
    /** The other person's id: known after the first pairing, null before. */
    val peerUid: String? = null,
    val conversationId: String = "",
    val messages: List<ChatMessage> = emptyList(),
    val connectionMode: ConnectionMode = ConnectionMode.OFFLINE_QUEUED,
    val p2pState: P2PState = P2PState.IDLE,
    val p2pConnected: Boolean = false,
    val peerTrust: PeerTrust = PeerTrust.NONE,
    val safetyNumber: String? = null,
    val queuedCount: Int = 0,
    val error: String? = null,
    val notice: String? = null,
    /** True once a peer key is pinned on this device. */
    val paired: Boolean = false,
    /** Null until the channel is open and the selected candidate pair has been read. */
    val connectionPath: ConnectionPath? = null,
    val signaling: com.duochat.app.signaling.SignalingStatus = com.duochat.app.signaling.SignalingStatus.IDLE,
    val bluetooth: BluetoothStatus = BluetoothStatus.DISABLED,
    /** A friend's card that was pasted but not yet confirmed by the user. */
    val pendingContact: PendingContact? = null,
)

data class PendingContact(val uid: String, val safetyNumber: String, val name: String?)

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

fun createOutgoingMessage(senderId: String, text: String): ChatMessage {
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
    )
}
