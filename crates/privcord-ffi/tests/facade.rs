//! The facade, driven the way Kotlin will drive it: through callbacks and plain data only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_ffi::*;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Default)]
struct FakeKeystore(Mutex<Option<Vec<u8>>>, Mutex<Option<Vec<u8>>>);
impl SecureStoreCallbacks for FakeKeystore {
    fn load_identity(&self) -> Option<Vec<u8>> {
        self.0.lock().unwrap().clone()
    }
    fn save_identity(&self, secrets: Vec<u8>) -> bool {
        *self.0.lock().unwrap() = Some(secrets);
        true
    }
    fn delete_identity(&self) {
        *self.0.lock().unwrap() = None;
    }
    // Keeps the database key the engine generates, in this store's own slot (like the OS key store would).
    fn load_database_key(&self) -> Option<Vec<u8>> {
        self.1.lock().unwrap().clone()
    }
    fn save_database_key(&self, key: Vec<u8>) -> bool {
        *self.1.lock().unwrap() = Some(key);
        true
    }
}

#[derive(Default)]
struct Wire {
    to: OnceLock<Arc<PrivcordEngine>>,
    me: OnceLock<String>,
}
impl TransportCallbacks for Wire {
    fn send(&self, _peer: String, frame: String) -> bool {
        match (self.to.get(), self.me.get()) {
            (Some(to), Some(me)) => to.frame_received(me.clone(), frame).is_ok(),
            _ => false,
        }
    }
    fn send_raw(&self, _link: String, _frame: String) -> bool {
        false
    }
    fn close(&self, _peer: String) {}
    fn signal_available(&self) -> bool {
        false
    }
    fn signal_subscribe(&self, _mailbox: String) -> bool {
        false
    }
    fn signal_unsubscribe(&self, _mailbox: String) {}
    fn signal_put(
        &self,
        _mailbox: String,
        _blob: String,
        _kind: SignalKind,
        _ttl_sec: u32,
    ) -> bool {
        false
    }
}

/// A radio for the mesh test: each engine knows its neighbours by name and delivers straight into them.
#[derive(Default)]
struct MeshWire {
    name: OnceLock<String>,
    peers: Mutex<std::collections::HashMap<String, Arc<PrivcordEngine>>>,
}
impl TransportCallbacks for MeshWire {
    fn send(&self, _peer: String, _frame: String) -> bool {
        false
    }
    fn send_raw(&self, link: String, frame: String) -> bool {
        let peer = self.peers.lock().unwrap().get(&link).cloned();
        match (peer, self.name.get()) {
            (Some(p), Some(me)) => p.mesh_frame(me.clone(), frame).is_ok(),
            _ => false,
        }
    }
    fn close(&self, _peer: String) {}
    fn signal_available(&self) -> bool {
        false
    }
    fn signal_subscribe(&self, _mailbox: String) -> bool {
        false
    }
    fn signal_unsubscribe(&self, _mailbox: String) {}
    fn signal_put(
        &self,
        _mailbox: String,
        _blob: String,
        _kind: SignalKind,
        _ttl_sec: u32,
    ) -> bool {
        false
    }
}

#[derive(Default)]
struct Bell(Mutex<Vec<(String, String, String)>>);
impl NotifierCallbacks for Bell {
    fn message_received(&self, conversation: String, sender: String, preview: String) {
        self.0.lock().unwrap().push((conversation, sender, preview));
    }
}

fn start<T: TransportCallbacks + 'static>(
    dir: &std::path::Path,
    name: &str,
    keystore: Arc<FakeKeystore>,
    wire: Arc<T>,
    bell: Arc<Bell>,
) -> Arc<PrivcordEngine> {
    PrivcordEngine::start(
        dir.join(name).to_string_lossy().into_owned(),
        "duo".into(),
        keystore,
        wire,
        bell,
    )
    .unwrap()
}

