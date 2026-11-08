//! Engine integration tests: two engines talking through mock adapters, with the network under the test's control.
//! These run the real identity, crypto, handshake, storage-port and delivery logic; only the radio and the disk are fakes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::{
    card::ContactCard, identity::Identity, rng::SeededEntropy, secure_channel::SecureChannel,
};
use privcord_domain::{
    message::DeliveryState,
    privacy::ContactTrust,
    state::{ConnectionFailure, ConnectionPath, ConnectionState},
    ConversationId, UserId,
};
use privcord_engine::{core::RETRY_AFTER_MS, Core, EngineEvent, ErrorCode, EventStream, Ports};
use privcord_ports::{
    testing::{FakeClock, MemorySecureStore, MemoryStorage, RecordingNotifier, RecordingTransport},
    Notification, Storage,
};
use serde_json::{json, Value};
use std::sync::Arc;

struct Node {
    core: Core,
    transport: Arc<RecordingTransport>,
    storage: Arc<MemoryStorage>,
    secure: Arc<MemorySecureStore>,
    notifier: Arc<RecordingNotifier>,
    clock: Arc<FakeClock>,
    events: EventStream,
    phrase: String,
}

fn boot(
    seed: &str,
    storage: Arc<MemoryStorage>,
    secure: Arc<MemorySecureStore>,
    clock: Arc<FakeClock>,
) -> Node {
    let transport = RecordingTransport::new();
    let notifier = RecordingNotifier::new();
    let ports = Ports {
        storage: storage.clone(),
        secure: secure.clone(),
        transport: transport.clone(),
        clock: clock.clone(),
        notifier: notifier.clone(),
        entropy: Box::new(SeededEntropy::new(seed)),
    };
    let mut core = Core::new(ports).unwrap();
    let events = core.subscribe();
    Node {
        core,
        transport,
        storage,
        secure,
        notifier,
        clock,
        events,
        phrase: String::new(),
    }
}

fn fresh(seed: &str, clock: &Arc<FakeClock>) -> Node {
    let mut n = boot(
        seed,
        MemoryStorage::new(),
        MemorySecureStore::new(),
        clock.clone(),
    );
    n.phrase = n.core.create_identity().unwrap().to_string();
    n
}

/// Two people who have swapped cards (verified), not yet connected.
fn pair() -> (Node, Node, UserId, UserId) {
    let clock = FakeClock::at(1_700_000_000_000);
    let mut a = fresh("alice", &clock);
    let mut b = fresh("bob", &clock);
    let (au, bu) = (
        a.core.own_uid().unwrap().clone(),
        b.core.own_uid().unwrap().clone(),
    );
    let (ac, bc) = (
        a.core.own_card(Some("Alice")).unwrap(),
        b.core.own_card(Some("Bob")).unwrap(),
    );
    assert_eq!(a.core.add_contact(&bc, ContactTrust::Verified).unwrap(), bu);
    assert_eq!(b.core.add_contact(&ac, ContactTrust::Verified).unwrap(), au);
    (a, b, au, bu)
}

/// Bring the link up on both ends and let the handshakes complete.
fn connect(a: &mut Node, b: &mut Node, au: &UserId, bu: &UserId) {
    a.transport.set_connected(bu, true);
    b.transport.set_connected(au, true);
    a.core.link_up(bu, ConnectionPath::DirectLan).unwrap();
    b.core.link_up(au, ConnectionPath::DirectLan).unwrap();
    pump(a, b, au, bu);
}

/// Deliver everything in flight, both ways, until quiet. Returns how many frames moved.
fn pump(a: &mut Node, b: &mut Node, au: &UserId, bu: &UserId) -> usize {
    let mut moved = 0;
    loop {
        let from_a = a.transport.drain();
        let from_b = b.transport.drain();
        if from_a.is_empty() && from_b.is_empty() {
            return moved;
        }
        for (_, f) in from_a {
            moved += 1;
            b.core.frame_received(au, &f);
        }
        for (_, f) in from_b {
            moved += 1;
            a.core.frame_received(bu, &f);
        }
    }
}

