//! Group behaviour through the engine: three real engines, fake radios.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::rng::SeededEntropy;
use privcord_domain::{
    message::DeliveryState, privacy::ContactTrust, state::ConnectionPath, UserId,
};
use privcord_engine::{Core, Ports};
use privcord_ports::testing::{
    FakeClock, MemorySecureStore, MemoryStorage, RecordingNotifier, RecordingTransport,
};
use std::sync::Arc;

struct Node {
    core: Core,
    transport: Arc<RecordingTransport>,
    storage: Arc<MemoryStorage>,
    secure: Arc<MemorySecureStore>,
    clock: Arc<FakeClock>,
    uid: UserId,
}

fn start(
    seed: &str,
    storage: Arc<MemoryStorage>,
    secure: Arc<MemorySecureStore>,
    clock: Arc<FakeClock>,
    create: bool,
) -> Node {
    let transport = RecordingTransport::new();
    let mut core = Core::new(Ports {
        storage: storage.clone(),
        secure: secure.clone(),
        transport: transport.clone(),
        clock: clock.clone(),
        notifier: RecordingNotifier::new(),
        entropy: Box::new(SeededEntropy::new(seed)),
    })
    .unwrap();
    if create {
        core.create_identity().unwrap();
    }
    let uid = core.own_uid().unwrap().clone();
    Node {
        core,
        transport,
        storage,
        secure,
        clock,
        uid,
    }
}

fn node(seed: &str, clock: &Arc<FakeClock>) -> Node {
    start(
        seed,
        MemoryStorage::new(),
        MemorySecureStore::new(),
        clock.clone(),
        true,
    )
}

fn befriend(a: &mut Node, b: &mut Node) {
    let (ac, bc) = (
        a.core.own_card(None).unwrap(),
        b.core.own_card(None).unwrap(),
    );
    a.core.add_contact(&bc, ContactTrust::Verified).unwrap();
    b.core.add_contact(&ac, ContactTrust::Verified).unwrap();
}

/// Deliver every frame in flight between all nodes until quiet.
fn pump(nodes: &mut [&mut Node]) {
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

fn link(nodes: &mut [&mut Node], i: usize, j: usize) {
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
    pump(nodes);
}

fn group_texts(n: &Node, gid: &str) -> Vec<String> {
    n.core
        .snapshot()
        .messages
        .into_iter()
        .filter(|(c, _)| c.storage_key() == gid)
        .flat_map(|(_, v)| v.into_iter().map(|m| m.text))
        .collect()
}

#[test]
fn a_group_reaches_members_who_never_met_and_introduces_them() {
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
    link(&mut all, 0, 1);
    link(&mut all, 0, 2);
    let [a, b, c] = all;

    for n in [&*b, &*c] {
        let snap = n.core.snapshot();
        assert_eq!(snap.groups.len(), 1, "member learns of the group");
        assert_eq!(snap.groups[0].name, "Trip");
        assert_eq!(snap.groups[0].members.len(), 3);
    }
    // Bob now holds Carol's card, as an introduced contact only.
    let bob_view = b.core.snapshot();
    let carol = bob_view.contacts.iter().find(|x| x.uid == c.uid).unwrap();
    assert_eq!(carol.trust, ContactTrust::Introduced);
    assert!(a.core.snapshot().groups[0]
        .members
        .iter()
        .any(|(u, admin)| *u == a.uid.as_str() && *admin));
    assert_eq!(a.core.snapshot().groups[0].group_id, gid);
}

#[test]
fn group_messages_fan_out_are_stored_once_and_acknowledged() {
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
    link(&mut all, 0, 1);
    link(&mut all, 0, 2);
    let [a, b, c] = all;
    let clock = a.clock.clone();

    let id = a.core.send_group_message(&gid, "meet at 9", None).unwrap();
    let mut all = [&mut *a, &mut *b, &mut *c];
    pump(&mut all);
    assert_eq!(group_texts(b, &gid), ["meet at 9"]);
    assert_eq!(group_texts(c, &gid), ["meet at 9"]);
    let sent = a
        .core
        .snapshot()
        .messages
        .into_iter()
        .flat_map(|(_, v)| v)
        .find(|m| m.message_id == id)
        .unwrap();
    assert_eq!(sent.delivery_state, DeliveryState::Delivered);
    assert_eq!(a.core.snapshot().queued, 0, "every member acknowledged");

    // A reply from Bob, relayed to Carol only through the group's own links? Bob has no link to Carol: it waits.
    clock.advance(1000);
    b.core.send_group_message(&gid, "ok", None).unwrap();
    assert_eq!(b.core.snapshot().queued, 2, "one entry per other member");
    let mut all = [&mut *a, &mut *b, &mut *c];
    pump(&mut all);
    assert_eq!(group_texts(a, &gid), ["meet at 9", "ok"]);
    assert_eq!(
        b.core.snapshot().queued,
        1,
        "Carol is unreachable and still queued"
    );
}

#[test]
fn outsiders_and_removed_members_cannot_post_and_groups_survive_a_restart() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b, mut c) = (
        node("alice", &clock),
        node("bob", &clock),
        node("carol", &clock),
    );
    befriend(&mut a, &mut b);
    befriend(&mut a, &mut c);
    let gid = a.core.create_group("Trip", &[b.uid.clone()]).unwrap();
    let mut all = [&mut a, &mut b, &mut c];
    link(&mut all, 0, 1);
    link(&mut all, 0, 2);
    let [a, b, c] = all;

    // Carol is not in the group: she cannot post to it and does not even learn it exists.
    assert!(c.core.snapshot().groups.is_empty());
    assert_eq!(
        c.core.send_group_message(&gid, "hi", None),
        Err(privcord_engine::ErrorCode::NoSuchGroup)
    );

    // Bob is removed: Alice stops accepting his messages.
    a.core.remove_group_member(&gid, &b.uid).unwrap();
    let mut all = [&mut *a, &mut *b, &mut *c];
    pump(&mut all);
    // Bob learned of his removal over the link, so he can no longer write to it.
    assert!(b.core.snapshot().groups.is_empty());
    assert_eq!(
        b.core.send_group_message(&gid, "still here?", None),
        Err(privcord_engine::ErrorCode::NoSuchGroup)
    );

    // Restart Alice from the same storage: the group, its membership and its messages are back.
    let before = a.core.snapshot().groups.clone();
    let (storage, secure, clock) = (a.storage.clone(), a.secure.clone(), a.clock.clone());
    let again = start("alice-2", storage, secure, clock, false);
    assert_eq!(again.core.snapshot().groups, before);
    // Bob restarted: a group he was removed from is not offered as one from before protocol v2 to make again.
    let bob = start(
        "bob-2",
        b.storage.clone(),
        b.secure.clone(),
        b.clock.clone(),
        false,
    );
    assert!(bob.core.snapshot().groups.is_empty());
    assert!(bob.core.snapshot().legacy_groups.is_empty());
}

