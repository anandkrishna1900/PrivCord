//! Delete for everyone, reactions, search, muting and backups through the engine.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::rng::SeededEntropy;
use privcord_domain::{privacy::ContactTrust, state::ConnectionPath, UserId};
use privcord_engine::{Core, ErrorCode, EventStream, Ports};
use privcord_ports::testing::{
    FakeClock, MemorySecureStore, MemoryStorage, RecordingNotifier, RecordingTransport,
};
use std::sync::Arc;

#[allow(dead_code)]
struct Node {
    core: Core,
    transport: Arc<RecordingTransport>,
    storage: Arc<MemoryStorage>,
    secure: Arc<MemorySecureStore>,
    clock: Arc<FakeClock>,
    events: EventStream,
    uid: UserId,
    phrase: String,
}

impl Node {
    /// A new install of someone whose recovery phrase we know.
    fn fresh_with_phrase(seed: &str, clock: &Arc<FakeClock>, phrase: &str) -> Node {
        let (storage, secure, transport) = (
            MemoryStorage::new(),
            MemorySecureStore::new(),
            RecordingTransport::new(),
        );
        let mut core = Core::new(Ports {
            storage: storage.clone(),
            secure: secure.clone(),
            transport: transport.clone(),
            clock: clock.clone(),
            notifier: RecordingNotifier::new(),
            entropy: Box::new(SeededEntropy::new(seed)),
        })
        .unwrap();
        let events = core.subscribe();
        core.recover_identity(phrase, "").unwrap();
        let uid = core.own_uid().unwrap().clone();
        Node {
            core,
            transport,
            storage,
            secure,
            clock: clock.clone(),
            events,
            uid,
            phrase: phrase.to_owned(),
        }
    }
}

fn node(seed: &str, clock: &Arc<FakeClock>) -> Node {
    let (storage, secure, transport) = (
        MemoryStorage::new(),
        MemorySecureStore::new(),
        RecordingTransport::new(),
    );
    let mut core = Core::new(Ports {
        storage: storage.clone(),
        secure: secure.clone(),
        transport: transport.clone(),
        clock: clock.clone(),
        notifier: RecordingNotifier::new(),
        entropy: Box::new(SeededEntropy::new(seed)),
    })
    .unwrap();
    let events = core.subscribe();
    let phrase = core.create_identity().unwrap().to_string();
    let uid = core.own_uid().unwrap().clone();
    Node {
        phrase,
        core,
        transport,
        storage,
        secure,
        clock: clock.clone(),
        events,
        uid,
    }
}

fn befriend(a: &mut Node, b: &mut Node) {
    let (ac, bc) = (
        a.core.own_card(Some("A")).unwrap(),
        b.core.own_card(Some("B")).unwrap(),
    );
    a.core.add_contact(&bc, ContactTrust::Verified).unwrap();
    b.core.add_contact(&ac, ContactTrust::Verified).unwrap();
}

fn pump(a: &mut Node, b: &mut Node) {
    loop {
        let (fa, fb) = (a.transport.drain(), b.transport.drain());
        if fa.is_empty() && fb.is_empty() {
            return;
        }
        for (_, f) in fa {
            b.core.frame_received(&a.uid, &f);
        }
        for (_, f) in fb {
            a.core.frame_received(&b.uid, &f);
        }
    }
}

fn connect(a: &mut Node, b: &mut Node) {
    a.transport.set_connected(&b.uid, true);
    b.transport.set_connected(&a.uid, true);
    a.core.link_up(&b.uid, ConnectionPath::DirectLan).unwrap();
    b.core.link_up(&a.uid, ConnectionPath::DirectLan).unwrap();
    pump(a, b);
}

fn texts(n: &Node) -> Vec<String> {
    let mut all: Vec<_> = n
        .core
        .snapshot()
        .messages
        .into_iter()
        .flat_map(|(_, v)| v)
        .collect();
    all.sort_by_key(|m| m.client_created_at);
    all.into_iter().map(|m| m.text).collect()
}

fn find(n: &Node, text: &str) -> privcord_domain::MessageId {
    n.core
        .snapshot()
        .messages
        .into_iter()
        .flat_map(|(_, v)| v)
        .find(|m| m.text == text)
        .unwrap()
        .message_id
}

fn reactions_on(n: &Node, id: &privcord_domain::MessageId) -> Vec<(UserId, String)> {
    n.core
        .snapshot()
        .reactions
        .into_iter()
        .find(|(m, _)| m == id)
        .map(|(_, r)| r)
        .unwrap_or_default()
}

