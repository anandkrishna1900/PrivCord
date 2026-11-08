#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_domain::{
    message::{ChatMessage, DeliveryState, ReplyRef},
    privacy::ContactTrust,
    ConversationId, MessageId, UserId,
};
use privcord_ports::{OutboxEntry, Storage, StorageError, StorageOp, StoredContact, StoredMessage};
use privcord_storage::{SqliteStorage, SCHEMA_VERSION};

fn uid(s: &str) -> UserId {
    UserId::new(s).unwrap()
}
fn mid(s: &str) -> MessageId {
    MessageId::new(s).unwrap()
}
fn msg(id: &str, at: i64, text: &str) -> StoredMessage {
    StoredMessage {
        conversation: ConversationId::Direct(uid("bob")),
        message: ChatMessage::outgoing(
            uid("alice"),
            text,
            at,
            mid(id),
            Some(ReplyRef {
                id: "orig".into(),
                author: "bob".into(),
                preview: "quoted ✓".into(),
            }),
        )
        .unwrap(),
    }
}
fn outbox(id: &str) -> OutboxEntry {
    OutboxEntry {
        message_id: mid(id),
        recipient: uid("bob"),
        attempts: 0,
        next_try_ms: 5,
    }
}

#[test]
fn round_trips_everything() {
    let db = SqliteStorage::in_memory().unwrap();
    let contact = StoredContact {
        uid: uid("bob"),
        card: "DUOID1:x".into(),
        name: Some("Bob ✓".into()),
        trust: ContactTrust::Introduced,
        checked: true,
        introduced_by: Some(uid("carol")),
        created_at: 9,
    };
    db.apply(&[
        StorageOp::PutContact(contact.clone()),
        StorageOp::InsertMessage(msg("m1", 10, "héllo 😀")),
        StorageOp::PutOutbox(outbox("m1")),
        StorageOp::SetKv {
            key: "k".into(),
            value: vec![0, 1, 255],
        },
    ])
    .unwrap();
    assert_eq!(db.contacts().unwrap(), vec![contact]);
    let m = db.messages().unwrap();
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].message.text, "héllo 😀");
    assert_eq!(m[0].message.reply_to.as_ref().unwrap().preview, "quoted ✓");
    assert_eq!(m[0].conversation, ConversationId::Direct(uid("bob")));
    assert_eq!(db.outbox().unwrap(), vec![outbox("m1")]);
    assert_eq!(db.kv("k").unwrap(), Some(vec![0, 1, 255]));
    assert_eq!(db.kv("missing").unwrap(), None);
    assert_eq!(db.schema_version().unwrap(), SCHEMA_VERSION);
}

#[test]
fn inserting_a_message_twice_keeps_one_and_updates_are_applied() {
    let db = SqliteStorage::in_memory().unwrap();
    db.apply(&[StorageOp::InsertMessage(msg("m1", 10, "first"))])
        .unwrap();
    db.apply(&[StorageOp::InsertMessage(msg(
        "m1",
        11,
        "different text, same id",
    ))])
    .unwrap();
    assert_eq!(db.messages().unwrap().len(), 1);
    assert_eq!(db.messages().unwrap()[0].message.text, "first");
    db.apply(&[StorageOp::SetDelivery {
        id: mid("m1"),
        state: DeliveryState::Read,
        read_at: Some(77),
    }])
    .unwrap();
    let m = &db.messages().unwrap()[0].message;
    assert_eq!(
        (m.delivery_state, m.read_at),
        (DeliveryState::Read, Some(77))
    );
    // Setting a state on a message that does not exist is refused.
    assert_eq!(
        db.apply(&[StorageOp::SetDelivery {
            id: mid("nope"),
            state: DeliveryState::Sent,
            read_at: None
        }])
        .unwrap_err(),
        StorageError::Rejected
    );
}

#[test]
fn a_batch_is_all_or_nothing() {
    let db = SqliteStorage::in_memory().unwrap();
    // The third op names a message that does not exist: the first two must not survive.
    let err = db
        .apply(&[
            StorageOp::InsertMessage(msg("m1", 10, "a")),
            StorageOp::SetKv {
                key: "x".into(),
                value: vec![1],
            },
            StorageOp::PutOutbox(outbox("ghost")),
        ])
        .unwrap_err();
    assert_eq!(err, StorageError::Rejected);
    assert!(db.messages().unwrap().is_empty());
    assert_eq!(db.kv("x").unwrap(), None);
    assert!(db.outbox().unwrap().is_empty());
    // And the store still works afterwards.
    db.apply(&[
        StorageOp::InsertMessage(msg("m1", 10, "a")),
        StorageOp::PutOutbox(outbox("m1")),
    ])
    .unwrap();
    assert_eq!(db.outbox().unwrap().len(), 1);
    // Deleting a message takes its outbox entry with it.
    db.apply(&[StorageOp::DeleteMessage(mid("m1"))]).unwrap();
    assert!(db.outbox().unwrap().is_empty());
}