#[test]
fn members_without_a_link_to_each_other_still_get_each_others_messages_through_the_group() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b, mut c, mut d) = (
        node("alice", &clock),
        node("bob", &clock),
        node("carol", &clock),
        node("dave", &clock),
    );
    // Alice knows everyone; Carol and Dave verified each other; Bob verified only Alice.
    befriend(&mut a, &mut b);
    befriend(&mut a, &mut c);
    befriend(&mut a, &mut d);
    befriend(&mut c, &mut d);
    let gid = a
        .core
        .create_group("Four", &[b.uid.clone(), c.uid.clone(), d.uid.clone()])
        .unwrap();
    let mut all = [&mut a, &mut b, &mut c, &mut d];
    link(&mut all, 0, 1);
    link(&mut all, 0, 2);
    link(&mut all, 0, 3);
    link(&mut all, 2, 3);
    let [a, b, c, d] = all;

    // Carol writes; Bob has no link to her. Alice passes it on.
    let id = c.core.send_group_message(&gid, "carol here", None).unwrap();
    let mut all = [&mut *a, &mut *b, &mut *c, &mut *d];
    pump(&mut all);
    assert_eq!(group_texts(a, &gid), ["carol here"]);
    assert_eq!(group_texts(d, &gid), ["carol here"]);
    assert!(
        group_texts(b, &gid).is_empty(),
        "not yet: no link from Carol to Bob"
    );
    for _ in 0..8 {
        clock.advance(4_000);
        for n in [&mut *a, &mut *b, &mut *c, &mut *d] {
            n.core.tick();
        }
        let mut all = [&mut *a, &mut *b, &mut *c, &mut *d];
        pump(&mut all);
    }
    assert_eq!(
        group_texts(b, &gid),
        ["carol here"],
        "Bob got it through Alice"
    );
    // Bob's receipt came back the same way: Carol sees it delivered to everyone, nothing left queued.
    let sent = c
        .core
        .snapshot()
        .messages
        .into_iter()
        .flat_map(|(_, v)| v)
        .find(|m| m.message_id == id)
        .unwrap();
    assert_eq!(sent.delivery_state, DeliveryState::Delivered);
    assert_eq!(c.core.snapshot().queued, 0);

    // And the other way: Bob writes, Carol and Dave get it, once each.
    b.core.send_group_message(&gid, "bob too", None).unwrap();
    for _ in 0..8 {
        let mut all = [&mut *a, &mut *b, &mut *c, &mut *d];
        pump(&mut all);
        clock.advance(4_000);
        for n in [&mut *a, &mut *b, &mut *c, &mut *d] {
            n.core.tick();
        }
    }
    let mut all = [&mut *a, &mut *b, &mut *c, &mut *d];
    pump(&mut all);
    for n in [&*a, &*c, &*d] {
        assert_eq!(
            group_texts(n, &gid)
                .iter()
                .filter(|t| *t == "bob too")
                .count(),
            1
        );
    }
    assert_eq!(b.core.snapshot().queued, 0);
}

