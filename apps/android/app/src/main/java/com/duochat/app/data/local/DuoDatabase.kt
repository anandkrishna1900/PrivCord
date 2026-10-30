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
)

@Entity(tableName = "groups")
data class GroupEntity(
    @PrimaryKey val groupId: String,
    val name: String,
    val avatarUrl: String?,
    val createdBy: String,
    val createdAt: Long,
    val currentEpoch: Int = 1,
)

@Entity(tableName = "group_members")
data class GroupMemberEntity(
    val groupId: String,
    val uid: String,
    val role: String, // "admin" | "member"
    val joinedEpoch: Int,
    val addedBy: String,
    @PrimaryKey val id: String = "$groupId:$uid",
)

@Entity(tableName = "group_epoch_keys")
data class GroupEpochKeyEntity(
    val groupId: String,
    val epoch: Int,
    val keyCipher: String, // AES-encrypted epoch key
    @PrimaryKey val id: String = "$groupId:$epoch",
)

@Entity(tableName = "file_transfers")
data class FileTransferEntity(
    @PrimaryKey val transferId: String,
    val conversationId: String,
    val name: String,
    val mimeType: String,
    val size: Long,
    val sha256: String,
    val totalChunks: Int,
    val receivedChunks: Int,
    val state: String, // "queued" | "transferring" | "paused" | "completed" | "failed" | "cancelled"
    val localPath: String?,
    val keyB64Url: String,
    val createdAt: Long = System.currentTimeMillis(),
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

    @Query("SELECT * FROM outbox WHERE conversationId = :conversationId ORDER BY createdAt ASC")
    suspend fun loadOutboxFor(conversationId: String): List<OutboxEntity>

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

    // Groups
    @Query("SELECT * FROM groups ORDER BY createdAt DESC")
    suspend fun loadGroups(): List<GroupEntity>

    @Query("SELECT * FROM groups WHERE groupId = :groupId LIMIT 1")
    suspend fun getGroup(groupId: String): GroupEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putGroup(group: GroupEntity)

    @Query("DELETE FROM groups WHERE groupId = :groupId")
    suspend fun deleteGroup(groupId: String)

    @Query("DELETE FROM groups")
    suspend fun clearGroups()

    // Group Members
    @Query("SELECT * FROM group_members WHERE groupId = :groupId")
    suspend fun loadGroupMembers(groupId: String): List<GroupMemberEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putGroupMember(member: GroupMemberEntity)

    @Query("DELETE FROM group_members WHERE groupId = :groupId AND uid = :uid")
    suspend fun removeGroupMember(groupId: String, uid: String)

    @Query("DELETE FROM group_members WHERE groupId = :groupId")
    suspend fun clearGroupMembers(groupId: String)

    @Query("DELETE FROM group_members")
    suspend fun clearAllGroupMembers()

    // Group Epoch Keys
    @Query("SELECT * FROM group_epoch_keys WHERE groupId = :groupId AND epoch = :epoch LIMIT 1")
    suspend fun getEpochKey(groupId: String, epoch: Int): GroupEpochKeyEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putEpochKey(key: GroupEpochKeyEntity)

    @Query("DELETE FROM group_epoch_keys WHERE groupId = :groupId")
    suspend fun clearGroupEpochKeys(groupId: String)

    @Query("DELETE FROM group_epoch_keys")
    suspend fun clearAllGroupEpochKeys()

    // File Transfers
    @Query("SELECT * FROM file_transfers WHERE conversationId = :conversationId ORDER BY createdAt DESC")
    suspend fun loadFileTransfers(conversationId: String): List<FileTransferEntity>

    @Query("SELECT * FROM file_transfers WHERE transferId = :transferId LIMIT 1")
    suspend fun getFileTransfer(transferId: String): FileTransferEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putFileTransfer(transfer: FileTransferEntity)

    @Query("UPDATE file_transfers SET receivedChunks = :chunks, state = :state WHERE transferId = :transferId")
    suspend fun updateFileProgress(transferId: String, chunks: Int, state: String)

    @Query("DELETE FROM file_transfers WHERE transferId = :transferId")
    suspend fun deleteFileTransfer(transferId: String)

    @Query("DELETE FROM file_transfers")
    suspend fun clearFileTransfers()
}

@Database(
    entities = [
        MessageEntity::class,
        OutboxEntity::class,
        ContactEntity::class,
        GroupEntity::class,
        GroupMemberEntity::class,
        GroupEpochKeyEntity::class,
        FileTransferEntity::class,
    ],
    version = 4,
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
    }
}
