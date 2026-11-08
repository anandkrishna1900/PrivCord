//! The importer against realistic old-app databases built from `docs/legacy-fixtures.json` (see its generator for how
//! they are made: the apps' own protocol code and table layouts, not a device capture).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_domain::{
    message::{DeliveryState, MessageKind},
    privacy::ContactTrust,
    ConversationId, MessageId, UserId,
};
use privcord_import::{
    android,
    desktop::{self, decrypt_file_bytes, AesKeyDecryptor},
    import, FileSource, ImportReport, NoFiles, Source,
};
use privcord_ports::Storage;
use privcord_storage::SqliteStorage;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::{collections::HashMap, path::Path};

fn fixtures() -> Value {
    let root = env!("CARGO_MANIFEST_DIR");
    serde_json::from_str(
        &std::fs::read_to_string(format!("{root}/../../docs/legacy-fixtures.json")).unwrap(),
    )
    .unwrap()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn key(f: &Value) -> [u8; 32] {
    unhex(f["aesKeyHex"].as_str().unwrap()).try_into().unwrap()
}

/// A key that is not the app's: the right one with a bit flipped (so no literal key appears in a test).
fn wrong_key(f: &Value) -> [u8; 32] {
    let mut k = key(f);
    k[0] ^= 1;
    k
}

struct Files(HashMap<String, Vec<u8>>);
impl FileSource for Files {
    fn file(&self, id: &str) -> Option<Vec<u8>> {
        self.0.get(id).cloned()
    }
}

fn s(v: &Value) -> Option<&str> {
    v.as_str()
}

/// The desktop's tables exactly as `localDb.ts` creates them (`legacy` = before the three later columns).
fn build_desktop(path: &Path, rows: &Value, legacy: bool) {
    let c = Connection::open(path).unwrap();
    let extra = if legacy {
        ""
    } else {
        ", conversation_id TEXT NOT NULL DEFAULT '', recips TEXT, extra_cipher TEXT"
    };
    c.execute_batch(&format!(
        "CREATE TABLE messages (message_id TEXT PRIMARY KEY, client_message_id TEXT NOT NULL, sender_id TEXT NOT NULL,
           text_cipher TEXT NOT NULL, client_created_at INTEGER NOT NULL, message_type TEXT NOT NULL, transport TEXT NOT NULL,
           delivery_state TEXT NOT NULL, read_at INTEGER{extra});
         CREATE TABLE outbox (message_id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, payload_cipher TEXT NOT NULL,
           created_at INTEGER NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER,
           delivery_state TEXT NOT NULL, last_error TEXT);
         CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
    ))
    .unwrap();
    for m in rows["messages"].as_array().unwrap() {
        if legacy {
            c.execute(
                "INSERT INTO messages VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    s(&m["message_id"]),
                    s(&m["client_message_id"]),
                    s(&m["sender_id"]),
                    s(&m["text_cipher"]),
                    m["client_created_at"].as_i64(),
                    s(&m["message_type"]),
                    s(&m["transport"]),
                    s(&m["delivery_state"]),
                    m["read_at"].as_i64()
                ],
            )
            .unwrap();
        } else {
            c.execute(
                "INSERT INTO messages VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    s(&m["message_id"]),
                    s(&m["client_message_id"]),
                    s(&m["sender_id"]),
                    s(&m["text_cipher"]),
                    m["client_created_at"].as_i64(),
                    s(&m["message_type"]),
                    s(&m["transport"]),
                    s(&m["delivery_state"]),
                    m["read_at"].as_i64(),
                    s(&m["conversation_id"]),
                    s(&m["recips"]),
                    s(&m["extra_cipher"])
                ],
            )
            .unwrap();
        }
    }
    for o in rows["outbox"].as_array().unwrap_or(&vec![]) {
        c.execute(
            "INSERT INTO outbox VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                s(&o["message_id"]),
                s(&o["recipient_id"]),
                s(&o["payload_cipher"]),
                o["created_at"].as_i64(),
                o["attempt_count"].as_i64(),
                o["last_attempt_at"].as_i64(),
                s(&o["delivery_state"]),
                s(&o["last_error"])
            ],
        )
        .unwrap();
    }
    for (k, v) in rows["meta"].as_object().unwrap() {
        c.execute("INSERT INTO meta VALUES (?1,?2)", params![k, s(v)])
            .unwrap();
    }
}

