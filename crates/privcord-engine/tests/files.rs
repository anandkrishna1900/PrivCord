//! File transfer through the engine: real engines, fake radios.
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

fn file_of(n: &Node, id: &privcord_domain::MessageId) -> Option<privcord_ports::StoredFile> {
    n.core.file(id).unwrap()
}

fn state_of(n: &Node, id: &privcord_domain::MessageId) -> DeliveryState {
    n.core
        .snapshot()
        .messages
        .into_iter()
        .flat_map(|(_, v)| v)
        .find(|m| &m.message_id == id)
        .unwrap()
        .delivery_state
}

fn sample(len: usize) -> Vec<u8> {
    (0..len).map(|i| u8::try_from(i % 251).unwrap()).collect()
}

#[test]
fn a_file_arrives_intact_is_kept_and_acknowledged() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    befriend(&mut a, &mut b);
    let data = sample(40_000); // several chunks
    let id = a
        .core
        .send_file(
            &b.uid,
            "../notes.bin",
            "application/octet-stream",
            data.clone(),
            None,
        )
        .unwrap();
    assert_eq!(state_of(&a, &id), DeliveryState::Queued, "waits for a link");
    let mut all = [&mut a, &mut b];
    link(&mut all, 0, 1);
    let [a, b] = all;
    let got = file_of(b, &id).expect("receiver stored the file");
    assert_eq!(got.bytes, data);
    assert!(!got.name.contains('/'), "name is cleaned: {}", got.name);
    assert_eq!(state_of(a, &id), DeliveryState::Delivered);
    assert_eq!(a.core.snapshot().queued, 0);
    // The receiver's message row says it is a file and carries the cleaned name.
    let msg = b
        .core
        .snapshot()
        .messages
        .into_iter()
        .flat_map(|(_, v)| v)
        .find(|m| m.message_id == id)
        .unwrap();
    assert_eq!(msg.kind, privcord_domain::message::MessageKind::File);
    assert_eq!(msg.text, got.name);
}

#[test]
fn a_file_frame_tampered_in_transit_is_refused_and_never_stored() {
    use privcord_engine::LinkSecurity;
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    befriend(&mut a, &mut b);
    let id = a
        .core
        .send_file(&b.uid, "pic.png", "image/png", sample(30_000), None)
        .unwrap();
    let (au, bu) = (a.uid.clone(), b.uid.clone());
    a.transport.set_connected(&bu, true);
    b.transport.set_connected(&au, true);
    a.core
        .link_up_with(
            &bu,
            ConnectionPath::DirectNat,
            LinkSecurity::TransportEncrypted,
        )
        .unwrap();
    b.core
        .link_up_with(
            &au,
            ConnectionPath::DirectNat,
            LinkSecurity::TransportEncrypted,
        )
        .unwrap();
    // Protocol v2: every frame is inside the post-quantum channel, so a byte changed in transit makes the frame fail to
    // decrypt; the chunk is refused whole and can never be stored as part of the file. (The file's own hash check
    // against a dishonest sender is covered by the domain crate's file tests.)
    let mut tampered = false;
    loop {
        let from_a = a.transport.drain();
        let from_b = b.transport.drain();
        if from_a.is_empty() && from_b.is_empty() {
            break;
        }
        for (_, f) in from_a {
            let mut v: serde_json::Value = serde_json::from_str(&f).unwrap();
            assert_ne!(
                v["kind"], "file_chunk",
                "no file chunk travels outside the channel"
            );
            // The first big frame is a file chunk.
            if !tampered && v["kind"] == "pq" && v["ct"].as_str().is_some_and(|c| c.len() > 10_000)
            {
                let data = v["ct"].as_str().unwrap().to_owned();
                let first = if data.starts_with('A') { "B" } else { "A" };
                v["ct"] = serde_json::Value::String(format!("{first}{}", &data[1..]));
                tampered = true;
            }
            b.core.frame_received(&au, &v.to_string());
        }
        for (_, f) in from_b {
            a.core.frame_received(&bu, &f);
        }
    }
    assert!(tampered);
    assert!(
        file_of(&b, &id).is_none(),
        "a file with a refused chunk is not stored"
    );
    assert_ne!(state_of(&a, &id), DeliveryState::Delivered);
}

#[test]
fn bad_sizes_and_unwanted_files_are_refused() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    befriend(&mut a, &mut b);
    assert_eq!(
        a.core
            .send_file(&b.uid, "x", "text/plain", Vec::new(), None),
        Err(privcord_engine::ErrorCode::BadFile)
    );
    assert_eq!(
        a.core.send_file(
            &b.uid,
            "big",
            "text/plain",
            vec![1; 8 * 1024 * 1024 + 1],
            None
        ),
        Err(privcord_engine::ErrorCode::BadFile)
    );
    // Dave stays group-only: a file from someone he only knows by introduction is declined, not stored.
    let clock2 = FakeClock::at(1_700_000_000_000);
    let (mut c, mut d) = (node("carol", &clock2), node("dave", &clock2));
    let (cc, dc) = (
        c.core.own_card(None).unwrap(),
        d.core.own_card(None).unwrap(),
    );
    c.core.add_contact(&dc, ContactTrust::Verified).unwrap();
    d.core.add_contact(&cc, ContactTrust::Introduced).unwrap();
    d.core.set_group_only(true).unwrap();
    let id = c
        .core
        .send_file(&d.uid, "a.txt", "text/plain", sample(100), None)
        .unwrap();
    let mut all = [&mut c, &mut d];
    link(&mut all, 0, 1);
    let [c, d] = all;
    assert!(file_of(d, &id).is_none());
    assert_eq!(state_of(c, &id), DeliveryState::Failed);
}

#[test]
fn a_group_file_reaches_every_member_and_survives_a_restart() {
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
    let data = sample(20_000);
    let id = a
        .core
        .send_group_file(&gid, "map.png", "image/png", data.clone(), None)
        .unwrap();
    let mut all = [&mut *a, &mut *b, &mut *c];
    pump(&mut all);
    assert_eq!(file_of(b, &id).unwrap().bytes, data);
    assert_eq!(file_of(c, &id).unwrap().bytes, data);
    assert_eq!(a.core.snapshot().queued, 0);

    // Bob restarts from the same storage and still has it.
    let (storage, secure, clock) = (b.storage.clone(), b.secure.clone(), b.clock.clone());
    let again = start("bob-2", storage, secure, clock, false);
    assert_eq!(file_of(&again, &id).unwrap().bytes, data);
}
