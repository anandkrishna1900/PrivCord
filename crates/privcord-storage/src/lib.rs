//! SQLite storage for the engine.
//!
//! One implementation for every platform; only the database *path* differs (the platform adapter supplies it).
//! Design points, all from the PRD's storage requirements:
//! * every change is a batch applied in one transaction, so a message never exists without its outbox entry;
//! * the schema is versioned with `PRAGMA user_version`; migrations run one transaction each, and an existing
//!   database is copied to `<name>.bak-v<old>` before its first migration;
//! * a database written by a newer version is refused, never downgraded or "repaired";
//! * the file is checked with `PRAGMA integrity_check` when opened;
//! * statements are prepared and cached, and one connection is owned for the store's whole life.

use privcord_domain::{
    message::{ChatMessage, DeliveryState, MessageKind, ReplyRef, TransportKind},
    privacy::ContactTrust,
    ConversationId, GroupId, MessageId, UserId,
};
use privcord_ports::{
    EraseScope, OutboxEntry, Storage, StorageError, StorageOp, StoredContact, StoredFile,
    StoredMessage, StoredReaction,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};

/// The newest schema this build understands.
pub const SCHEMA_VERSION: i64 = 3;

/// Each entry takes the database from version `index` to `index + 1`.
const MIGRATIONS: &[&str] = &[
    // 0 -> 1
    "CREATE TABLE contacts (
        uid TEXT PRIMARY KEY NOT NULL,
        card TEXT NOT NULL,
        name TEXT,
        trust TEXT NOT NULL CHECK (trust IN ('verified', 'introduced')),
        checked INTEGER NOT NULL CHECK (checked IN (0, 1)),
        introduced_by TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
        message_id TEXT PRIMARY KEY NOT NULL,
        conversation TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        text TEXT NOT NULL,
        client_created_at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'file')),
        transport TEXT NOT NULL CHECK (transport IN ('p2p', 'relay')),
        delivery_state TEXT NOT NULL CHECK (delivery_state IN ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED')),
        read_at INTEGER,
        reply_id TEXT,
        reply_author TEXT,
        reply_preview TEXT
    );
    CREATE INDEX idx_messages_conversation ON messages (conversation, client_created_at, message_id);
    CREATE TABLE outbox (
        message_id TEXT NOT NULL REFERENCES messages (message_id) ON DELETE CASCADE,
        recipient TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        next_try_ms INTEGER NOT NULL,
        PRIMARY KEY (message_id, recipient)
    );
    CREATE INDEX idx_outbox_recipient ON outbox (recipient, next_try_ms);
    CREATE TABLE kv (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL);",
    // 1 -> 2: file bytes live beside, not inside, the message rows.
    "CREATE TABLE files (
        message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages (message_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes BLOB NOT NULL
    );",
    // 2 -> 3: reactions, and the mark for messages deleted for everyone.
    "CREATE TABLE reactions (
        message_id TEXT NOT NULL REFERENCES messages (message_id) ON DELETE CASCADE,
        uid TEXT NOT NULL,
        emoji TEXT NOT NULL,
        PRIMARY KEY (message_id, uid)
    );
    ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;",
];

pub struct SqliteStorage {
    conn: Mutex<Connection>,
}

impl std::fmt::Debug for SqliteStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SqliteStorage(..)")
    }
}

fn unavailable<E>(_: E) -> StorageError {
    StorageError::Unavailable
}