#[test]
fn data_survives_reopening_and_the_file_is_checked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("privcord.db");
    {
        let db = SqliteStorage::open(&path).unwrap();
        db.apply(&[
            StorageOp::InsertMessage(msg("m1", 10, "persisted")),
            StorageOp::PutOutbox(outbox("m1")),
        ])
        .unwrap();
    }
    let db = SqliteStorage::open(&path).unwrap();
    assert_eq!(db.messages().unwrap()[0].message.text, "persisted");
    assert_eq!(db.outbox().unwrap().len(), 1);
    drop(db);
    // A file that is not a database is reported, not "fixed".
    let junk = dir.path().join("junk.db");
    std::fs::write(&junk, vec![0xAB; 4096]).unwrap();
    assert!(matches!(
        SqliteStorage::open(&junk).unwrap_err(),
        StorageError::Corrupt | StorageError::Unavailable
    ));
}

#[test]
fn migrations_are_stepwise_backed_up_and_refuse_a_newer_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("m.db");
    let v1 = ["CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);"];
    let v2 = [v1[0], "ALTER TABLE t ADD COLUMN b INTEGER DEFAULT 7;"];
    drop(SqliteStorage::open_with(&path, &v1).unwrap());
    // Upgrading an existing database keeps a copy of the old one and keeps its data.
    let db = SqliteStorage::open_with(&path, &v2).unwrap();
    assert_eq!(db.schema_version().unwrap(), 2);
    assert!(dir.path().join("m.db.bak-v1").exists());
    drop(db);
    // Opening it with an older build refuses instead of downgrading.
    assert_eq!(
        SqliteStorage::open_with(&path, &v1).unwrap_err(),
        StorageError::NewerVersion
    );
    // Opening again with the same build is a no-op, not a second migration.
    assert_eq!(
        SqliteStorage::open_with(&path, &v2)
            .unwrap()
            .schema_version()
            .unwrap(),
        2
    );
}

#[test]
fn a_failing_migration_leaves_the_previous_version_intact() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("f.db");
    let v1 = ["CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (42);"];
    drop(SqliteStorage::open_with(&path, &v1).unwrap());
    let broken = [
        v1[0],
        "ALTER TABLE t ADD COLUMN c INTEGER; THIS IS NOT SQL;",
    ];
    assert_eq!(
        SqliteStorage::open_with(&path, &broken).unwrap_err(),
        StorageError::Rejected
    );
    // Read the file directly: still version 1, the data untouched, and the half-applied column absent.
    {
        let raw = rusqlite::Connection::open(&path).unwrap();
        let version: i64 = raw
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        let a: i64 = raw.query_row("SELECT a FROM t", [], |r| r.get(0)).unwrap();
        let columns: i64 = raw
            .query_row("SELECT COUNT(*) FROM pragma_table_info('t')", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!((version, a, columns), (1, 42, 1));
    }
    // A corrected migration then applies cleanly.
    let fixed = [v1[0], "ALTER TABLE t ADD COLUMN c INTEGER DEFAULT 1;"];
    assert_eq!(
        SqliteStorage::open_with(&path, &fixed)
            .unwrap()
            .schema_version()
            .unwrap(),
        2
    );
}

#[test]
fn bad_rows_are_reported_as_corruption_not_trusted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.db");
    let db = SqliteStorage::open(&path).unwrap();
    db.apply(&[StorageOp::InsertMessage(msg("m1", 1, "x"))])
        .unwrap();
    // A bug or an attacker writes a conversation key the engine never produces.
    {
        let raw = rusqlite::Connection::open(&path).unwrap();
        raw.execute("UPDATE messages SET conversation = 'garbage'", [])
            .unwrap();
    }
    assert_eq!(db.messages().unwrap_err(), StorageError::Corrupt);
}

#[test]
fn file_bytes_round_trip_and_go_with_their_message() {
    use privcord_ports::StoredFile;
    let db = SqliteStorage::in_memory().unwrap();
    let alice = UserId::new("alice").unwrap();
    let id = MessageId::new("11111111-1111-4111-8111-111111111111").unwrap();
    let msg = ChatMessage::outgoing(alice.clone(), "x", 1, id.clone(), None).unwrap();
    let file = StoredFile {
        message_id: id.clone(),
        name: "a.bin".into(),
        mime: "application/octet-stream".into(),
        bytes: vec![1, 2, 3, 0, 255],
    };
    // A file cannot exist without its message.
    assert!(db.apply(&[StorageOp::PutFile(file.clone())]).is_err());
    db.apply(&[
        StorageOp::InsertMessage(StoredMessage {
            conversation: ConversationId::Direct(alice),
            message: msg,
        }),
        StorageOp::PutFile(file.clone()),
    ])
    .unwrap();
    assert_eq!(db.file(&id).unwrap(), Some(file));
    db.apply(&[StorageOp::DeleteMessage(id.clone())]).unwrap();
    assert_eq!(
        db.file(&id).unwrap(),
        None,
        "deleting the message deletes the file"
    );
}