fn state_of(n: &Node, who: &UserId) -> ConnectionState {
    n.core
        .snapshot()
        .contacts
        .iter()
        .find(|c| &c.uid == who)
        .unwrap()
        .connection
}

fn status(n: &Node, id: &privcord_domain::MessageId) -> DeliveryState {
    n.core
        .snapshot()
        .messages
        .iter()
        .flat_map(|(_, v)| v)
        .find(|m| &m.message_id == id)
        .unwrap()
        .delivery_state
}

fn texts(n: &Node, with: &UserId) -> Vec<String> {
    n.core
        .snapshot()
        .messages
        .into_iter()
        .find(|(c, _)| c == &ConversationId::Direct(with.clone()))
        .map(|(_, v)| v.into_iter().map(|m| m.text).collect())
        .unwrap_or_default()
}

#[test]
fn identity_is_created_once_persists_and_recovers_from_its_phrase() {
    let clock = FakeClock::at(1);
    let mut n = boot(
        "id",
        MemoryStorage::new(),
        MemorySecureStore::new(),
        clock.clone(),
    );
    assert_eq!(n.core.own_card(None).unwrap_err(), ErrorCode::NoIdentity);
    let phrase = n.core.create_identity().unwrap();
    let uid = n.core.own_uid().unwrap().clone();
    assert_eq!(
        n.core.create_identity().unwrap_err(),
        ErrorCode::IdentityExists
    );
    // The same identity comes back after a restart (secure storage) and from the phrase on another device.
    let again = boot("id2", n.storage.clone(), n.secure.clone(), clock.clone());
    assert_eq!(again.core.own_uid(), Some(&uid));
    let mut other = boot(
        "other",
        MemoryStorage::new(),
        MemorySecureStore::new(),
        clock,
    );
    other.core.recover_identity(&phrase, "").unwrap();
    assert_eq!(other.core.own_uid(), Some(&uid));
    assert_eq!(
        other.core.recover_identity(&phrase, "").unwrap_err(),
        ErrorCode::IdentityExists
    );
    let mut bad = boot(
        "bad",
        MemoryStorage::new(),
        MemorySecureStore::new(),
        FakeClock::at(1),
    );
    assert_eq!(
        bad.core
            .recover_identity("not a real phrase", "")
            .unwrap_err(),
        ErrorCode::InvalidPhrase
    );
}

#[test]
fn contacts_are_validated_and_trust_never_drops() {
    let (mut a, _b, _au, bu) = pair();
    assert_eq!(
        a.core
            .add_contact("garbage", ContactTrust::Verified)
            .unwrap_err(),
        ErrorCode::InvalidCard
    );
    let own = a.core.own_card(None).unwrap();
    assert_eq!(
        a.core
            .add_contact(&own, ContactTrust::Verified)
            .unwrap_err(),
        ErrorCode::OwnCard
    );
    // Meeting Bob again as "introduced" does not demote a verified contact.
    let bc = ContactCard::decode(&_b.core.own_card(Some("Bob")).unwrap()).unwrap();
    let _ = bc;
    let card = _b.core.own_card(Some("Bob")).unwrap();
    a.core.add_contact(&card, ContactTrust::Introduced).unwrap();
    let view = a
        .core
        .snapshot()
        .contacts
        .into_iter()
        .find(|c| c.uid == bu)
        .unwrap();
    assert_eq!(view.trust, ContactTrust::Verified);
    assert_eq!(view.safety_number.split(' ').count(), 6);
    // Both sides compute the same safety number.
    assert_eq!(view.safety_number, _b.core.safety_number(&_au).unwrap());
    // Checking safety numbers does not change trust.
    a.core.set_checked(&bu, true).unwrap();
    let v = a
        .core
        .snapshot()
        .contacts
        .into_iter()
        .find(|c| c.uid == bu)
        .unwrap();
    assert!(v.checked);
    assert_eq!(v.trust, ContactTrust::Verified);
}