fn init(
    conn: &Connection,
    migrations: &[&str],
    backup_of: Option<&Path>,
) -> Result<(), StorageError> {
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(unavailable)?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(unavailable)?;
    // Deleted rows are overwritten, not just unlinked, so an erase leaves nothing readable in the free pages.
    conn.pragma_update(None, "secure_delete", true)
        .map_err(unavailable)?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(unavailable)?;
    let check: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|_| StorageError::Corrupt)?;
    if check != "ok" {
        return Err(StorageError::Corrupt);
    }
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(unavailable)?;
    let target = i64::try_from(migrations.len()).map_err(unavailable)?;
    if version > target {
        return Err(StorageError::NewerVersion);
    }
    if version < target {
        // Keep a copy of a database that already holds data before changing its shape.
        if let (Some(path), true) = (backup_of, version > 0) {
            let name = format!(
                "{}.bak-v{version}",
                path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("privcord.db")
            );
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
                .map_err(unavailable)?;
            std::fs::copy(path, path.with_file_name(name)).map_err(unavailable)?;
        }
        for (i, sql) in migrations
            .iter()
            .enumerate()
            .skip(usize::try_from(version).map_err(unavailable)?)
        {
            // One transaction per step: an interrupted or failing migration leaves the previous version intact.
            let tx = conn.unchecked_transaction().map_err(unavailable)?;
            tx.execute_batch(sql).map_err(|_| StorageError::Rejected)?;
            tx.pragma_update(
                None,
                "user_version",
                i64::try_from(i + 1).map_err(unavailable)?,
            )
            .map_err(unavailable)?;
            tx.commit().map_err(unavailable)?;
        }
    }
    Ok(())
}