#[test]
fn the_facade_runs_a_whole_conversation_with_plain_data() {
    let dir = tempfile::tempdir().unwrap();
    let (wa, wb) = (Arc::new(Wire::default()), Arc::new(Wire::default()));
    let (ka, kb) = (
        Arc::new(FakeKeystore::default()),
        Arc::new(FakeKeystore::default()),
    );
    let bell = Arc::new(Bell::default());
    let a = start(
        dir.path(),
        "a.db",
        ka.clone(),
        wa.clone(),
        Arc::new(Bell::default()),
    );
    let b = start(dir.path(), "b.db", kb, wb.clone(), bell.clone());

    let phrase = a.create_identity().unwrap();
    assert_eq!(phrase.split(' ').count(), 12);
    b.create_identity().unwrap();
    let (au, bu) = (
        a.snapshot().unwrap().own_uid.unwrap(),
        b.snapshot().unwrap().own_uid.unwrap(),
    );
    wa.to.set(b.clone()).unwrap();
    wa.me.set(au.clone()).unwrap();
    wb.to.set(a.clone()).unwrap();
    wb.me.set(bu.clone()).unwrap();

    assert_eq!(
        a.add_contact(b.own_card(Some("Bob".into())).unwrap(), true)
            .unwrap(),
        bu
    );
    assert_eq!(
        b.add_contact(a.own_card(Some("Alice".into())).unwrap(), true)
            .unwrap(),
        au
    );
    a.link_up(bu.clone(), PathKind::Bluetooth, LinkKind::Open)
        .unwrap();
    b.link_up(au.clone(), PathKind::Bluetooth, LinkKind::Open)
        .unwrap();
    let up = |e: &PrivcordEngine, who: &str| {
        for _ in 0..200 {
            if matches!(
                e.snapshot()
                    .unwrap()
                    .contacts
                    .iter()
                    .find(|c| c.uid == who)
                    .map(|c| c.link.clone()),
                Some(LinkState::Connected {
                    path: PathKind::Bluetooth
                })
            ) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        false
    };
    assert!(up(&a, &bu) && up(&b, &au));

    let id = a
        .send_message(bu.clone(), "hello over the facade".into(), None)
        .unwrap();
    for _ in 0..200 {
        let snap = a.snapshot().unwrap();
        if snap
            .conversations
            .iter()
            .flat_map(|c| &c.messages)
            .any(|m| m.id == id && m.delivery == Delivery::Delivered)
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let got = b.snapshot().unwrap();
    assert_eq!(
        got.conversations[0].messages[0].text,
        "hello over the facade"
    );
    assert_eq!(bell.0.lock().unwrap()[0].2, "hello over the facade");

    // Events come out in order and end with ShutDown.
    let mut saw_connected = false;
    while let Some(e) = a.next_event(0) {
        saw_connected |= matches!(
            e,
            EventDto::PeerStateChanged {
                link: LinkState::Connected { .. },
                ..
            }
        );
    }
    assert!(saw_connected);
    a.shutdown().unwrap();
    a.shutdown().unwrap();
    assert_eq!(a.snapshot().unwrap_err(), FfiError::ShuttingDown);
    b.shutdown().unwrap();

    // The identity lives in the platform's secure store only; a restart finds the same person.
    let again = start(
        dir.path(),
        "a.db",
        ka.clone(),
        Arc::new(Wire::default()),
        Arc::new(Bell::default()),
    );
    assert_eq!(
        again.snapshot().unwrap().own_uid.as_deref(),
        Some(au.as_str())
    );
    assert_eq!(again.snapshot().unwrap().conversations[0].messages.len(), 1);
    again.shutdown().unwrap();
    assert_eq!(ka.0.lock().unwrap().as_ref().map(Vec::len), Some(64));
}

#[test]
fn bad_input_gives_stable_codes() {
    let dir = tempfile::tempdir().unwrap();
    let e = start(
        dir.path(),
        "x.db",
        Arc::new(FakeKeystore::default()),
        Arc::new(Wire::default()),
        Arc::new(Bell::default()),
    );
    assert_eq!(e.own_card(None).unwrap_err(), FfiError::NoIdentity);
    assert_eq!(
        e.recover_identity("nonsense".into(), String::new())
            .unwrap_err(),
        FfiError::InvalidPhrase
    );
    e.create_identity().unwrap();
    assert_eq!(
        e.add_contact("nope".into(), true).unwrap_err(),
        FfiError::InvalidCard
    );
    assert_eq!(
        e.send_message("not-a-contact".into(), "hi".into(), None)
            .unwrap_err(),
        FfiError::UnknownContact
    );
    assert_eq!(
        e.send_message(String::new(), "hi".into(), None)
            .unwrap_err(),
        FfiError::InvalidArgument
    );
    // A wrong-size secret from the platform store is refused rather than trusted.
    let bad = Arc::new(FakeKeystore::default());
    *bad.0.lock().unwrap() = Some(vec![1, 2, 3]);
    assert!(PrivcordEngine::start(
        dir.path().join("y.db").to_string_lossy().into_owned(),
        "duo".into(),
        bad,
        Arc::new(Wire::default()),
        Arc::new(Bell::default())
    )
    .is_err());
    e.shutdown().unwrap();
}

#[test]
fn a_channel_message_crosses_the_mesh_over_two_hops_and_a_stranger_in_the_middle_only_relays() {
    let dir = tempfile::tempdir().unwrap();
    let mk = |name: &str| {
        let wire = Arc::new(MeshWire::default());
        wire.name.set(name.to_owned()).unwrap();
        let e = start(
            dir.path(),
            &format!("{name}.db"),
            Arc::new(FakeKeystore::default()),
            wire.clone(),
            Arc::new(Bell::default()),
        );
        e.create_identity().unwrap();
        (e, wire)
    };
    let ((a, wa), (b, wb), (c, wc)) = (mk("a"), mk("b"), mk("c"));
    wa.peers.lock().unwrap().insert("b".into(), b.clone());
    wb.peers.lock().unwrap().insert("a".into(), a.clone());
    wb.peers.lock().unwrap().insert("c".into(), c.clone());
    wc.peers.lock().unwrap().insert("b".into(), b.clone());
    // A and C joined; B never did and cannot read it, yet it must relay.
    assert_eq!(
        a.join_channel("  #General Chat ".into()).unwrap(),
        "general-chat"
    );
    c.join_channel("general-chat".into()).unwrap();
    assert_eq!(
        a.join_channel("###".into()).unwrap_err(),
        FfiError::BadChannel
    );
    assert_eq!(
        b.send_channel_message("general-chat".into(), "x".into())
            .unwrap_err(),
        FfiError::NotJoined
    );
    a.mesh_link_up("b".into()).unwrap();
    b.mesh_link_up("a".into()).unwrap();
    b.mesh_link_up("c".into()).unwrap();
    c.mesh_link_up("b".into()).unwrap();

    a.send_channel_message("general-chat".into(), "anyone near?".into())
        .unwrap();
    let mut got = None;
    for _ in 0..300 {
        let snap = c.snapshot().unwrap();
        got = snap
            .conversations
            .iter()
            .find(|v| v.id == "chan:general-chat")
            .and_then(|v| v.messages.first().cloned());
        if got.is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let got = got.expect("C received the message across two hops");
    assert_eq!(got.text, "anyone near?");
    assert_eq!(got.sender, a.snapshot().unwrap().own_uid.unwrap());
    assert!(
        b.snapshot().unwrap().conversations.is_empty(),
        "the relay stored nothing"
    );
    assert_eq!(c.snapshot().unwrap().channels, ["general-chat"]);
    for e in [a, b, c] {
        e.shutdown().unwrap();
    }
}

#[test]
fn the_on_device_self_test_passes_here_too() {
    assert_eq!(self_test(), "ok");
    assert!(!core_version().is_empty());
}

/// A key store that is there but locked: it can neither read nor write.
struct LockedKeystore;
impl SecureStoreCallbacks for LockedKeystore {
    fn load_identity(&self) -> Option<Vec<u8>> {
        None
    }
    fn save_identity(&self, _secrets: Vec<u8>) -> bool {
        false
    }
    fn delete_identity(&self) {}
    fn load_database_key(&self) -> Option<Vec<u8>> {
        None
    }
    fn save_database_key(&self, _key: Vec<u8>) -> bool {
        false
    }
}

#[test]
fn a_locked_key_store_does_not_set_the_database_aside() {
    let dir = tempfile::tempdir().unwrap();
    let keystore = Arc::new(FakeKeystore::default());
    let e = start(
        dir.path(),
        "z.db",
        keystore.clone(),
        Arc::new(Wire::default()),
        Arc::new(Bell::default()),
    );
    e.create_identity().unwrap();
    e.shutdown().unwrap();
    drop(e);
    let path = dir.path().join("z.db").to_string_lossy().into_owned();
    assert_eq!(
        PrivcordEngine::start(
            path.clone(),
            "duo".into(),
            Arc::new(LockedKeystore),
            Arc::new(Wire::default()),
            Arc::new(Bell::default())
        )
        .unwrap_err(),
        FfiError::SecureStorage
    );
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        assert!(!name.contains(".unreadable-"), "{name} was set aside");
    }
    // Once the store is unlocked again, the same database opens with its own key.
    let e = PrivcordEngine::start(
        path,
        "duo".into(),
        keystore,
        Arc::new(Wire::default()),
        Arc::new(Bell::default()),
    )
    .unwrap();
    assert!(e.own_card(None).is_ok());
    e.shutdown().unwrap();
}