#[test]
fn delete_for_everyone_leaves_a_tombstone_reaches_late_friends_and_only_the_author_may_do_it() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    befriend(&mut a, &mut b);
    connect(&mut a, &mut b);
    let id = a
        .core
        .send_message(&b.uid, "oops wrong chat", None)
        .unwrap();
    clock.advance(10);
    b.core
        .send_message(&a.uid, "Bob's own words", None)
        .unwrap();
    pump(&mut a, &mut b);
    assert_eq!(
        texts(&b),
        [
            "oops wrong chat",
            "Bob\u{2019}s own words".replace('\u{2019}', "'").as_str()
        ]
    );

    // Bob cannot delete Alice's message for everyone, and Alice cannot delete Bob's.
    assert_eq!(
        b.core.delete_message(&id, true),
        Ok(()),
        "for him it is a delete for me"
    );
    assert!(
        b.core
            .snapshot()
            .messages
            .iter()
            .flat_map(|(_, v)| v)
            .all(|m| m.message_id != id),
        "removed only here"
    );
    assert!(a
        .core
        .snapshot()
        .messages
        .iter()
        .flat_map(|(_, v)| v)
        .any(|m| m.message_id == id));
    let bobs = find(&b, "Bob's own words");
    a.core.delete_message(&bobs, true).unwrap();
    assert!(a
        .core
        .snapshot()
        .messages
        .iter()
        .flat_map(|(_, v)| v)
        .all(|m| m.message_id != bobs));
    pump(&mut a, &mut b);
    assert!(
        b.core.snapshot().deleted.is_empty(),
        "a delete for me sends nothing"
    );

    // Alice deletes her own message for everyone: Bob's copy becomes a tombstone (his earlier local delete means he has none).
    let id2 = a.core.send_message(&b.uid, "second mistake", None).unwrap();
    pump(&mut a, &mut b);
    assert_eq!(find(&b, "second mistake"), id2);
    a.core.delete_message(&id2, true).unwrap();
    pump(&mut a, &mut b);
    for n in [&a, &b] {
        let snap = n.core.snapshot();
        assert_eq!(snap.deleted, std::slice::from_ref(&id2));
        let m = snap
            .messages
            .iter()
            .flat_map(|(_, v)| v)
            .find(|m| m.message_id == id2)
            .unwrap();
        assert!(m.text.is_empty(), "no text is kept");
    }
    // Survives a restart (storage keeps only the tombstone).
    let again = Core::new(Ports {
        storage: b.storage.clone(),
        secure: b.secure.clone(),
        transport: RecordingTransport::new(),
        clock: clock.clone(),
        notifier: RecordingNotifier::new(),
        entropy: Box::new(SeededEntropy::new("restart")),
    })
    .unwrap();
    assert_eq!(again.snapshot().deleted, std::slice::from_ref(&id2));

    // A friend who was away still gets the delete when the link comes back.
    let id3 = a.core.send_message(&b.uid, "third", None).unwrap();
    pump(&mut a, &mut b);
    a.core.link_down(&b.uid);
    b.core.link_down(&a.uid);
    a.core.delete_message(&id3, true).unwrap();
    assert!(b.core.snapshot().deleted.iter().all(|d| *d != id3));
    connect(&mut a, &mut b);
    assert!(b.core.snapshot().deleted.contains(&id3));
}