impl SqliteStorage {
    /// Open (and migrate) a database file.
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        Self::open_with(path, MIGRATIONS)
    }

    #[doc(hidden)]
    pub fn open_with(path: &Path, migrations: &[&str]) -> Result<Self, StorageError> {
        let conn = Connection::open(path).map_err(unavailable)?;
        init(&conn, migrations, Some(path))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// A throwaway in-memory database.
    pub fn in_memory() -> Result<Self, StorageError> {
        let conn = Connection::open_in_memory().map_err(unavailable)?;
        init(&conn, MIGRATIONS, None)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn schema_version(&self) -> Result<i64, StorageError> {
        self.lock()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(unavailable)
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn conversation_key(c: &ConversationId) -> String {
    match c {
        ConversationId::Direct(u) => format!("direct:{u}"),
        ConversationId::Group(g) => format!("group:{g}"),
        ConversationId::Channel(n) => format!("chan:{n}"),
    }
}

fn parse_conversation(s: &str) -> Option<ConversationId> {
    let (kind, rest) = s.split_once(':')?;
    match kind {
        "direct" => UserId::new(rest).ok().map(ConversationId::Direct),
        "group" => GroupId::new(rest).ok().map(ConversationId::Group),
        "chan" => Some(ConversationId::Channel(rest.to_owned())),
        _ => None,
    }
}

fn state_str(s: DeliveryState) -> &'static str {
    match s {
        DeliveryState::Queued => "QUEUED",
        DeliveryState::Sent => "SENT",
        DeliveryState::Delivered => "DELIVERED",
        DeliveryState::Read => "READ",
        DeliveryState::Failed => "FAILED",
    }
}

fn parse_state(s: &str) -> Option<DeliveryState> {
    Some(match s {
        "QUEUED" => DeliveryState::Queued,
        "SENT" => DeliveryState::Sent,
        "DELIVERED" => DeliveryState::Delivered,
        "READ" => DeliveryState::Read,
        "FAILED" => DeliveryState::Failed,
        _ => return None,
    })
}

fn apply_op(tx: &rusqlite::Transaction<'_>, op: &StorageOp) -> Result<(), StorageError> {
    let rej = |_| StorageError::Rejected;
    match op {
        StorageOp::PutContact(c) => {
            tx.prepare_cached(
                "INSERT INTO contacts (uid, card, name, trust, checked, introduced_by, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(uid) DO UPDATE SET card=?2, name=?3, trust=?4, checked=?5, introduced_by=?6",
            )
            .and_then(|mut s| {
                s.execute(params![
                    c.uid.as_str(),
                    c.card,
                    c.name,
                    if c.trust == ContactTrust::Verified { "verified" } else { "introduced" },
                    i64::from(c.checked),
                    c.introduced_by.as_ref().map(UserId::as_str),
                    c.created_at
                ])
            })
            .map_err(rej)?;
        }
        StorageOp::DeleteContact(u) => {
            tx.execute("DELETE FROM contacts WHERE uid = ?1", params![u.as_str()])
                .map_err(rej)?;
        }
        StorageOp::InsertMessage(m) => {
            let msg = &m.message;
            tx.prepare_cached(
                "INSERT OR IGNORE INTO messages (message_id, conversation, client_message_id, sender_id, text, client_created_at,
                 kind, transport, delivery_state, read_at, reply_id, reply_author, reply_preview)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            )
            .and_then(|mut s| {
                s.execute(params![
                    msg.message_id.as_str(),
                    conversation_key(&m.conversation),
                    msg.client_message_id.as_str(),
                    msg.sender_id.as_str(),
                    msg.text,
                    msg.client_created_at,
                    if msg.kind == MessageKind::Text { "text" } else { "file" },
                    if msg.transport == TransportKind::P2p { "p2p" } else { "relay" },
                    state_str(msg.delivery_state),
                    msg.read_at,
                    msg.reply_to.as_ref().map(|r| r.id.clone()),
                    msg.reply_to.as_ref().map(|r| r.author.clone()),
                    msg.reply_to.as_ref().map(|r| r.preview.clone()),
                ])
            })
            .map_err(rej)?;
        }
        StorageOp::SetDelivery { id, state, read_at } => {
            let n = tx
                .execute(
                    "UPDATE messages SET delivery_state = ?2, read_at = COALESCE(?3, read_at) WHERE message_id = ?1",
                    params![id.as_str(), state_str(*state), read_at],
                )
                .map_err(rej)?;
            if n == 0 {
                return Err(StorageError::Rejected);
            }
        }
        StorageOp::Erase(scope) => {
            let sql: &[&str] = match scope {
                EraseScope::Conversation(c) => {
                    tx.execute(
                        "DELETE FROM messages WHERE conversation = ?1",
                        params![conversation_key(c)],
                    )
                    .map_err(rej)?;
                    &[]
                }
                EraseScope::Messages => &["DELETE FROM messages"],
                EraseScope::Contacts => &["DELETE FROM contacts"],
                EraseScope::Files => &["DELETE FROM files"],
                EraseScope::Outbox => &["DELETE FROM outbox"],
                EraseScope::All => &[
                    "DELETE FROM messages",
                    "DELETE FROM contacts",
                    "DELETE FROM kv",
                    "DELETE FROM outbox",
                    "DELETE FROM files",
                ],
            };
            for q in sql {
                tx.execute(q, []).map_err(rej)?;
            }
        }
        StorageOp::SetReaction {
            message_id,
            uid,
            emoji,
        } => {
            // The message must exist (the foreign key enforces it for inserts).
            match emoji {
                Some(e) => tx
                    .execute(
                        "INSERT INTO reactions (message_id, uid, emoji) VALUES (?1,?2,?3)
                         ON CONFLICT(message_id, uid) DO UPDATE SET emoji = ?3",
                        params![message_id.as_str(), uid.as_str(), e],
                    )
                    .map(|_| ())
                    .map_err(rej)?,
                None => {
                    tx.execute(
                        "DELETE FROM reactions WHERE message_id = ?1 AND uid = ?2",
                        params![message_id.as_str(), uid.as_str()],
                    )
                    .map_err(rej)?;
                }
            }
        }
        StorageOp::Tombstone(id) => {
            let changed = tx
                .execute(
                    "UPDATE messages SET text = '', kind = 'text', reply_id = NULL, reply_author = NULL, reply_preview = NULL,
                     deleted = 1 WHERE message_id = ?1",
                    params![id.as_str()],
                )
                .map_err(rej)?;
            if changed == 0 {
                return Err(StorageError::Rejected);
            }
            for q in [
                "DELETE FROM files WHERE message_id = ?1",
                "DELETE FROM reactions WHERE message_id = ?1",
                "DELETE FROM outbox WHERE message_id = ?1",
            ] {
                tx.execute(q, params![id.as_str()]).map_err(rej)?;
            }
        }
        StorageOp::PutFile(f) => {
            tx.prepare_cached(
                "INSERT INTO files (message_id, name, mime, bytes) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(message_id) DO UPDATE SET name=?2, mime=?3, bytes=?4",
            )
            .and_then(|mut s| s.execute(params![f.message_id.as_str(), f.name, f.mime, f.bytes]))
            .map_err(rej)?;
        }
        StorageOp::DeleteMessage(id) => {
            tx.execute(
                "DELETE FROM messages WHERE message_id = ?1",
                params![id.as_str()],
            )
            .map_err(rej)?;
        }
        StorageOp::PutOutbox(e) => {
            // The foreign key makes an entry for an unknown message fail, rolling back the whole batch.
            tx.prepare_cached(
                "INSERT INTO outbox (message_id, recipient, attempts, next_try_ms) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(message_id, recipient) DO UPDATE SET attempts=?3, next_try_ms=?4",
            )
            .and_then(|mut s| s.execute(params![e.message_id.as_str(), e.recipient.as_str(), e.attempts, e.next_try_ms]))
            .map_err(rej)?;
        }
        StorageOp::RemoveOutbox {
            message_id,
            recipient,
        } => {
            tx.execute(
                "DELETE FROM outbox WHERE message_id = ?1 AND recipient = ?2",
                params![message_id.as_str(), recipient.as_str()],
            )
            .map_err(rej)?;
        }
        StorageOp::SetKv { key, value } => {
            tx.execute("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2", params![key, value]).map_err(rej)?;
        }
    }
    Ok(())
}

impl Storage for SqliteStorage {
    fn apply(&self, batch: &[StorageOp]) -> Result<(), StorageError> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(unavailable)?;
        for op in batch {
            // On any error the transaction is dropped without commit, which rolls back every earlier op in the batch.
            apply_op(&tx, op)?;
        }
        tx.commit().map_err(unavailable)
    }

    fn contacts(&self) -> Result<Vec<StoredContact>, StorageError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare_cached("SELECT uid, card, name, trust, checked, introduced_by, created_at FROM contacts ORDER BY uid")
            .map_err(unavailable)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            })
            .map_err(unavailable)?;
        let mut out = Vec::new();
        for row in rows {
            let (uid, card, name, trust, checked, introduced_by, created_at) =
                row.map_err(|_| StorageError::Corrupt)?;
            out.push(StoredContact {
                uid: UserId::new(uid).map_err(|_| StorageError::Corrupt)?,
                card,
                name,
                trust: if trust == "verified" {
                    ContactTrust::Verified
                } else {
                    ContactTrust::Introduced
                },
                checked: checked != 0,
                introduced_by: introduced_by
                    .map(UserId::new)
                    .transpose()
                    .map_err(|_| StorageError::Corrupt)?,
                created_at,
            });
        }
        Ok(out)
    }

    fn messages(&self) -> Result<Vec<StoredMessage>, StorageError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare_cached(
                "SELECT message_id, conversation, client_message_id, sender_id, text, client_created_at, kind, transport,
                 delivery_state, read_at, reply_id, reply_author, reply_preview FROM messages ORDER BY client_created_at, message_id",
            )
            .map_err(unavailable)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, Option<i64>>(9)?,
                    (
                        r.get::<_, Option<String>>(10)?,
                        r.get::<_, Option<String>>(11)?,
                        r.get::<_, Option<String>>(12)?,
                    ),
                ))
            })
            .map_err(unavailable)?;
        let mut out = Vec::new();
        for row in rows {
            let (
                id,
                conv,
                cid,
                sender,
                text,
                at,
                kind,
                transport,
                state,
                read_at,
                (rid, rauthor, rprev),
            ) = row.map_err(|_| StorageError::Corrupt)?;
            let bad = |_| StorageError::Corrupt;
            out.push(StoredMessage {
                conversation: parse_conversation(&conv).ok_or(StorageError::Corrupt)?,
                message: ChatMessage {
                    message_id: MessageId::new(id).map_err(bad)?,
                    client_message_id: MessageId::new(cid).map_err(bad)?,
                    sender_id: UserId::new(sender).map_err(bad)?,
                    text,
                    client_created_at: at,
                    kind: if kind == "file" {
                        MessageKind::File
                    } else {
                        MessageKind::Text
                    },
                    transport: if transport == "relay" {
                        TransportKind::Relay
                    } else {
                        TransportKind::P2p
                    },
                    delivery_state: parse_state(&state).ok_or(StorageError::Corrupt)?,
                    reply_to: match (rid, rauthor, rprev) {
                        (Some(id), Some(author), Some(preview)) => Some(ReplyRef {
                            id,
                            author,
                            preview,
                        }),
                        _ => None,
                    },
                    read_at,
                },
            });
        }
        Ok(out)
    }

    fn outbox(&self) -> Result<Vec<OutboxEntry>, StorageError> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached("SELECT message_id, recipient, attempts, next_try_ms FROM outbox ORDER BY next_try_ms, message_id").map_err(unavailable)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, u32>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(unavailable)?;
        let mut out = Vec::new();
        for row in rows {
            let (id, recipient, attempts, next) = row.map_err(|_| StorageError::Corrupt)?;
            out.push(OutboxEntry {
                message_id: MessageId::new(id).map_err(|_| StorageError::Corrupt)?,
                recipient: UserId::new(recipient).map_err(|_| StorageError::Corrupt)?,
                attempts,
                next_try_ms: next,
            });
        }
        Ok(out)
    }

    fn file_info(&self, id: &MessageId) -> Result<Option<privcord_ports::FileInfo>, StorageError> {
        self.lock()
            .query_row(
                "SELECT mime, length(bytes) FROM files WHERE message_id = ?1",
                params![id.as_str()],
                |r| {
                    let size: i64 = r.get(1)?;
                    Ok(privcord_ports::FileInfo {
                        mime: r.get(0)?,
                        size: u64::try_from(size).unwrap_or(0),
                    })
                },
            )
            .optional()
            .map_err(unavailable)
    }

    fn file(&self, id: &MessageId) -> Result<Option<StoredFile>, StorageError> {
        self.lock()
            .query_row(
                "SELECT name, mime, bytes FROM files WHERE message_id = ?1",
                params![id.as_str()],
                |r| {
                    Ok(StoredFile {
                        message_id: id.clone(),
                        name: r.get(0)?,
                        mime: r.get(1)?,
                        bytes: r.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(unavailable)
    }

    fn reactions(&self) -> Result<Vec<StoredReaction>, StorageError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare_cached("SELECT message_id, uid, emoji FROM reactions ORDER BY message_id, uid")
            .map_err(unavailable)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(unavailable)?;
        let mut out = Vec::new();
        for row in rows {
            let (m, u, emoji) = row.map_err(unavailable)?;
            out.push(StoredReaction {
                message_id: MessageId::new(m).map_err(|_| StorageError::Corrupt)?,
                uid: UserId::new(u).map_err(|_| StorageError::Corrupt)?,
                emoji,
            });
        }
        Ok(out)
    }

    fn deleted(&self) -> Result<Vec<MessageId>, StorageError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare_cached("SELECT message_id FROM messages WHERE deleted = 1")
            .map_err(unavailable)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(unavailable)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(MessageId::new(row.map_err(unavailable)?).map_err(|_| StorageError::Corrupt)?);
        }
        Ok(out)
    }

    fn kv(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        self.lock()
            .query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(unavailable)
    }
}