#[test]
fn two_engines_authenticate_and_exchange_messages_with_receipts() {
    let (mut a, mut b, au, bu) = pair();
    connect(&mut a, &mut b, &au, &bu);
    assert_eq!(
        state_of(&a, &bu),
        ConnectionState::Connected {
            path: ConnectionPath::DirectLan
        }
    );
    assert_eq!(
        state_of(&b, &au),
        ConnectionState::Connected {
            path: ConnectionPath::DirectLan
        }
    );

    let id = a.core.send_message(&bu, "héllo Bob ✓ 😀", None).unwrap();
    pump(&mut a, &mut b, &au, &bu);
    assert_eq!(texts(&b, &au), vec!["héllo Bob ✓ 😀"]);
    assert_eq!(status(&a, &id), DeliveryState::Delivered);
    assert_eq!(a.core.snapshot().queued, 0, "the receipt clears the outbox");
    assert!(
        matches!(b.notifier.taken().as_slice(), [Notification::MessageReceived { preview, .. }] if preview.starts_with("héllo"))
    );

    // A reply quotes the original, and reading is reported back.
    b.clock.advance(1000); // the order is by the sender's clock, so give the reply a later time
    let reply = b.core.send_message(&au, "hi Alice", Some(&id)).unwrap();
    pump(&mut a, &mut b, &au, &bu);
    let quoted = a.core.snapshot().messages[0]
        .1
        .iter()
        .find(|m| m.message_id == reply)
        .unwrap()
        .reply_to
        .clone()
        .unwrap();
    assert_eq!(quoted.id, id.to_string());
    a.core.mark_read(&bu).unwrap();
    pump(&mut a, &mut b, &au, &bu);
    assert_eq!(status(&b, &reply), DeliveryState::Read);
    assert_eq!(texts(&a, &bu), vec!["héllo Bob ✓ 😀", "hi Alice"]);
}

#[test]
fn messages_written_offline_are_kept_and_sent_when_the_link_comes_up() {
    let (mut a, mut b, au, bu) = pair();
    let id = a
        .core
        .send_message(&bu, "while you were away", None)
        .unwrap();
    assert_eq!(status(&a, &id), DeliveryState::Queued);
    assert_eq!(a.core.snapshot().queued, 1);
    connect(&mut a, &mut b, &au, &bu);
    assert_eq!(texts(&b, &au), vec!["while you were away"]);
    assert_eq!(status(&a, &id), DeliveryState::Delivered);
    assert_eq!(a.core.snapshot().queued, 0);
}

#[test]
fn a_lost_receipt_causes_a_resend_that_is_stored_once() {
    let (mut a, mut b, au, bu) = pair();
    connect(&mut a, &mut b, &au, &bu);
    let id = a.core.send_message(&bu, "once only", None).unwrap();
    // Deliver the message to Bob but lose his receipt on the way back.
    for (_, f) in a.transport.drain() {
        b.core.frame_received(&au, &f);
    }
    drop(b.transport.drain());
    assert_eq!(status(&a, &id), DeliveryState::Sent);
    // Nothing happens until the retry time; then Alice sends again.
    a.core.tick();
    assert!(a.transport.drain().is_empty());
    a.clock.advance(RETRY_AFTER_MS + 1);
    a.core.tick();
    pump(&mut a, &mut b, &au, &bu);
    assert_eq!(
        texts(&b, &au),
        vec!["once only"],
        "stored once despite two deliveries"
    );
    assert_eq!(status(&a, &id), DeliveryState::Delivered);
}

#[test]
fn replayed_tampered_and_oversized_frames_are_dropped() {
    let (mut a, mut b, au, bu) = pair();
    connect(&mut a, &mut b, &au, &bu);
    a.core.send_message(&bu, "real", None).unwrap();
    let frames = a.transport.drain();
    assert_eq!(frames.len(), 1);
    let original = frames[0].1.clone();

    // One changed character in the ciphertext: refused.
    let mut v: Value = serde_json::from_str(&original).unwrap();
    let ct = v["ct"].as_str().unwrap().to_owned();
    v["ct"] = format!(
        "{}{}",
        &ct[..ct.len() - 2],
        if ct.ends_with("AA") { "BB" } else { "AA" }
    )
    .into();
    b.core.frame_received(&au, &v.to_string());
    assert!(texts(&b, &au).is_empty());

    // The real one works, and playing it again changes nothing.
    b.core.frame_received(&au, &original);
    b.core.frame_received(&au, &original);
    assert_eq!(texts(&b, &au), vec!["real"]);
    assert_eq!(
        b.transport.drain().len(),
        1,
        "only one receipt, the replay got none"
    );

    // Unauthenticated plaintext, junk, and a huge frame are ignored.
    b.core.frame_received(&au, &json!({ "v": 1, "kind": "message", "messageId": "x", "clientMessageId": "x", "senderId": au.to_string(), "text": "plain", "clientCreatedAt": 5 }).to_string());
    b.core.frame_received(&au, "not json");
    b.core.frame_received(&au, &"x".repeat(200 * 1024));
    assert_eq!(texts(&b, &au), vec!["real"]);
}

