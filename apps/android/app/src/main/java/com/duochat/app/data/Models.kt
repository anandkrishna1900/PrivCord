package com.duochat.app.data

import com.google.firebase.firestore.DocumentSnapshot
import java.util.UUID

const val PROTOCOL_VERSION = 1
const val MAX_TEXT_LENGTH = 4000
const val MAX_CLIENT_MESSAGE_ID_LENGTH = 64
const val AUTH_TIMEOUT_MS = 15_000L
const val MANUAL_SIGNAL_PREFIX = "DUO1:"

enum class DeliveryState { QUEUED, SENT, DELIVERED, READ, FAILED }

enum class TransportKind(val wire: String) {
    CLOUD("cloud"),
    P2P("p2p");

    companion object {
        fun fromWire(value: String?): TransportKind? =
            when (value) {
                "cloud" -> CLOUD
                "p2p" -> P2P
                else -> null
            }
    }
}

data class ChatMessage(
    val messageId: String,
    val clientMessageId: String,
    val senderId: String,
    val text: String,
    val clientCreatedAt: Long,
    val serverCreatedAt: Long? = null,
    val transport: TransportKind = TransportKind.CLOUD,
    val deliveryState: DeliveryState = DeliveryState.QUEUED,
    val syncedToCloud: Boolean = false,
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

data class AccessInfo(
    val memberIds: List<String>,
    val conversationId: String,
)

data class UserProfile(
    val uid: String,
    val displayName: String,
    val photoURL: String?,
    val lastSeenAt: Long?,
)

data class IncomingSignal(
    val id: String,
    val from: String,
    val fromDeviceId: String,
    val kind: String,
    val sdp: String,
    val expiresAt: Long,
)

data class MessagePage(
    val messages: List<ChatMessage>,
    val cursor: DocumentSnapshot?,
    val hasMore: Boolean,
)

enum class EnginePhase { STARTING, READY, ERROR, STOPPED }
enum class P2PState { IDLE, CONNECTING, CONNECTED, FAILED }
enum class PeerTrust { NONE, VERIFIED, UNVERIFIED, CONFIRMED }
enum class PeerKeySource { CLOUD, CACHE, MANUAL }

enum class ConnectionMode {
    CLOUD_CONNECTED,
    P2P_CONNECTED,
    CLOUD_AND_P2P_CONNECTED,
    CONNECTING,
    RECONNECTING,
    OFFLINE_QUEUED,
    CONNECTION_FAILED,
}

enum class ConnectionTone { ONLINE, DIRECT, BUSY, OFFLINE, ERROR }

data class ConnectionPresentation(
    val label: String,
    val detail: String,
    val tone: ConnectionTone,
    val cloud: Boolean,
    val p2p: Boolean,
)

data class ChatState(
    val phase: EnginePhase = EnginePhase.STARTING,
    val uid: String = "",
    val peerUid: String = "",
    val conversationId: String = "",
    val selfProfile: UserProfile? = null,
    val peerProfile: UserProfile? = null,
    val messages: List<ChatMessage> = emptyList(),
    val connectionMode: ConnectionMode = ConnectionMode.CONNECTING,
    val cloudConnected: Boolean = false,
    val p2pState: P2PState = P2PState.IDLE,
    val p2pConnected: Boolean = false,
    val peerTrust: PeerTrust = PeerTrust.NONE,
    val safetyNumber: String? = null,
    val queuedCount: Int = 0,
    val hasOlder: Boolean = false,
    val loadingOlder: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    val lastSyncAt: Long? = null,
    val manualMode: Boolean = false,
    val peerKeySource: PeerKeySource? = null,
)

fun deriveConnectionMode(
    cloudConnected: Boolean,
    p2pConnected: Boolean,
    connecting: Boolean,
    reconnecting: Boolean,
    failed: Boolean,
): ConnectionMode {
    if (cloudConnected && p2pConnected) return ConnectionMode.CLOUD_AND_P2P_CONNECTED
    if (cloudConnected) return ConnectionMode.CLOUD_CONNECTED
    if (p2pConnected) return ConnectionMode.P2P_CONNECTED
    if (connecting) return ConnectionMode.CONNECTING
    if (reconnecting) return ConnectionMode.RECONNECTING
    if (failed) return ConnectionMode.CONNECTION_FAILED
    return ConnectionMode.OFFLINE_QUEUED
}

fun presentConnection(mode: ConnectionMode, queuedMessages: Int = 0): ConnectionPresentation =
    when (mode) {
        ConnectionMode.CLOUD_AND_P2P_CONNECTED -> ConnectionPresentation(
            "Cloud + direct",
            "Cloud sync and a direct peer channel are both active.",
            ConnectionTone.ONLINE,
            cloud = true,
            p2p = true,
        )

        ConnectionMode.CLOUD_CONNECTED -> ConnectionPresentation(
            "Cloud",
            "Messages sync through the cloud. A direct channel is being negotiated.",
            ConnectionTone.ONLINE,
            cloud = true,
            p2p = false,
        )

        ConnectionMode.P2P_CONNECTED -> ConnectionPresentation(
            "Direct only",
            "Cloud sync is unavailable. Messages travel directly and will sync when the cloud returns.",
            ConnectionTone.DIRECT,
            cloud = false,
            p2p = true,
        )

        ConnectionMode.CONNECTING -> ConnectionPresentation(
            "Connecting",
            "Establishing a connection to the other device.",
            ConnectionTone.BUSY,
            cloud = false,
            p2p = false,
        )

        ConnectionMode.RECONNECTING -> ConnectionPresentation(
            "Reconnecting",
            "Connection lost. Retrying automatically.",
            ConnectionTone.BUSY,
            cloud = false,
            p2p = false,
        )

        ConnectionMode.CONNECTION_FAILED -> ConnectionPresentation(
            "Connection failed",
            "No path is available. Messages stay queued until a connection returns.",
            ConnectionTone.ERROR,
            cloud = false,
            p2p = false,
        )

        ConnectionMode.OFFLINE_QUEUED -> ConnectionPresentation(
            if (queuedMessages > 0) "Offline · $queuedMessages queued" else "Offline",
            "No connection. Messages are saved locally and will be sent automatically.",
            ConnectionTone.OFFLINE,
            cloud = false,
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
        transport = TransportKind.CLOUD,
        deliveryState = DeliveryState.QUEUED,
        syncedToCloud = false,
        readAt = null,
    )
}

fun fromCloudMessage(
    id: String,
    data: Map<String, Any?>,
    serverCreatedAt: Long?,
): ChatMessage? {
    val senderId = data["senderId"] as? String
    if (senderId.isNullOrEmpty()) return null
    val text = data["text"] as? String ?: return null
    if (text.trim().isEmpty() || countCodePoints(text) > MAX_TEXT_LENGTH) return null
    val messageId = data["messageId"] as? String ?: id
    if (messageId != id) return null
    val clientMessageId = data["clientMessageId"] as? String
    if (!isValidClientMessageId(clientMessageId)) return null
    if (data["type"] != "text") return null
    val transport = TransportKind.fromWire(data["transport"] as? String) ?: return null
    val clientCreatedAt = when (val value = data["clientCreatedAt"]) {
        is Number -> value.toLong()
        else -> return null
    }
    if (clientCreatedAt <= 0) return null
    return ChatMessage(
        messageId = messageId,
        clientMessageId = clientMessageId!!,
        senderId = senderId,
        text = text,
        clientCreatedAt = clientCreatedAt,
        serverCreatedAt = serverCreatedAt,
        transport = transport,
        deliveryState = DeliveryState.DELIVERED,
        syncedToCloud = true,
        readAt = null,
    )
}

fun toCloudPayload(message: ChatMessage): Map<String, Any?> = mapOf(
    "messageId" to message.messageId,
    "senderId" to message.senderId,
    "text" to message.text,
    "clientCreatedAt" to message.clientCreatedAt,
    "type" to "text",
    "clientMessageId" to message.clientMessageId,
    "transport" to message.transport.wire,
)
