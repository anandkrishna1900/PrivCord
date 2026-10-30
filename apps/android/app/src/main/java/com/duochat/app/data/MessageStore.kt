package com.duochat.app.data

import com.duochat.app.data.local.DuoDao
import com.duochat.app.data.local.MessageEntity
import com.duochat.app.data.local.OutboxEntity
import com.duochat.app.security.LocalCrypto

class MessageStore(
    private val dao: DuoDao,
    private val crypto: LocalCrypto,
    private val conversationId: String = MessageEntity.LEGACY_CONVERSATION_ID,
) {
    suspend fun loadMessages(limit: Int = 2000): List<ChatMessage> {
        val rows = dao.loadMessages(limit).reversed()
        return rows.map { row ->
            val text = try {
                crypto.decrypt(row.textCipher)
            } catch (_: Exception) {
                "[unable to decrypt locally stored message]"
            }
            ChatMessage(
                messageId = row.messageId,
                clientMessageId = row.clientMessageId,
                senderId = row.senderId,
                text = text,
                clientCreatedAt = row.clientCreatedAt,
                serverCreatedAt = row.serverCreatedAt,
                transport = TransportKind.fromWire(row.transport) ?: TransportKind.CLOUD,
                deliveryState = runCatching { DeliveryState.valueOf(row.deliveryState) }
                    .getOrDefault(DeliveryState.QUEUED),
                syncedToCloud = row.syncedToCloud,
                readAt = row.readAt,
            )
        }
    }

    suspend fun putMessage(message: ChatMessage) {
        dao.putMessage(
            MessageEntity(
                messageId = message.messageId,
                clientMessageId = message.clientMessageId,
                senderId = message.senderId,
                textCipher = crypto.encrypt(message.text),
                clientCreatedAt = message.clientCreatedAt,
                serverCreatedAt = message.serverCreatedAt,
                transport = message.transport.wire,
                deliveryState = message.deliveryState.name,
                syncedToCloud = message.syncedToCloud,
                readAt = message.readAt,
                conversationId = conversationId,
            ),
        )
    }

    suspend fun updateMessage(
        messageId: String,
        deliveryState: DeliveryState? = null,
        transport: TransportKind? = null,
        syncedToCloud: Boolean? = null,
        readAt: Long? = null,
        setReadAt: Boolean = false,
    ) {
        if (deliveryState != null) dao.updateMessageDelivery(messageId, deliveryState.name)
        if (transport != null) dao.updateMessageTransport(messageId, transport.wire)
        if (syncedToCloud != null) dao.updateMessageSynced(messageId, syncedToCloud)
        if (setReadAt || readAt != null) dao.updateMessageReadAt(messageId, readAt)
    }

    suspend fun loadOutbox(): List<OutboxRow> =
        dao.loadOutbox().map { row ->
            val payload = try {
                crypto.decrypt(row.payloadCipher)
            } catch (_: Exception) {
                ""
            }
            OutboxRow(
                messageId = row.messageId,
                recipientId = row.recipientId,
                payload = payload,
                createdAt = row.createdAt,
                attemptCount = row.attemptCount,
                lastAttemptAt = row.lastAttemptAt,
                deliveryState = runCatching { DeliveryState.valueOf(row.deliveryState) }
                    .getOrDefault(DeliveryState.QUEUED),
                lastError = row.lastError,
            )
        }

    suspend fun enqueueOutbox(row: OutboxRow) {
        dao.putOutbox(
            OutboxEntity(
                messageId = row.messageId,
                recipientId = row.recipientId,
                payloadCipher = crypto.encrypt(row.payload),
                createdAt = row.createdAt,
                attemptCount = row.attemptCount,
                lastAttemptAt = row.lastAttemptAt,
                deliveryState = row.deliveryState.name,
                lastError = row.lastError,
                conversationId = conversationId,
            ),
        )
    }

    suspend fun recordOutboxAttempt(
        messageId: String,
        attemptCount: Int,
        lastAttemptAt: Long?,
        deliveryState: DeliveryState,
        lastError: String?
    ) {
        dao.updateOutboxAttempt(
            messageId,
            attemptCount,
            lastAttemptAt,
            deliveryState.name,
            lastError,
        )
    }

    suspend fun updateOutboxDelivery(
        messageId: String,
        deliveryState: DeliveryState,
        lastAttemptAt: Long?,
    ) {
        dao.updateOutboxDelivery(messageId, deliveryState.name, lastAttemptAt)
    }

    suspend fun removeOutbox(messageId: String) = dao.removeOutbox(messageId)

    suspend fun clearAll() {
        dao.clearMessages()
        dao.clearOutbox()
    }

    /** Per-conversation kill switch (Option A local content erase). */
    suspend fun clearConversation() {
        dao.clearMessagesFor(conversationId)
        dao.clearOutboxFor(conversationId)
    }
}