#[test]
fn a_forged_delete_or_reaction_from_the_wrong_person_does_nothing() {
    use privcord_engine::LinkSecurity;
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    befriend(&mut a, &mut b);
    // Protocol v2: frames written by hand outside the post-quantum channel are refused outright, forged or not; the
    // genuine reaction below goes through the channel.
    a.transport.set_connected(&b.uid, true);
    b.transport.set_connected(&a.uid, true);
    a.core
        .link_up_with(
            &b.uid,
            ConnectionPath::DirectNat,
            LinkSecurity::TransportEncrypted,
        )
        .unwrap();
    b.core
        .link_up_with(
            &a.uid,
            ConnectionPath::DirectNat,
            LinkSecurity::TransportEncrypted,
        )
        .unwrap();
    pump(&mut a, &mut b);
    let mine = a
        .core
        .send_message(&b.uid, "Alice wrote this", None)
        .unwrap();
    pump(&mut a, &mut b);
    let del = serde_json::json!({ "v": 1, "kind": "delete", "messageId": mine });
    a.core.frame_received(&b.uid, &del.to_string()); // Bob "deleting" Alice's own message on her device
    assert!(a.core.snapshot().deleted.is_empty());
    // A reaction from somebody who is not in the chat.
    let carol = node("carol", &clock);
    let _ = carol;
    let rx = serde_json::json!({ "v": 1, "kind": "react", "messageId": mine, "emoji": "\u{1F44D}", "on": true });
    b.core.frame_received(&a.uid, &rx.to_string());
    assert!(
        reactions_on(&b, &find(&b, "Alice wrote this")).is_empty(),
        "a plain frame does nothing"
    );
    a.core.react(&mine, "\u{1F44D}").unwrap();
    pump(&mut a, &mut b);
    assert_eq!(
        reactions_on(&b, &find(&b, "Alice wrote this")),
        [(a.uid.clone(), "\u{1F44D}".to_owned())],
        "the chat's own member may"
    );
    let bad = serde_json::json!({ "v": 1, "kind": "react", "messageId": mine, "emoji": "\u{1F4A9}", "on": true });
    a.core.frame_received(&b.uid, &bad.to_string());
    assert_eq!(
        reactions_on(&a, &mine),
        [(a.uid.clone(), "\u{1F44D}".to_owned())],
        "only her own genuine reaction; the forged one (not one of the six, and plain) never lands"
    );
}

#[test]
fn reactions_toggle_replace_sync_survive_a_restart_and_go_with_a_deleted_message() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    befriend(&mut a, &mut b);
    connect(&mut a, &mut b);
    let id = a.core.send_message(&b.uid, "lunch?", None).unwrap();
    pump(&mut a, &mut b);
    assert_eq!(b.core.react(&id, "x"), Err(ErrorCode::BadReaction));
    b.core.react(&id, "\u{1F44D}").unwrap();
    pump(&mut a, &mut b);
    assert_eq!(
        reactions_on(&a, &id),
        [(b.uid.clone(), "\u{1F44D}".to_owned())]
    );
    // One emoji per person: a different one replaces.
    b.core.react(&id, "\u{2764}\u{FE0F}").unwrap();
    pump(&mut a, &mut b);
    assert_eq!(
        reactions_on(&a, &id),
        [(b.uid.clone(), "\u{2764}\u{FE0F}".to_owned())]
    );
    // Alice reacts too; the same one again removes hers.
    a.core.react(&id, "\u{1F602}").unwrap();
    a.core.react(&id, "\u{1F602}").unwrap();
    pump(&mut a, &mut b);
    assert_eq!(reactions_on(&b, &id).len(), 1);
    // A reaction made while apart arrives when the link returns.
    a.core.link_down(&b.uid);
    b.core.link_down(&a.uid);
    b.core.react(&id, "\u{1F64F}").unwrap();
    connect(&mut a, &mut b);
    assert_eq!(
        reactions_on(&a, &id),
        [(b.uid.clone(), "\u{1F64F}".to_owned())]
    );
    // Restart: still there.
    let again = Core::new(Ports {
        storage: a.storage.clone(),
        secure: a.secure.clone(),
        transport: RecordingTransport::new(),
        clock: clock.clone(),
        notifier: RecordingNotifier::new(),
        entropy: Box::new(SeededEntropy::new("restart")),
    })
    .unwrap();
    assert_eq!(again.snapshot().reactions.len(), 1);
    // Deleting the message for everyone removes its reactions, and a deleted message takes none.
    a.core.delete_message(&id, true).unwrap();
    assert!(a.core.snapshot().reactions.is_empty());
    assert_eq!(
        a.core.react(&id, "\u{1F44D}"),
        Err(ErrorCode::UnknownMessage)
    );
}