#[test]
fn a_voice_note_reaches_a_member_without_a_link_and_a_new_group_dials_everyone_at_once() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b, mut c) = (
        node("alice", &clock),
        node("bob", &clock),
        node("carol", &clock),
    );
    befriend(&mut a, &mut b);
    befriend(&mut a, &mut c);
    let mut events = b.core.subscribe();
    let gid = a
        .core
        .create_group("Three", &[b.uid.clone(), c.uid.clone()])
        .unwrap();
    let mut all = [&mut a, &mut b, &mut c];
    link(&mut all, 0, 1);
    link(&mut all, 0, 2);
    let [a, b, c] = all;

    // Bob met Carol through the group: he asks for a link to her right away, not after a retry delay.
    let mut dialed = Vec::new();
    while let Ok((_, e)) = events.try_recv() {
        if let privcord_engine::EngineEvent::DialRequested { peer, .. } = e {
            dialed.push(peer);
        }
    }
    assert!(
        dialed.contains(&c.uid),
        "Bob dials Carol as soon as he learns of her"
    );

    // No link between Carol and Bob: her voice note still reaches him through Alice, whole, and counts as delivered.
    let voice: Vec<u8> = (0..40_000u32).map(|i| (i * 7 % 251) as u8).collect();
    let id = c
        .core
        .send_group_file(&gid, "voice-note.m4a", "audio/mp4", voice.clone(), None)
        .unwrap();
    for _ in 0..8 {
        let mut all = [&mut *a, &mut *b, &mut *c];
        pump(&mut all);
        clock.advance(4_000);
        for n in [&mut *a, &mut *b, &mut *c] {
            n.core.tick();
        }
    }
    let mut all = [&mut *a, &mut *b, &mut *c];
    pump(&mut all);
    let got = b.core.file(&id).unwrap().expect("Bob has the voice note");
    assert_eq!(got.bytes, voice);
    assert_eq!(a.core.file(&id).unwrap().unwrap().bytes, voice);
    let sent = c
        .core
        .snapshot()
        .messages
        .into_iter()
        .flat_map(|(_, v)| v)
        .find(|m| m.message_id == id)
        .unwrap();
    assert_eq!(sent.delivery_state, DeliveryState::Delivered);
    assert_eq!(c.core.snapshot().queued, 0);
}

#[test]
fn sending_to_a_member_without_a_link_dials_them_first_and_passes_it_on_only_later() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b, mut c) = (
        node("alice", &clock),
        node("bob", &clock),
        node("carol", &clock),
    );
    befriend(&mut a, &mut b);
    befriend(&mut a, &mut c);
    // Carol listens from the start: she dials Bob as soon as she learns of him through the group (and a send soon after
    // does not dial him again; see connect_now).
    let mut events = c.core.subscribe();
    let gid = a
        .core
        .create_group("Three", &[b.uid.clone(), c.uid.clone()])
        .unwrap();
    let mut all = [&mut a, &mut b, &mut c];
    link(&mut all, 0, 1);
    link(&mut all, 0, 2);
    let [a, b, c] = all;

    c.core.send_group_message(&gid, "hi bob", None).unwrap();
    let dialed: Vec<UserId> = std::iter::from_fn(|| events.try_recv().ok())
        .filter_map(|(_, e)| match e {
            privcord_engine::EngineEvent::DialRequested { peer, .. } => Some(peer),
            _ => None,
        })
        .collect();
    assert!(
        dialed.contains(&b.uid),
        "Carol dials Bob the moment she writes to him"
    );

    // For the first few seconds nothing is handed to Alice for Bob: the direct link gets its chance.
    clock.advance(3_000);
    for n in [&mut *a, &mut *b, &mut *c] {
        n.core.tick();
    }
    let mut all = [&mut *a, &mut *b, &mut *c];
    pump(&mut all);
    assert!(group_texts(b, &gid).is_empty());

    // The link comes up: the message goes straight to Bob, once.
    let mut all = [&mut *a, &mut *b, &mut *c];
    link(&mut all, 1, 2);
    let [a, b, c] = all;
    let _ = a;
    assert_eq!(group_texts(b, &gid), ["hi bob"]);
    assert_eq!(c.core.snapshot().queued, 0);
}
