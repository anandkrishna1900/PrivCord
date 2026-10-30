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
    val transport: String,
    val deliveryState: String,
    val readAt: Long?,
    /** A contact's uid for a direct chat, the group id for a group. Legacy rows carry "duo" until migrated. */
    val conversationId: String = LEGACY_CONVERSATION_ID,
    /** Group messages only: how many members it had to reach (the delivery detail is this minus the pending outbox rows). */
    val totalRecipients: Int = 0,
) {
    companion object {
        const val LEGACY_CONVERSATION_ID = "duo"
    }
}

/** One row per (message, recipient): a group message waits separately for each member. */
@Entity(tableName = "outbox")
data class OutboxEntity(
    @PrimaryKey val key: String,
    val messageId: String,
    val recipientId: String,
    val payloadCipher: String,
    val createdAt: Long,
    val attemptCount: Int,
    val lastAttemptAt: Long?,
    val deliveryState: String,
    val lastError: String?,
    val conversationId: String = LEGACY_CONVERSATION_ID,
) {
    companion object {
        const val LEGACY_CONVERSATION_ID = "duo"
    }
}

@Entity(tableName = "contacts")
data class ContactEntity(
    @PrimaryKey val uid: String,
    val name: String,
    val signPubX: String,
    val signPubY: String,
    val dhPubX: String,
    val dhPubY: String,
    val identityProof: String,
    val safetyNumber: String,
    val isBlocked: Boolean = false,
    val verifiedAt: Long? = null,
    val createdAt: Long = System.currentTimeMillis(),
    /** "verified": we exchanged cards. "introduced": we learned the card from a group roster. */
    val trust: String = "verified",
    /** For introduced contacts: the uid of the member who added them to the group. */
    val introducedBy: String? = null,
)

/** A group is its signed event log; the whole log (encrypted at rest) is rewritten when it changes. */
@Entity(tableName = "group_logs")
data class GroupLogEntity(
    @PrimaryKey val groupId: String,
    val eventsCipher: String,
    val updatedAt: Long,
)

@Dao
interface DuoDao {
    @Query("SELECT * FROM messages ORDER BY clientCreatedAt DESC, messageId DESC LIMIT :limit")
    suspend fun loadMessages(limit: Int): List<MessageEntity>

    @Query("SELECT * FROM messages WHERE conversationId = :conversationId ORDER BY clientCreatedAt DESC, messageId DESC LIMIT :limit")
    suspend fun loadMessagesFor(conversationId: String, limit: Int): List<MessageEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putMessage(message: MessageEntity)

    @Query("UPDATE messages SET deliveryState = :state WHERE messageId = :messageId")
    suspend fun updateMessageDelivery(messageId: String, state: String)

    @Query("UPDATE messages SET transport = :transport WHERE messageId = :messageId")
    suspend fun updateMessageTransport(messageId: String, transport: String)

    @Query("UPDATE messages SET readAt = :readAt WHERE messageId = :messageId")
    suspend fun updateMessageReadAt(messageId: String, readAt: Long?)

    @Query("SELECT * FROM outbox ORDER BY createdAt ASC")
    suspend fun loadOutbox(): List<OutboxEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putOutbox(row: OutboxEntity)

    @Query(
        "UPDATE outbox SET attemptCount = :attemptCount, lastAttemptAt = :lastAttemptAt, " +
            "deliveryState = :deliveryState, lastError = :lastError WHERE `key` = :key",
    )
    suspend fun updateOutboxAttempt(
        key: String,
        attemptCount: Int,
        lastAttemptAt: Long?,
        deliveryState: String,
        lastError: String?,
    )

    @Query("UPDATE outbox SET deliveryState = :deliveryState, lastAttemptAt = :lastAttemptAt WHERE `key` = :key")
    suspend fun updateOutboxDelivery(key: String, deliveryState: String, lastAttemptAt: Long?)

    @Query("DELETE FROM outbox WHERE `key` = :key")
    suspend fun removeOutbox(key: String)

    @Query("UPDATE messages SET totalRecipients = :total WHERE messageId = :messageId")
    suspend fun updateMessageRecipients(messageId: String, total: Int)