#[test]
fn search_finds_text_skips_deleted_and_muted_and_orders_newest_first() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    befriend(&mut a, &mut b);
    connect(&mut a, &mut b);
    for t in ["Pizza tonight", "no match here", "more PIZZA later", "x"] {
        a.core.send_message(&b.uid, t, None).unwrap();
        clock.advance(10);
    }
    let gone = a.core.send_message(&b.uid, "pizza regret", None).unwrap();
    pump(&mut a, &mut b);
    a.core.delete_message(&gone, true).unwrap();
    pump(&mut a, &mut b);
    let hits = b.core.search("  pizza ", 10);
    assert_eq!(
        hits.iter().map(|h| h.text.as_str()).collect::<Vec<_>>(),
        ["more PIZZA later", "Pizza tonight"]
    );
    assert_eq!(b.core.search("pizza", 1).len(), 1, "limit");
    assert!(b.core.search("p", 10).is_empty(), "two characters at least");
    assert!(b.core.search("zzzz", 10).is_empty());
    // Muting hides someone else's messages from search, never your own.
    b.core.set_muted(&a.uid, true).unwrap();
    assert_eq!(b.core.snapshot().muted, [a.uid.clone()]);
    assert!(b.core.search("pizza", 10).is_empty());
    b.core.send_message(&a.uid, "my own pizza", None).unwrap();
    assert_eq!(b.core.search("pizza", 10).len(), 1);
    // The mute survives a restart and can be undone.
    let mut again = Core::new(Ports {
        storage: b.storage.clone(),
        secure: b.secure.clone(),
        transport: RecordingTransport::new(),
        clock: clock.clone(),
        notifier: RecordingNotifier::new(),
        entropy: Box::new(SeededEntropy::new("restart")),
    })
    .unwrap();
    assert_eq!(again.snapshot().muted, [a.uid.clone()]);
    again.set_muted(&a.uid, false).unwrap();
    assert!(again.snapshot().muted.is_empty());
}

#[test]
fn a_backup_restores_friends_groups_channels_messages_reactions_and_deletes_without_touching_what_exists(
) {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    befriend(&mut a, &mut b);
    connect(&mut a, &mut b);
    let gid = a.core.create_group("Trip", &[b.uid.clone()]).unwrap();
    a.core.join_channel("town").unwrap();
    let m1 = a.core.send_message(&b.uid, "hello bob", None).unwrap();
    clock.advance(5);
    let m2 = a
        .core
        .send_group_message(&gid, "group hello", None)
        .unwrap();
    clock.advance(5);
    let gone = a.core.send_message(&b.uid, "delete me", None).unwrap();
    pump(&mut a, &mut b);
    b.core.react(&m1, "\u{1F44D}").unwrap();
    pump(&mut a, &mut b);
    a.core.delete_message(&gone, true).unwrap();
    a.core.set_muted(&b.uid, true).unwrap();

    assert_eq!(
        a.core.export_backup("short"),
        Err(ErrorCode::WeakPassphrase)
    );
    let backup = a.core.export_backup("correct horse battery").unwrap();
    assert!(backup.starts_with("PRIVCORD-BACKUP1:") && !backup.contains("hello bob"));

    // A fresh install of the same person (recovered from the phrase) restores everything.
    let phrase = a.phrase.clone();
    let mut fresh = Node::fresh_with_phrase("alice-new", &clock, &phrase);
    assert!(fresh.core.snapshot().contacts.is_empty());
    assert_eq!(
        fresh.core.import_backup(&backup, "wrong passphrase"),
        Err(ErrorCode::BackupUnreadable)
    );
    assert_eq!(
        fresh
            .core
            .import_backup("not a backup", "correct horse battery"),
        Err(ErrorCode::BackupUnreadable)
    );
    let r = fresh
        .core
        .import_backup(&backup, "correct horse battery")
        .unwrap();
    assert_eq!((r.friends, r.groups), (1, 1));
    let snap = fresh.core.snapshot();
    assert_eq!(snap.contacts.len(), 1);
    assert_eq!(snap.groups.len(), 1);
    assert_eq!(snap.channels, ["town"]);
    assert_eq!(snap.muted, [b.uid.clone()]);
    assert_eq!(snap.deleted, std::slice::from_ref(&gone));
    assert_eq!(snap.reactions.len(), 1);
    assert!(snap
        .messages
        .iter()
        .flat_map(|(_, v)| v)
        .any(|m| m.message_id == m2 && m.text == "group hello"));
    // The restored group works straight away.
    fresh
        .core
        .send_group_message(&gid, "after restore", None)
        .unwrap();
    // Restoring twice adds nothing and changes nothing.
    let before = fresh
        .core
        .snapshot()
        .messages
        .iter()
        .map(|(_, v)| v.len())
        .sum::<usize>();
    fresh
        .core
        .import_backup(&backup, "correct horse battery")
        .unwrap();
    assert_eq!(
        fresh
            .core
            .snapshot()
            .messages
            .iter()
            .map(|(_, v)| v.len())
            .sum::<usize>(),
        before
    );

    // A backup of somebody else is refused.
    assert_eq!(
        b.core.import_backup(&backup, "correct horse battery"),
        Err(ErrorCode::BackupNotYours)
    );
}

