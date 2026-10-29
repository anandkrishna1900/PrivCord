package com.duochat.app.data.local

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase

@Entity(tableName = "messages")
data class MessageEntity(
    @PrimaryKey val messageId: String,
    val clientMessageId: String,
    val senderId: String,
    val textCipher: String,
    val clientCreatedAt: Long,
    val serverCreatedAt: Long?,
    val transport: String,
    val deliveryState: String,
    val syncedToCloud: Boolean,
    val readAt: Long?,
)

@Entity(tableName = "outbox")
data class OutboxEntity(
    @PrimaryKey val messageId: String,
    val recipientId: String,
    val payloadCipher: String,
    val createdAt: Long,
    val attemptCount: Int,
    val lastAttemptAt: Long?,
    val deliveryState: String,
    val lastError: String?,
)

@Dao
interface DuoDao {
    @Query("SELECT * FROM messages ORDER BY clientCreatedAt DESC, messageId DESC LIMIT :limit")
    suspend fun loadMessages(limit: Int): List<MessageEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putMessage(message: MessageEntity)

    @Query("UPDATE messages SET deliveryState = :state WHERE messageId = :messageId")
    suspend fun updateMessageDelivery(messageId: String, state: String)

    @Query("UPDATE messages SET transport = :transport WHERE messageId = :messageId")
    suspend fun updateMessageTransport(messageId: String, transport: String)

    @Query("UPDATE messages SET syncedToCloud = :synced WHERE messageId = :messageId")
    suspend fun updateMessageSynced(messageId: String, synced: Boolean)

    @Query("UPDATE messages SET readAt = :readAt WHERE messageId = :messageId")
    suspend fun updateMessageReadAt(messageId: String, readAt: Long?)

    @Query("SELECT * FROM outbox ORDER BY createdAt ASC")
    suspend fun loadOutbox(): List<OutboxEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putOutbox(row: OutboxEntity)

    @Query(
        "UPDATE outbox SET attemptCount = :attemptCount, lastAttemptAt = :lastAttemptAt, " +
            "deliveryState = :deliveryState, lastError = :lastError WHERE messageId = :messageId",
    )
    suspend fun updateOutboxAttempt(
        messageId: String,
        attemptCount: Int,
        lastAttemptAt: Long?,
        deliveryState: String,
        lastError: String?,
    )

    @Query(
        "UPDATE outbox SET deliveryState = :deliveryState, lastAttemptAt = :lastAttemptAt " +
            "WHERE messageId = :messageId",
    )
    suspend fun updateOutboxDelivery(
        messageId: String,
        deliveryState: String,
        lastAttemptAt: Long?,
    )

    @Query("DELETE FROM outbox WHERE messageId = :messageId")
    suspend fun removeOutbox(messageId: String)

    @Query("DELETE FROM messages")
    suspend fun clearMessages()

    @Query("DELETE FROM outbox")
    suspend fun clearOutbox()
}

@Database(
    entities = [MessageEntity::class, OutboxEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class DuoDatabase : RoomDatabase() {
    abstract fun dao(): DuoDao
}