#[test]
fn an_impostor_cannot_complete_the_handshake() {
    let (_a, mut b, au, bu) = pair();
    b.transport.set_connected(&au, true);
    b.core.link_up(&au, ConnectionPath::Bluetooth).unwrap();
    let _ours = b.transport.drain();
    // Mallory answers as Alice but signs with her own key.
    let mallory = Identity::generate(&mut SeededEntropy::new("mallory")).unwrap();
    let alice_card = ContactCard::decode(&_a.core.own_card(None).unwrap())
        .unwrap()
        .card;
    let fake = SecureChannel::new(
        au.as_str(),
        bu.as_str(),
        alice_card.sign.clone(),
        &mut SeededEntropy::new("m"),
    )
    .unwrap();
    let hello = fake.hello(&mallory).unwrap();
    b.core.frame_received(&au, &hello.to_value().to_string());
    assert_eq!(
        state_of(&b, &au),
        ConnectionState::Failed {
            reason: ConnectionFailure::AuthenticationFailed
        }
    );
    // And nothing she sends afterwards is believed.
    b.core.frame_received(
        &au,
        &json!({ "v": 1, "kind": "sc_data", "n": 0, "ct": "AAAA" }).to_string(),
    );
    assert!(texts(&b, &au).is_empty());
}

#[test]
fn a_message_that_claims_another_sender_is_refused() {
    use privcord_crypto::secure_channel::Hello;
    let (a, mut b, au, bu) = pair();
    // A peer that really holds Alice's key completes the handshake with Bob, then puts someone else's name on a message.
    let alice = Identity::from_phrase(&a.phrase, "").unwrap();
    assert_eq!(alice.uid().unwrap(), au);
    let bob_card = ContactCard::decode(&b.core.own_card(None).unwrap())
        .unwrap()
        .card;
    b.transport.set_connected(&au, true);
    b.core.link_up(&au, ConnectionPath::DirectLan).unwrap();
    let bob_hello =
        Hello::from_value(&serde_json::from_str(&b.transport.drain()[0].1).unwrap()).unwrap();
    let mut chan = SecureChannel::new(
        au.as_str(),
        bu.as_str(),
        bob_card.sign,
        &mut SeededEntropy::new("forger"),
    )
    .unwrap();
    b.core
        .frame_received(&au, &chan.hello(&alice).unwrap().to_value().to_string());
    chan.accept(&bob_hello).unwrap();
    let mut send = |sender: &str, id: &str| {
        let frame = json!({ "v": 1, "kind": "message", "messageId": id, "clientMessageId": id, "senderId": sender, "text": "from someone", "clientCreatedAt": 5 });
        b.core
            .frame_received(&au, &chan.encrypt(&frame).unwrap().to_value().to_string());
    };
    send("somebody-else", "m-forged");
    send(au.as_str(), "m-honest");
    assert_eq!(texts(&b, &au), vec!["from someone"]);
    assert_eq!(
        b.core.snapshot().messages[0].1[0].message_id.as_str(),
        "m-honest"
    );
}