/// Deliver every frame in flight between all nodes until quiet.
fn pump_all(nodes: &mut [&mut Node]) {
    loop {
        let mut moved = false;
        let uids: Vec<UserId> = nodes.iter().map(|n| n.uid.clone()).collect();
        for i in 0..nodes.len() {
            for (to, frame) in nodes[i].transport.drain() {
                moved = true;
                if let Some(j) = uids.iter().position(|u| *u == to) {
                    let from = uids[i].clone();
                    nodes[j].core.frame_received(&from, &frame);
                }
            }
        }
        if !moved {
            return;
        }
    }
}

fn link_nodes(nodes: &mut [&mut Node], i: usize, j: usize) {
    let (ui, uj) = (nodes[i].uid.clone(), nodes[j].uid.clone());
    nodes[i].transport.set_connected(&uj, true);
    nodes[j].transport.set_connected(&ui, true);
    nodes[i]
        .core
        .link_up(&uj, ConnectionPath::DirectLan)
        .unwrap();
    nodes[j]
        .core
        .link_up(&ui, ConnectionPath::DirectLan)
        .unwrap();
    pump_all(nodes);
}

#[test]
fn the_chat_list_knows_the_newest_message_and_unread_and_a_group_message_is_delivered_only_when_everyone_has_it(
) {
    use privcord_domain::{message::DeliveryState, ConversationId};
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b, mut c) = (
        node("alice", &clock),
        node("bob", &clock),
        node("carol", &clock),
    );
    befriend(&mut a, &mut b);
    befriend(&mut a, &mut c);
    let gid = a
        .core
        .create_group("Trip", &[b.uid.clone(), c.uid.clone()])
        .unwrap();
    let mut all = [&mut a, &mut b, &mut c];
    link_nodes(&mut all, 0, 1);
    let [a, b, c] = all;

    // Group: one member is connected, the other is not.
    let id = a
        .core
        .send_group_message(&gid, "who is coming", None)
        .unwrap();
    let mut all = [&mut *a, &mut *b, &mut *c];
    pump_all(&mut all);
    let snap = a.core.snapshot();
    let g = &snap.groups[0];
    assert_eq!(
        (g.am_admin, g.full, g.max_members, g.connected),
        (true, false, 10, 1)
    );
    let state = |n: &Node| {
        n.core
            .snapshot()
            .messages
            .iter()
            .flat_map(|(_, v)| v.iter())
            .find(|m| m.message_id == id)
            .unwrap()
            .delivery_state
    };
    assert_eq!(
        state(a),
        DeliveryState::Sent,
        "Bob has it, Carol has not: not delivered yet"
    );
    let d = snap.deliveries.iter().find(|d| d.message_id == id).unwrap();
    assert_eq!((d.pending, d.total), (1, 2));
    // Carol connects and gets it: now it is delivered, and nothing is owed.
    let mut all = [&mut *a, &mut *b, &mut *c];
    link_nodes(&mut all, 0, 2);
    assert_eq!(state(a), DeliveryState::Delivered);
    assert!(a.core.snapshot().deliveries.is_empty());

    // The chat list: newest message, unread count, a deleted message and a file show as the apps show them.
    let conv = ConversationId::Group(privcord_domain::GroupId::new(gid.as_str()).unwrap());
    let summary = |n: &Node| {
        n.core
            .snapshot()
            .summaries
            .into_iter()
            .find(|s| s.conversation == conv)
            .unwrap()
    };
    assert_eq!(summary(b).last.as_ref().unwrap().text, "who is coming");
    assert_eq!(
        (summary(b).unread, summary(a).unread),
        (1, 0),
        "Bob has not read it; Alice wrote it"
    );
    clock.advance(10);
    let f = a
        .core
        .send_group_file(&gid, "map.png", "image/png", vec![1, 2, 3], None)
        .unwrap();
    let mut all = [&mut *a, &mut *b, &mut *c];
    pump_all(&mut all);
    assert_eq!(summary(b).last.as_ref().unwrap().text, "\u{1F4CE} map.png");
    assert_eq!(summary(b).unread, 2);
    a.core.delete_message(&f, true).unwrap();
    let mut all = [&mut *a, &mut *b, &mut *c];
    pump_all(&mut all);
    assert_eq!(summary(b).last.as_ref().unwrap().text, "Message deleted");
    assert!(!b.core.snapshot().contacts[0].display_name.is_empty());
}
