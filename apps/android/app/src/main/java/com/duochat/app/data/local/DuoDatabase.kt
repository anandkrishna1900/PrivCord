package com.duochat.app.data.local

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

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
    /**
     * Scope column (database v2). Historic rows are backfilled to the legacy
     * single-conversation id "duo" so the per-conversation kill switch can
     * address exactly one chat without destructive migration.
     */
    val conversationId: String = LEGACY_CONVERSATION_ID,
) {
    companion object {
        const val LEGACY_CONVERSATION_ID = "duo"
    }
}

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
    /** Same scope column as messages (database v2, backfilled to "duo"). */
    val conversationId: String = LEGACY_CONVERSATION_ID,
) {
    companion object {
        const val LEGACY_CONVERSATION_ID = "duo"
    }
}

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

    @Query("DELETE FROM messages WHERE conversationId = :conversationId")
    suspend fun clearMessagesFor(conversationId: String)

    @Query("DELETE FROM outbox WHERE conversationId = :conversationId")
    suspend fun clearOutboxFor(conversationId: String)
}

@Database(
    entities = [MessageEntity::class, OutboxEntity::class],
    version = 2,
    exportSchema = false,
)
abstract class DuoDatabase : RoomDatabase() {
    abstract fun dao(): DuoDao

    companion object {
        /**
         * Non-destructive migration v1 → v2: adds the per-conversation scope
         * columns and backfills every existing row to the legacy conversation
         * id, so existing histories continue to work untouched.
         */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "ALTER TABLE messages ADD COLUMN conversationId TEXT NOT NULL DEFAULT 'duo'",
                )
                db.execSQL(
                    "ALTER TABLE outbox ADD COLUMN conversationId TEXT NOT NULL DEFAULT 'duo'",
                )
            }
        }
    }
}