#[test]
fn group_only_privacy_blocks_direct_messages_from_introduced_people_but_not_verified_ones() {
    let clock = FakeClock::at(1_700_000_000_000);
    let mut a = fresh("alice", &clock);
    let mut b = fresh("bob", &clock);
    let (au, bu) = (
        a.core.own_uid().unwrap().clone(),
        b.core.own_uid().unwrap().clone(),
    );
    // Alice knows Bob only through a group (introduced). Bob has stayed group-only.
    a.core
        .add_contact(&b.core.own_card(None).unwrap(), ContactTrust::Introduced)
        .unwrap();
    b.core
        .add_contact(&a.core.own_card(None).unwrap(), ContactTrust::Introduced)
        .unwrap();
    b.core.set_group_only(true).unwrap();
    connect(&mut a, &mut b, &au, &bu);
    // Alice learned Bob's choice over the link, so she cannot even start a direct chat.
    assert!(!a.core.snapshot().contacts[0].can_message);
    assert_eq!(
        a.core.send_message(&bu, "hi", None).unwrap_err(),
        ErrorCode::DirectNotAllowed
    );
    assert_eq!(
        b.core.send_message(&au, "hi", None).unwrap_err(),
        ErrorCode::DirectNotAllowed
    );

    // If a message arrives anyway (she had not heard yet) it is declined and she is told.
    let mut a2 = fresh("alice2", &clock);
    let au2 = a2.core.own_uid().unwrap().clone();
    a2.core
        .add_contact(&b.core.own_card(None).unwrap(), ContactTrust::Introduced)
        .unwrap();
    b.core
        .add_contact(&a2.core.own_card(None).unwrap(), ContactTrust::Introduced)
        .unwrap();
    a2.transport.set_connected(&bu, true);
    b.transport.set_connected(&au2, true);
    a2.core.link_up(&bu, ConnectionPath::DirectNat).unwrap();
    b.core.link_up(&au2, ConnectionPath::DirectNat).unwrap();
    // Handshake only: hold back Bob's privacy frame so Alice does not know yet.
    for (_, f) in a2.transport.drain() {
        b.core.frame_received(&au2, &f);
    }
    let bob_frames = b.transport.drain();
    for (_, f) in bob_frames.iter().take(1) {
        a2.core.frame_received(&bu, f);
    }
    let id = a2.core.send_message(&bu, "uninvited", None).unwrap();
    for (_, f) in a2.transport.drain() {
        b.core.frame_received(&au2, &f);
    }
    for (_, f) in b.transport.drain() {
        a2.core.frame_received(&bu, &f);
    }
    assert_eq!(status(&a2, &id), DeliveryState::Failed);
    assert!(texts(&b, &au2).is_empty());

    // A verified contact is never blocked by group-only.
    let mut c = fresh("carol", &clock);
    let cu = c.core.own_uid().unwrap().clone();
    b.core
        .add_contact(&c.core.own_card(None).unwrap(), ContactTrust::Verified)
        .unwrap();
    c.core
        .add_contact(&b.core.own_card(None).unwrap(), ContactTrust::Verified)
        .unwrap();
    assert!(b.core.send_message(&cu, "hello Carol", None).is_ok());
}

#[test]
fn a_failed_write_changes_nothing_and_a_failed_receive_is_not_acknowledged() {
    let (mut a, mut b, au, bu) = pair();
    // Sending: the message and its outbox entry are stored together or not at all.
    a.storage.fail_next_applies(1);
    assert_eq!(
        a.core.send_message(&bu, "lost", None).unwrap_err(),
        ErrorCode::Storage
    );
    assert!(a.core.snapshot().messages.is_empty());
    assert_eq!(a.core.snapshot().queued, 0);
    assert!(a.storage.messages().unwrap().is_empty() && a.storage.outbox().unwrap().is_empty());
    let id = a.core.send_message(&bu, "kept", None).unwrap();
    assert_eq!(a.storage.messages().unwrap().len(), 1);
    assert_eq!(a.storage.outbox().unwrap().len(), 1);

    // Receiving: if Bob cannot store it he does not acknowledge, so Alice's retry delivers it.
    connect(&mut a, &mut b, &au, &bu);
    // The first send happened during connect(); drop that attempt by failing Bob's storage first.
    let (mut a, mut b, au, bu) = pair();
    let id2 = a.core.send_message(&bu, "will retry", None).unwrap();
    b.storage.fail_next_applies(1);
    connect(&mut a, &mut b, &au, &bu);
    assert!(texts(&b, &au).is_empty());
    assert_ne!(status(&a, &id2), DeliveryState::Delivered);
    a.clock.advance(RETRY_AFTER_MS + 1);
    a.core.tick();
    pump(&mut a, &mut b, &au, &bu);
    assert_eq!(texts(&b, &au), vec!["will retry"]);
    assert_eq!(status(&a, &id2), DeliveryState::Delivered);
    let _ = id;
}