    @Query("UPDATE messages SET conversationId = :to WHERE conversationId = :from")
    suspend fun moveMessages(from: String, to: String)

    @Query("UPDATE outbox SET conversationId = :to WHERE conversationId = :from")
    suspend fun moveOutbox(from: String, to: String)

    @Query("DELETE FROM messages")
    suspend fun clearMessages()

    @Query("DELETE FROM outbox")
    suspend fun clearOutbox()

    @Query("DELETE FROM messages WHERE conversationId = :conversationId")
    suspend fun clearMessagesFor(conversationId: String)

    @Query("DELETE FROM outbox WHERE conversationId = :conversationId")
    suspend fun clearOutboxFor(conversationId: String)

    // Contacts
    @Query("SELECT * FROM contacts ORDER BY createdAt DESC")
    suspend fun loadContacts(): List<ContactEntity>

    @Query("SELECT * FROM contacts WHERE uid = :uid LIMIT 1")
    suspend fun getContact(uid: String): ContactEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putContact(contact: ContactEntity)

    @Query("DELETE FROM contacts WHERE uid = :uid")
    suspend fun deleteContact(uid: String)

    @Query("UPDATE contacts SET name = :name WHERE uid = :uid")
    suspend fun renameContact(uid: String, name: String)

    @Query("UPDATE contacts SET isBlocked = :blocked WHERE uid = :uid")
    suspend fun setContactBlocked(uid: String, blocked: Boolean)

    @Query("DELETE FROM contacts")
    suspend fun clearContacts()

    @Query("UPDATE contacts SET trust = :trust, verifiedAt = :verifiedAt WHERE uid = :uid")
    suspend fun setContactTrust(uid: String, trust: String, verifiedAt: Long?)

    @Query("UPDATE contacts SET identityProof = :proof WHERE uid = :uid")
    suspend fun setContactProof(uid: String, proof: String)

    // Group logs
    @Query("SELECT * FROM group_logs")
    suspend fun loadGroupLogs(): List<GroupLogEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putGroupLog(log: GroupLogEntity)

    @Query("DELETE FROM group_logs WHERE groupId = :groupId")
    suspend fun deleteGroupLog(groupId: String)

    @Query("DELETE FROM group_logs")
    suspend fun clearGroupLogs()
}

@Database(
    entities = [
        MessageEntity::class,
        OutboxEntity::class,
        ContactEntity::class,
        GroupLogEntity::class,
    ],
    version = 5,
    exportSchema = false,
)
abstract class DuoDatabase : RoomDatabase() {
    abstract fun dao(): DuoDao

