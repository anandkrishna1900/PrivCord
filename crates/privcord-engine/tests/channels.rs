//! Channels and the mesh through the engine: real engines, fake radios.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::rng::SeededEntropy;
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
    Node {
        core,
        transport,
        storage,
        secure,
        clock,
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

fn channel_texts(n: &Node, name: &str) -> Vec<String> {
    let key = format!("chan:{name}");
    n.core
        .snapshot()
        .messages
        .into_iter()
        .filter(|(c, _)| c.storage_key() == key)
        .flat_map(|(_, v)| v.into_iter().map(|m| m.text))
        .collect()
}

#[test]
fn channels_are_normalised_remembered_and_can_be_left() {
    let clock = FakeClock::at(1_700_000_000_000);
    let mut a = node("alice", &clock);
    assert_eq!(a.core.join_channel(" #Cafe Talk ").unwrap(), "cafe-talk");
    assert_eq!(
        a.core.join_channel("cafe-talk").unwrap(),
        "cafe-talk",
        "joining twice is harmless"
    );
    assert_eq!(
        a.core.join_channel("!!!"),
        Err(privcord_engine::ErrorCode::BadChannel)
    );
    assert_eq!(a.core.snapshot().channels, ["cafe-talk"]);
    let (storage, secure, clock2) = (a.storage.clone(), a.secure.clone(), a.clock.clone());
    let mut again = start("alice-2", storage, secure, clock2, false);
    assert_eq!(
        again.core.snapshot().channels,
        ["cafe-talk"],
        "survives a restart"
    );
    again.core.leave_channel("cafe-talk").unwrap();
    assert!(again.core.snapshot().channels.is_empty());
    assert_eq!(
        again.core.send_channel_message("cafe-talk", "hi"),
        Err(privcord_engine::ErrorCode::NotJoined)
    );
}

#[test]
fn a_message_is_carried_for_a_neighbour_who_arrives_later_and_never_stored_twice() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b, mut other) = (
        node("alice", &clock),
        node("bob", &clock),
        node("zed", &clock),
    );
    for n in [&mut a, &mut b] {
        n.core.join_channel("town").unwrap();
    }
    other.core.join_channel("elsewhere").unwrap();
    // Alone: nobody to send to, but the message is kept and shown as sent.
    a.core
        .send_channel_message("town", "  hello town ")
        .unwrap();
    assert!(a.transport.drain_raw().is_empty());
    assert_eq!(channel_texts(&a, "town"), ["hello town"]);

    // Bob walks into range: Alice hands over what she carries.
    a.core.mesh_link_up("bob-phone").unwrap();
    let sent = a.transport.drain_raw();
    assert_eq!(sent.len(), 1);
    b.core.mesh_frame("alice-phone", &sent[0].1);
    assert_eq!(channel_texts(&b, "town"), ["hello town"]);
    // A copy arriving again (another route) changes nothing.
    b.core.mesh_frame("somebody-else", &sent[0].1);
    assert_eq!(channel_texts(&b, "town"), ["hello town"]);

    // Someone in a different channel cannot read it.
    other.core.mesh_frame("alice-phone", &sent[0].1);
    assert!(channel_texts(&other, "town").is_empty());
    assert!(other.core.snapshot().messages.is_empty());

    // Garbage and oversize frames are ignored.
    b.core.mesh_frame("x", "not json");
    b.core.mesh_frame("x", &"a".repeat(200_000));
    assert_eq!(channel_texts(&b, "town").len(), 1);

    // A link that drops loses nothing: coming back, everything is handed over again.
    a.core.mesh_link_down("bob-phone");
    a.core.mesh_link_up("bob-phone").unwrap();
    assert_eq!(a.transport.drain_raw().len(), 1);
}