#[test]
fn state_survives_a_restart() {
    let (mut a, b, _au, bu) = pair();
    let id = a
        .core
        .send_message(&bu, "queued before the crash", None)
        .unwrap();
    // "Crash": throw the engine away and rebuild it from what was persisted.
    let rebuilt = boot(
        "alice-again",
        a.storage.clone(),
        a.secure.clone(),
        a.clock.clone(),
    );
    assert_eq!(rebuilt.core.own_uid(), a.core.own_uid());
    let snap = rebuilt.core.snapshot();
    assert_eq!(snap.contacts.len(), 1);
    assert_eq!(snap.queued, 1);
    assert_eq!(snap.messages[0].1[0].message_id, id);
    // ...and it still delivers once the link is up.
    let (mut a, mut b) = (rebuilt, b);
    let (au, bu) = (
        a.core.own_uid().unwrap().clone(),
        b.core.own_uid().unwrap().clone(),
    );
    connect(&mut a, &mut b, &au, &bu);
    assert_eq!(texts(&b, &au), vec!["queued before the crash"]);
}

#[test]
fn a_dropped_transport_keeps_identity_and_reconnects() {
    let (mut a, mut b, au, bu) = pair();
    connect(&mut a, &mut b, &au, &bu);
    a.core.link_down(&bu);
    assert_eq!(
        state_of(&a, &bu),
        ConnectionState::Reconnecting { attempt: 1 }
    );
    // The session ended, not the identity: a new link authenticates again and carries on.
    a.transport.drain();
    b.core.link_down(&au);
    connect(&mut a, &mut b, &au, &bu);
    a.core.send_message(&bu, "after the drop", None).unwrap();
    pump(&mut a, &mut b, &au, &bu);
    assert_eq!(texts(&b, &au), vec!["after the drop"]);
}

#[test]
fn events_are_numbered_in_order_and_a_slow_subscriber_is_told_it_lagged() {
    let (mut a, mut b, au, bu) = pair();
    // A reader that keeps up sees every event, numbered without gaps.
    let mut seen = vec![];
    connect(&mut a, &mut b, &au, &bu);
    while let Ok((seq, e)) = a.events.try_recv() {
        seen.push((seq, e));
    }
    assert!(seen.windows(2).all(|w| w[1].0 == w[0].0 + 1), "{seen:?}");
    assert!(seen.iter().any(|(_, e)| matches!(
        e,
        EngineEvent::PeerStateChanged {
            state: ConnectionState::Connected { .. },
            ..
        }
    )));

    // One that never reads is told how many it missed, instead of the engine blocking or losing events silently.
    for i in 0..400 {
        a.core.send_message(&bu, &format!("m{i}"), None).unwrap();
    }
    let mut lagged = 0;
    let mut last = 0;
    while let Ok((seq, e)) = a.events.try_recv() {
        last = seq;
        if let EngineEvent::Lagged { missed } = e {
            lagged += missed;
        }
    }
    assert!(lagged > 0 && last > 0);
    // The snapshot has everything regardless of what was missed.
    assert_eq!(a.core.snapshot().messages[0].1.len(), 400);
}

#[test]
fn shutdown_refuses_further_work_and_is_idempotent() {
    let (mut a, _b, _au, bu) = pair();
    a.core.shutdown();
    a.core.shutdown();
    assert_eq!(
        a.core.send_message(&bu, "late", None).unwrap_err(),
        ErrorCode::ShuttingDown
    );
    assert_eq!(
        a.core.add_contact("x", ContactTrust::Verified).unwrap_err(),
        ErrorCode::ShuttingDown
    );
    let mut last = None;
    while let Ok((_, e)) = a.events.try_recv() {
        last = Some(e);
    }
    assert_eq!(last, Some(EngineEvent::ShutDown));
}

