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
struct FakeKeystore(Mutex<Option<Vec<u8>>>);
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
}

#[derive(Default)]
struct Bell(Mutex<Vec<(String, String, String)>>);
impl NotifierCallbacks for Bell {
    fn message_received(&self, conversation: String, sender: String, preview: String) {
        self.0.lock().unwrap().push((conversation, sender, preview));
    }
}

fn start(
    dir: &std::path::Path,
    name: &str,
    keystore: Arc<FakeKeystore>,
    wire: Arc<Wire>,
    bell: Arc<Bell>,
) -> Arc<PrivcordEngine> {
    PrivcordEngine::start(
        dir.join(name).to_string_lossy().into_owned(),
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
    a.link_up(bu.clone(), PathKind::Bluetooth).unwrap();
    b.link_up(au.clone(), PathKind::Bluetooth).unwrap();
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
        bad,
        Arc::new(Wire::default()),
        Arc::new(Bell::default())
    )
    .is_err());
    e.shutdown().unwrap();
}
