package com.duochat.app.data

import com.duochat.app.data.local.ContactEntity
import com.duochat.app.data.local.DuoDao
import com.duochat.app.data.local.GroupLogEntity
import com.duochat.app.data.local.MessageEntity
import com.duochat.app.data.local.OutboxEntity
import com.duochat.app.security.LocalCrypto
import org.json.JSONArray
import org.json.JSONObject

/**
 * Everything the engine keeps on disk: messages (encrypted at rest, per conversation), the per-recipient
 * send queue, contacts and the signed event log of every group.
 */
class MessageStore(
    private val dao: DuoDao,
    private val crypto: LocalCrypto,
    /** Where received and sent files are kept (encrypted). Null where files are not supported (unit tests). */
    private val filesDir: java.io.File? = null,
) {
    suspend fun loadMessages(limit: Int = MAX_LOADED_MESSAGES): List<ChatMessage> =
        dao.loadMessages(limit).reversed().map { row ->
            val text = try {
                crypto.decrypt(row.textCipher)
            } catch (_: Exception) {
                "[unable to decrypt locally stored message]"
            }
            val extra = row.extraCipher?.let {
                try {
                    JSONObject(crypto.decrypt(it))
                } catch (_: Exception) {
                    null
                }
            }
            ChatMessage(
                type = if (extra?.optJSONObject("file") != null) MessageType.FILE else MessageType.TEXT,
                replyTo = ReplyRef.fromJson(extra?.optJSONObject("replyTo")),
                file = FileMeta.fromJson(extra?.optJSONObject("file")),
                messageId = row.messageId,
                clientMessageId = row.clientMessageId,
                senderId = row.senderId,
                text = text,
                clientCreatedAt = row.clientCreatedAt,
                transport = TransportKind.fromWire(row.transport) ?: TransportKind.P2P,
                deliveryState = runCatching { DeliveryState.valueOf(row.deliveryState) }
                    .getOrDefault(DeliveryState.QUEUED),
                readAt = row.readAt,
                conversationId = row.conversationId,
                totalRecipients = row.totalRecipients,
            )
        }

    suspend fun putMessage(message: ChatMessage) {
        dao.putMessage(
            MessageEntity(
                messageId = message.messageId,
                clientMessageId = message.clientMessageId,
                senderId = message.senderId,
                textCipher = crypto.encrypt(message.text),
                clientCreatedAt = message.clientCreatedAt,
                transport = message.transport.wire,
                deliveryState = message.deliveryState.name,
                readAt = message.readAt,
                conversationId = message.conversationId,
                totalRecipients = message.totalRecipients,
                extraCipher = if (message.replyTo != null || message.file != null) {
                    crypto.encrypt(
                        JSONObject()
                            .also { o ->
                                message.replyTo?.let { o.put("replyTo", it.toJson()) }
                                message.file?.let { o.put("file", it.toJson()) }
                            }.toString(),
                    )
                } else {
                    null
                },
            ),
        )
    }

    /* ---- files ---- */

    private fun fileOf(messageId: String): java.io.File {
        val dir = filesDir ?: throw IllegalStateException("Files are not available here.")
        dir.mkdirs()
        // The id is validated before it reaches here (isValidClientMessageId), never a path.
        require(messageId.all { it.isLetterOrDigit() || it == '-' || it == '_' }) { "Bad file id." }
        return java.io.File(dir, messageId)
    }

    fun putFile(messageId: String, bytes: ByteArray) {
        fileOf(messageId).writeBytes(crypto.encryptBytes(bytes))
    }

    fun getFile(messageId: String): ByteArray? {
        val f = fileOf(messageId)
        return if (f.isFile) crypto.decryptBytes(f.readBytes()) else null
    }

    fun clearFiles() {
        filesDir?.deleteRecursively()
    }

    suspend fun updateMessage(
        messageId: String,
        deliveryState: DeliveryState? = null,
        transport: TransportKind? = null,
        readAt: Long? = null,
        setReadAt: Boolean = false,
    ) {
        if (deliveryState != null) dao.updateMessageDelivery(messageId, deliveryState.name)
        if (transport != null) dao.updateMessageTransport(messageId, transport.wire)
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

    suspend fun enqueueOutbox(row: OutboxRow, conversationId: String) {
        dao.putOutbox(
            OutboxEntity(
                key = row.key,
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

    suspend fun updateOutboxDelivery(row: OutboxRow, deliveryState: DeliveryState, lastAttemptAt: Long?) =
        dao.updateOutboxDelivery(row.key, deliveryState.name, lastAttemptAt)

    suspend fun removeOutbox(messageId: String, recipientId: String) = dao.removeOutbox("$messageId|$recipientId")

    suspend fun updateRecipients(messageId: String, total: Int) = dao.updateMessageRecipients(messageId, total)

    /** Messages and queue rows saved by the single-friend version belong to the friend that was paired then. */
    suspend fun adoptLegacyConversation(contactUid: String) {
        dao.moveMessages(MessageEntity.LEGACY_CONVERSATION_ID, contactUid)
        dao.moveOutbox(MessageEntity.LEGACY_CONVERSATION_ID, contactUid)
    }

    suspend fun clearAll() {
        dao.clearMessages()
        dao.clearOutbox()
        clearFiles()
    }

    suspend fun clearConversation(conversationId: String) {
        for (row in dao.loadMessagesFor(conversationId, Int.MAX_VALUE)) {
            runCatching { fileOf(row.messageId).delete() }
        }
        dao.clearMessagesFor(conversationId)
        dao.clearOutboxFor(conversationId)
    }

    /* ---- contacts ---- */

    suspend fun loadContacts(): List<ContactEntity> = dao.loadContacts()
    suspend fun putContact(contact: ContactEntity) = dao.putContact(contact)
    suspend fun deleteContact(uid: String) = dao.deleteContact(uid)
    suspend fun renameContact(uid: String, name: String) = dao.renameContact(uid, name)
    suspend fun setContactTrust(uid: String, trust: ContactTrust, verifiedAt: Long?) =
        dao.setContactTrust(uid, trust.wire, verifiedAt)
    suspend fun setContactProof(uid: String, proof: String) = dao.setContactProof(uid, proof)

    /* ---- group logs ---- */

    suspend fun loadGroupLogs(): Map<String, List<JSONObject>> =
        dao.loadGroupLogs().mapNotNull { row ->
            try {
                val array = JSONArray(crypto.decrypt(row.eventsCipher))
                row.groupId to List(array.length()) { array.getJSONObject(it) }
            } catch (_: Exception) {
                null
            }
        }.toMap()

    suspend fun saveGroupLog(groupId: String, events: List<JSONObject>) {
        val array = JSONArray()
        events.forEach { array.put(it) }
        dao.putGroupLog(GroupLogEntity(groupId, crypto.encrypt(array.toString()), System.currentTimeMillis()))
    }

    suspend fun deleteGroupLog(groupId: String) = dao.deleteGroupLog(groupId)

    companion object {
        /** Older history stays on disk but is not loaded into memory. */
        const val MAX_LOADED_MESSAGES = 4000
    }
}