/// Room's version-7 tables (`DuoDatabase.kt`).
fn build_android(path: &Path, a: &Value) {
    let c = Connection::open(path).unwrap();
    c.execute_batch(
        "CREATE TABLE messages (messageId TEXT NOT NULL, clientMessageId TEXT NOT NULL, senderId TEXT NOT NULL, textCipher TEXT NOT NULL,
           clientCreatedAt INTEGER NOT NULL, transport TEXT NOT NULL, deliveryState TEXT NOT NULL, readAt INTEGER,
           conversationId TEXT NOT NULL, totalRecipients INTEGER NOT NULL, extraCipher TEXT, PRIMARY KEY(messageId));
         CREATE TABLE outbox (`key` TEXT NOT NULL, messageId TEXT NOT NULL, recipientId TEXT NOT NULL, payloadCipher TEXT NOT NULL,
           createdAt INTEGER NOT NULL, attemptCount INTEGER NOT NULL, lastAttemptAt INTEGER, deliveryState TEXT NOT NULL,
           lastError TEXT, conversationId TEXT NOT NULL, PRIMARY KEY(`key`));
         CREATE TABLE contacts (uid TEXT NOT NULL, name TEXT NOT NULL, signPubX TEXT NOT NULL, signPubY TEXT NOT NULL, dhPubX TEXT NOT NULL,
           dhPubY TEXT NOT NULL, identityProof TEXT NOT NULL, safetyNumber TEXT NOT NULL, isBlocked INTEGER NOT NULL, verifiedAt INTEGER,
           createdAt INTEGER NOT NULL, trust TEXT NOT NULL, introducedBy TEXT, cardName TEXT, PRIMARY KEY(uid));
         CREATE TABLE kv (`key` TEXT NOT NULL, valueCipher TEXT NOT NULL, PRIMARY KEY(`key`));
         CREATE TABLE group_logs (groupId TEXT NOT NULL, eventsCipher TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(groupId));",
    )
    .unwrap();
    for m in a["messages"].as_array().unwrap() {
        c.execute(
            "INSERT INTO messages VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                s(&m["messageId"]),
                s(&m["clientMessageId"]),
                s(&m["senderId"]),
                s(&m["textCipher"]),
                m["clientCreatedAt"].as_i64(),
                s(&m["transport"]),
                s(&m["deliveryState"]),
                m["readAt"].as_i64(),
                s(&m["conversationId"]),
                m["totalRecipients"].as_i64(),
                s(&m["extraCipher"])
            ],
        )
        .unwrap();
    }
    for o in a["outbox"].as_array().unwrap() {
        c.execute(
            "INSERT INTO outbox VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                s(&o["key"]),
                s(&o["messageId"]),
                s(&o["recipientId"]),
                s(&o["payloadCipher"]),
                o["createdAt"].as_i64(),
                o["attemptCount"].as_i64(),
                o["lastAttemptAt"].as_i64(),
                s(&o["deliveryState"]),
                s(&o["lastError"]),
                s(&o["conversationId"])
            ],
        )
        .unwrap();
    }
    for k in a["contacts"].as_array().unwrap() {
        c.execute(
            "INSERT INTO contacts VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                s(&k["uid"]),
                s(&k["name"]),
                s(&k["signPubX"]),
                s(&k["signPubY"]),
                s(&k["dhPubX"]),
                s(&k["dhPubY"]),
                s(&k["identityProof"]),
                s(&k["safetyNumber"]),
                k["isBlocked"].as_bool(),
                k["verifiedAt"].as_i64(),
                k["createdAt"].as_i64(),
                s(&k["trust"]),
                s(&k["introducedBy"]),
                s(&k["cardName"])
            ],
        )
        .unwrap();
    }
    for (k, v) in a["kv"].as_object().unwrap() {
        c.execute("INSERT INTO kv VALUES (?1,?2)", params![k, s(v)])
            .unwrap();
    }
    for g in a["groupLogs"].as_array().unwrap() {
        c.execute(
            "INSERT INTO group_logs VALUES (?1,?2,?3)",
            params![
                s(&g["groupId"]),
                s(&g["eventsCipher"]),
                g["updatedAt"].as_i64()
            ],
        )
        .unwrap();
    }
}

fn uid(f: &Value, who: &str) -> UserId {
    UserId::new(f[who]["uid"].as_str().unwrap()).unwrap()
}

fn msg(db: &dyn Storage, n: u32) -> Option<privcord_ports::StoredMessage> {
    let id = format!("00000000-0000-4000-8000-{n:012}");
    db.messages()
        .unwrap()
        .into_iter()
        .find(|m| m.message.message_id.as_str() == id)
}