#[test]
fn a_hello_that_overtakes_the_link_up_report_is_not_lost() {
    let (mut a, mut b, au, bu) = pair();
    a.transport.set_connected(&bu, true);
    b.transport.set_connected(&au, true);
    a.core.link_up(&bu, ConnectionPath::DirectLan).unwrap();
    // Alice's hello reaches Bob before his adapter has reported the link.
    for (_, f) in a.transport.drain() {
        b.core.frame_received(&au, &f);
    }
    b.core.link_up(&au, ConnectionPath::DirectLan).unwrap();
    pump(&mut a, &mut b, &au, &bu);
    assert_eq!(
        state_of(&a, &bu),
        ConnectionState::Connected {
            path: ConnectionPath::DirectLan
        }
    );
    assert_eq!(
        state_of(&b, &au),
        ConnectionState::Connected {
            path: ConnectionPath::DirectLan
        }
    );
    // An old early hello is not kept forever.
    let (mut a, mut b, au, bu) = pair();
    a.transport.set_connected(&bu, true);
    b.transport.set_connected(&au, true);
    a.core.link_up(&bu, ConnectionPath::DirectLan).unwrap();
    for (_, f) in a.transport.drain() {
        b.core.frame_received(&au, &f);
    }
    b.clock.advance(60_000);
    b.core.link_up(&au, ConnectionPath::DirectLan).unwrap();
    pump(&mut a, &mut b, &au, &bu);
    assert_ne!(
        state_of(&b, &au),
        ConnectionState::Connected {
            path: ConnectionPath::DirectLan
        }
    );
}

#[test]
fn the_engine_runs_on_real_sqlite_and_recovers_after_a_restart() {
    use privcord_storage::SqliteStorage;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("alice.db");
    let clock = FakeClock::at(1_700_000_000_000);
    let secure = MemorySecureStore::new();
    let (bu, bob_card, mut b) = {
        let b = fresh("bob", &clock);
        (
            b.core.own_uid().unwrap().clone(),
            b.core.own_card(Some("Bob")).unwrap(),
            b,
        )
    };
    let sqlite =
        |p: &std::path::Path| -> Arc<dyn Storage> { Arc::new(SqliteStorage::open(p).unwrap()) };
    let make = |storage: Arc<dyn Storage>, seed: &str| {
        let transport = RecordingTransport::new();
        let ports = Ports {
            storage,
            secure: secure.clone(),
            transport: transport.clone(),
            clock: clock.clone(),
            notifier: RecordingNotifier::new(),
            entropy: Box::new(SeededEntropy::new(seed)),
        };
        (Core::new(ports).unwrap(), transport)
    };
    let (mut core, _t) = make(sqlite(&path), "a1");
    core.create_identity().unwrap();
    let au = core.own_uid().unwrap().clone();
    core.add_contact(&bob_card, ContactTrust::Verified).unwrap();
    let id = core.send_message(&bu, "stored in sqlite", None).unwrap();
    drop(core);

    // A new process opens the same file and finds everything, including the undelivered message.
    let (mut core, transport) = make(sqlite(&path), "a2");
    assert_eq!(core.own_uid(), Some(&au));
    let snap = core.snapshot();
    assert_eq!((snap.contacts.len(), snap.queued), (1, 1));
    assert_eq!(snap.messages[0].1[0].message_id, id);

    // And it delivers to a live peer once the link is up.
    b.core
        .add_contact(
            &core.own_card(Some("Alice")).unwrap(),
            ContactTrust::Verified,
        )
        .unwrap();
    transport.set_connected(&bu, true);
    b.transport.set_connected(&au, true);
    core.link_up(&bu, ConnectionPath::DirectLan).unwrap();
    b.core.link_up(&au, ConnectionPath::DirectLan).unwrap();
    for _ in 0..4 {
        for (_, f) in transport.drain() {
            b.core.frame_received(&au, &f);
        }
        for (_, f) in b.transport.drain() {
            core.frame_received(&bu, &f);
        }
    }
    assert_eq!(texts(&b, &au), vec!["stored in sqlite"]);
    assert_eq!(core.snapshot().queued, 0);
    assert_eq!(
        core.snapshot().messages[0].1[0].delivery_state,
        DeliveryState::Delivered
    );
}