    companion object {
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE messages ADD COLUMN conversationId TEXT NOT NULL DEFAULT 'duo'")
                db.execSQL("ALTER TABLE outbox ADD COLUMN conversationId TEXT NOT NULL DEFAULT 'duo'")
            }
        }

        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE messages_new (" +
                        "messageId TEXT NOT NULL, clientMessageId TEXT NOT NULL, " +
                        "senderId TEXT NOT NULL, textCipher TEXT NOT NULL, " +
                        "clientCreatedAt INTEGER NOT NULL, transport TEXT NOT NULL, " +
                        "deliveryState TEXT NOT NULL, readAt INTEGER, " +
                        "conversationId TEXT NOT NULL, PRIMARY KEY(messageId))",
                )
                db.execSQL(
                    "INSERT INTO messages_new (messageId, clientMessageId, senderId, textCipher, " +
                        "clientCreatedAt, transport, deliveryState, readAt, conversationId) " +
                        "SELECT messageId, clientMessageId, senderId, textCipher, clientCreatedAt, " +
                        "transport, deliveryState, readAt, conversationId FROM messages",
                )
                db.execSQL("DROP TABLE messages")
                db.execSQL("ALTER TABLE messages_new RENAME TO messages")
            }
        }

        /**
         * v3 -> v4: Adds multi-contact, group messaging, group members, epoch keys, and file transfer tables.
         */
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS contacts (" +
                        "uid TEXT NOT NULL PRIMARY KEY, " +
                        "name TEXT NOT NULL, " +
                        "signPubX TEXT NOT NULL, signPubY TEXT NOT NULL, " +
                        "dhPubX TEXT NOT NULL, dhPubY TEXT NOT NULL, " +
                        "identityProof TEXT NOT NULL, " +
                        "safetyNumber TEXT NOT NULL, " +
                        "isBlocked INTEGER NOT NULL DEFAULT 0, " +
                        "verifiedAt INTEGER, " +
                        "createdAt INTEGER NOT NULL)",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS groups (" +
                        "groupId TEXT NOT NULL PRIMARY KEY, " +
                        "name TEXT NOT NULL, " +
                        "avatarUrl TEXT, " +
                        "createdBy TEXT NOT NULL, " +
                        "createdAt INTEGER NOT NULL, " +
                        "currentEpoch INTEGER NOT NULL DEFAULT 1)",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS group_members (" +
                        "groupId TEXT NOT NULL, " +
                        "uid TEXT NOT NULL, " +
                        "role TEXT NOT NULL, " +
                        "joinedEpoch INTEGER NOT NULL, " +
                        "addedBy TEXT NOT NULL, " +
                        "id TEXT NOT NULL PRIMARY KEY)",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS group_epoch_keys (" +
                        "groupId TEXT NOT NULL, " +
                        "epoch INTEGER NOT NULL, " +
                        "keyCipher TEXT NOT NULL, " +
                        "id TEXT NOT NULL PRIMARY KEY)",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS file_transfers (" +
                        "transferId TEXT NOT NULL PRIMARY KEY, " +
                        "conversationId TEXT NOT NULL, " +
                        "name TEXT NOT NULL, " +
                        "mimeType TEXT NOT NULL, " +
                        "size INTEGER NOT NULL, " +
                        "sha256 TEXT NOT NULL, " +
                        "totalChunks INTEGER NOT NULL, " +
                        "receivedChunks INTEGER NOT NULL, " +
                        "state TEXT NOT NULL, " +
                        "localPath TEXT, " +
                        "keyB64Url TEXT NOT NULL, " +
                        "createdAt INTEGER NOT NULL)",
                )
            }
        }

        /**
         * v4 -> v5: real multi-contact and groups. The outbox gets one row per (message, recipient), contacts
         * learn how they were met, groups become signed event logs, and the never-used placeholder tables
         * (fake groups, epoch keys, file transfers) go away. Existing messages and the queue are kept.
         */
        val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE messages ADD COLUMN totalRecipients INTEGER NOT NULL DEFAULT 0")
                db.execSQL(
                    "CREATE TABLE outbox_new (" +
                        "`key` TEXT NOT NULL, messageId TEXT NOT NULL, recipientId TEXT NOT NULL, " +
                        "payloadCipher TEXT NOT NULL, createdAt INTEGER NOT NULL, attemptCount INTEGER NOT NULL, " +
                        "lastAttemptAt INTEGER, deliveryState TEXT NOT NULL, lastError TEXT, " +
                        "conversationId TEXT NOT NULL, PRIMARY KEY(`key`))",
                )
                db.execSQL(
                    "INSERT OR REPLACE INTO outbox_new (`key`, messageId, recipientId, payloadCipher, createdAt, " +
                        "attemptCount, lastAttemptAt, deliveryState, lastError, conversationId) " +
                        "SELECT messageId || '|' || recipientId, messageId, recipientId, payloadCipher, createdAt, " +
                        "attemptCount, lastAttemptAt, deliveryState, lastError, conversationId FROM outbox",
                )
                db.execSQL("DROP TABLE outbox")
                db.execSQL("ALTER TABLE outbox_new RENAME TO outbox")
                db.execSQL("ALTER TABLE contacts ADD COLUMN trust TEXT NOT NULL DEFAULT 'verified'")
                db.execSQL("ALTER TABLE contacts ADD COLUMN introducedBy TEXT")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS group_logs (" +
                        "groupId TEXT NOT NULL PRIMARY KEY, eventsCipher TEXT NOT NULL, updatedAt INTEGER NOT NULL)",
                )
                db.execSQL("DROP TABLE IF EXISTS groups")
                db.execSQL("DROP TABLE IF EXISTS group_members")
                db.execSQL("DROP TABLE IF EXISTS group_epoch_keys")
                db.execSQL("DROP TABLE IF EXISTS file_transfers")
            }
        }
    }
}