fn check_common(f: &Value, db: &SqliteStorage, r: &ImportReport) {
    let (bob, carol, me) = (uid(f, "bob"), uid(f, "carol"), uid(f, "me"));
    // Contacts: the card with someone else's proof was refused; trust and names survived.
    let contacts = db.contacts().unwrap();
    assert!(
        contacts.iter().all(|c| c.uid != uid(f, "dave")),
        "a card that does not verify is not imported"
    );
    let b = contacts.iter().find(|c| c.uid == bob).unwrap();
    assert_eq!(
        (b.trust, b.checked, b.name.as_deref()),
        (ContactTrust::Verified, true, Some("Bobby"))
    );
    let c = contacts.iter().find(|c| c.uid == carol).unwrap();
    assert_eq!(
        (c.trust, c.introduced_by.clone()),
        (ContactTrust::Introduced, Some(bob.clone()))
    );
    // Groups: the real one verified (all three events), the one with a changed event is gone.
    let groups: HashMap<String, Vec<Value>> =
        serde_json::from_slice(&db.kv("groups.v1").unwrap().unwrap()).unwrap();
    assert_eq!(
        groups.keys().collect::<Vec<_>>(),
        [&f["groupId"].as_str().unwrap().to_owned()]
    );
    assert_eq!(groups[f["groupId"].as_str().unwrap()].len(), 3);
    assert_eq!(r.groups, 1);
    assert_eq!(r.skipped["group_has_no_valid_events"], 1);
    // Channels normalised, the invalid name skipped.
    assert_eq!(
        serde_json::from_slice::<Vec<String>>(&db.kv("channels.v1").unwrap().unwrap()).unwrap(),
        ["town"]
    );
    // Messages.
    let m1 = msg(db, 1).unwrap();
    assert_eq!(
        (
            m1.conversation.clone(),
            m1.message.delivery_state,
            m1.message.read_at
        ),
        (
            ConversationId::Direct(bob.clone()),
            DeliveryState::Read,
            Some(1_700_000_100_005)
        )
    );
    assert_eq!(m1.message.text, "hello from Bob 😀");
    let m3 = msg(db, 3).unwrap();
    assert_eq!(
        m3.message.reply_to.as_ref().unwrap().id,
        "00000000-0000-4000-8000-000000000002"
    );
    let m7 = msg(db, 7).unwrap();
    assert_eq!(
        m7.conversation,
        ConversationId::Group(
            privcord_domain::GroupId::new(f["groupId"].as_str().unwrap()).unwrap()
        )
    );
    let m9 = msg(db, 9).unwrap();
    assert_eq!(m9.conversation, ConversationId::Channel("town".into()));
    assert!(
        msg(db, 10).is_none(),
        "a deleted-for-everyone tombstone is not imported"
    );
    assert!(msg(db, 11).is_some() && r.skipped["reactions_not_kept"] == 1);
    assert!(
        msg(db, 12).is_none(),
        "text that cannot be decrypted is not imported"
    );
    // The file with good bytes is intact; the corrupt and the missing one are messages without bytes.
    let m4 = msg(db, 4).unwrap();
    assert_eq!(
        (m4.message.kind, m4.message.text.as_str()),
        (MessageKind::File, "photo.png")
    );
    let id4 = MessageId::new("00000000-0000-4000-8000-000000000004").unwrap();
    let file = db.file(&id4).unwrap().unwrap();
    assert_eq!(file.bytes.len() as u64, f["pngLen"].as_u64().unwrap());
    assert_eq!(
        privcord_domain::files::sha256_b64(&file.bytes),
        f["pngSha"].as_str().unwrap()
    );
    for n in [5, 6] {
        assert!(msg(db, n).is_some());
        assert!(db
            .file(&MessageId::new(format!("00000000-0000-4000-8000-{n:012}")).unwrap())
            .unwrap()
            .is_none());
    }
    assert_eq!(r.skipped["file_failed_its_hash_check"], 1);
    assert_eq!(r.skipped["file_bytes_missing"], 1);
    // Unsent messages keep waiting for the person they were for.
    let out = db.outbox().unwrap();
    assert!(out
        .iter()
        .any(|o| o.message_id.as_str().ends_with("002") && o.recipient == bob && o.attempts == 2));
    assert!(out
        .iter()
        .all(|o| msg(db, 0).is_none() && o.recipient != me));
}

#[test]
fn a_desktop_database_comes_over_verified_and_a_second_run_changes_nothing() {
    let f = fixtures();
    let dir = tempfile::tempdir().unwrap();
    let old = dir.path().join("duochat.db");
    build_desktop(&old, &f["desktop"], false);
    let k = key(&f);
    let bundle = desktop::read_bundle(&old, &AesKeyDecryptor(k)).unwrap();
    assert_eq!(bundle.contacts.len(), 4);
    assert!(
        bundle
            .contacts
            .iter()
            .find(|c| c.uid == f["carol"]["uid"].as_str().unwrap())
            .unwrap()
            .muted
    );
    assert_eq!(
        bundle.messages.len(),
        14,
        "the one message that cannot be decrypted never reaches the bundle"
    );

    let files = Files(
        f["desktop"]["files"]
            .as_object()
            .unwrap()
            .iter()
            .filter_map(|(id, hex)| {
                Some((id.clone(), decrypt_file_bytes(&k, &unhex(hex.as_str()?))?))
            })
            .collect(),
    );
    let db = SqliteStorage::open(&dir.path().join("privcord.db")).unwrap();
    let r = import(
        &bundle,
        Source::Desktop,
        &files,
        &uid(&f, "me"),
        &db,
        1_700_000_200_000,
    )
    .unwrap();
    assert_eq!(
        (r.contacts, r.messages, r.files, r.outbox),
        (3, 13, 1, 3),
        "{r:?}"
    );
    assert_eq!(r.skipped["contact_card_not_valid"], 1);
    assert_eq!(r.skipped["deleted_message"], 1);
    check_common(&f, &db, &r);
    assert_eq!(
        r.skipped["channel_name_not_valid"], 1,
        "the channel called ### is refused"
    );
    // Eve was written as "confirmed" by an older build; she is a verified friend now, and her chat came over.
    let eve = db
        .contacts()
        .unwrap()
        .into_iter()
        .find(|c| c.uid == uid(&f, "eve"))
        .unwrap();
    assert_eq!(eve.trust, ContactTrust::Verified);
    assert!(msg(&db, 13).is_some());
    // A group message of ours still owes Bob a copy.
    assert!(db
        .outbox()
        .unwrap()
        .iter()
        .any(|o| o.message_id.as_str().ends_with("008") && o.recipient == uid(&f, "bob")));

    let before = (
        db.messages().unwrap().len(),
        db.contacts().unwrap().len(),
        db.outbox().unwrap().len(),
    );
    let again = import(
        &bundle,
        Source::Desktop,
        &files,
        &uid(&f, "me"),
        &db,
        1_700_000_300_000,
    )
    .unwrap();
    assert!(again.already_done);
    assert_eq!(
        before,
        (
            db.messages().unwrap().len(),
            db.contacts().unwrap().len(),
            db.outbox().unwrap().len()
        )
    );
}

#[test]
fn an_old_desktop_database_without_conversation_columns_maps_its_single_chat() {
    let f = fixtures();
    let dir = tempfile::tempdir().unwrap();
    let old = dir.path().join("old.db");
    build_desktop(&old, &f["oldDesktop"], true);
    let bundle = desktop::read_bundle(&old, &AesKeyDecryptor(key(&f))).unwrap();
    let db = SqliteStorage::in_memory().unwrap();
    let r = import(&bundle, Source::Desktop, &NoFiles, &uid(&f, "me"), &db, 1).unwrap();
    assert_eq!((r.contacts, r.messages), (1, 2), "{r:?}");
    let bob = uid(&f, "bob");
    let all = db.messages().unwrap();
    assert!(all
        .iter()
        .all(|m| m.conversation == ConversationId::Direct(bob.clone())));
    assert!(all
        .iter()
        .any(|m| m.message.transport == privcord_domain::message::TransportKind::Relay));
}

#[test]
fn a_wrong_key_imports_nothing_instead_of_garbage() {
    let f = fixtures();
    let dir = tempfile::tempdir().unwrap();
    let old = dir.path().join("duochat.db");
    build_desktop(&old, &f["desktop"], false);
    let bundle = desktop::read_bundle(&old, &AesKeyDecryptor(wrong_key(&f))).unwrap();
    assert!(bundle.contacts.is_empty() && bundle.messages.is_empty() && bundle.groups.is_empty());
    let db = SqliteStorage::in_memory().unwrap();
    let r = import(&bundle, Source::Desktop, &NoFiles, &uid(&f, "me"), &db, 1).unwrap();
    assert_eq!((r.contacts, r.messages, r.groups), (0, 0, 0));
    // Not a PrivCord database at all.
    let other = dir.path().join("other.db");
    Connection::open(&other)
        .unwrap()
        .execute_batch("CREATE TABLE t (x)")
        .unwrap();
    assert!(desktop::read_bundle(&other, &AesKeyDecryptor(wrong_key(&f))).is_err());
    assert!(desktop::read_bundle(
        &dir.path().join("missing.db"),
        &AesKeyDecryptor(wrong_key(&f))
    )
    .is_err());
}

#[test]
fn an_android_room_database_comes_over_through_the_keystore_decryptor() {
    let f = fixtures();
    let dir = tempfile::tempdir().unwrap();
    let old = dir.path().join("duo.db");
    build_android(&old, &f["android"]);
    // The Android Keystore key cannot be read, so the app passes a decryptor that calls it; here a plain key stands in.
    let bundle = android::read_bundle(&old, &AesKeyDecryptor(key(&f))).unwrap();
    assert_eq!(bundle.contacts.len(), 3);
    let carol = bundle
        .contacts
        .iter()
        .find(|c| c.uid == f["carol"]["uid"].as_str().unwrap())
        .unwrap();
    assert!(carol.muted, "a blocked contact stays muted");
    let files = Files(
        f["android"]["files"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(id, h)| (id.clone(), unhex(h.as_str().unwrap())))
            .collect(),
    );
    let db = SqliteStorage::open(&dir.path().join("privcord.db")).unwrap();
    let r = import(
        &bundle,
        Source::Android,
        &files,
        &uid(&f, "me"),
        &db,
        1_700_000_200_000,
    )
    .unwrap();
    assert_eq!((r.contacts, r.files), (2, 1), "{r:?}");
    check_common(&f, &db, &r);
    // Android's outbox rows are one per (message, recipient), so both unsent messages still owe Bob.
    assert_eq!(db.outbox().unwrap().len(), 2);
    assert!(
        db.contacts()
            .unwrap()
            .iter()
            .find(|c| c.uid == uid(&f, "bob"))
            .unwrap()
            .checked,
        "verifiedAt means the numbers were compared"
    );
    // Run twice: no change.
    assert!(
        import(&bundle, Source::Android, &files, &uid(&f, "me"), &db, 5)
            .unwrap()
            .already_done
    );
}

#[test]
fn the_engine_opens_what_was_imported_and_carries_on() {
    use privcord_crypto::rng::SeededEntropy;
    use privcord_engine::{Core, Ports};
    use privcord_ports::testing::{
        FakeClock, MemorySecureStore, RecordingNotifier, RecordingTransport,
    };
    use std::sync::Arc;

    let f = fixtures();
    let dir = tempfile::tempdir().unwrap();
    let old = dir.path().join("duochat.db");
    build_desktop(&old, &f["desktop"], false);
    let k = key(&f);
    let bundle = desktop::read_bundle(&old, &AesKeyDecryptor(k)).unwrap();
    let files = Files(
        f["desktop"]["files"]
            .as_object()
            .unwrap()
            .iter()
            .filter_map(|(id, hex)| {
                Some((id.clone(), decrypt_file_bytes(&k, &unhex(hex.as_str()?))?))
            })
            .collect(),
    );
    let new_path = dir.path().join("privcord.db");
    {
        let db = SqliteStorage::open(&new_path).unwrap();
        import(
            &bundle,
            Source::Desktop,
            &files,
            &uid(&f, "me"),
            &db,
            1_700_000_200_000,
        )
        .unwrap();
    }
    // A fresh install of the new app: same person (recovered from the phrase), the imported database.
    let transport = RecordingTransport::new();
    let mut core = Core::new(Ports {
        storage: Arc::new(SqliteStorage::open(&new_path).unwrap()),
        secure: MemorySecureStore::new(),
        transport: transport.clone(),
        clock: FakeClock::at(1_700_000_300_000),
        notifier: RecordingNotifier::new(),
        entropy: Box::new(SeededEntropy::new("engine")),
    })
    .unwrap();
    core.recover_identity(f["me"]["phrase"].as_str().unwrap(), "")
        .unwrap();
    assert_eq!(
        core.own_uid().unwrap(),
        &uid(&f, "me"),
        "the recovered phrase is the same person"
    );
    let snap = core.snapshot();
    assert_eq!(snap.contacts.len(), 3);
    assert_eq!(snap.channels, ["town"]);
    assert_eq!(snap.groups.len(), 1);
    assert_eq!(snap.groups[0].name, "Trip");
    assert_eq!(snap.groups[0].members.len(), 3);
    let total: usize = snap.messages.iter().map(|(_, v)| v.len()).sum();
    assert_eq!(total, 13);
    assert_eq!(snap.queued, 3, "unsent messages are still waiting");
    // The imported file opens, and the old group can be written to straight away.
    let id = MessageId::new("00000000-0000-4000-8000-000000000004").unwrap();
    assert_eq!(
        core.file(&id).unwrap().unwrap().bytes.len() as u64,
        f["pngLen"].as_u64().unwrap()
    );
    core.send_group_message(f["groupId"].as_str().unwrap(), "back again", None)
        .unwrap();
}
