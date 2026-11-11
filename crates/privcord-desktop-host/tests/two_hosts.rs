//! Two hosted engines, driven only through the JSON interface the desktop page uses, pair up, connect over an in-memory
//! "link" and exchange a message. This is the desktop's M7 seam tested without Tauri, a webview or a radio.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_desktop_host::DesktopHost;
use privcord_ffi::{NotifierCallbacks, SecureStoreCallbacks, SignalKind, TransportCallbacks};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Keys(Mutex<Option<Vec<u8>>>);
impl SecureStoreCallbacks for Keys {
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

/// What the page would carry to the other side: frames the engine wants sent, as (peer, frame).
#[derive(Default)]
struct Wire(Mutex<Vec<(String, String)>>);
impl TransportCallbacks for Wire {
    fn send(&self, peer: String, frame: String) -> bool {
        self.0.lock().unwrap().push((peer, frame));
        true
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
    fn signal_put(&self, _m: String, _b: String, _k: SignalKind, _t: u32) -> bool {
        false
    }
}

struct Quiet;
impl NotifierCallbacks for Quiet {
    fn message_received(&self, _c: String, _s: String, _p: String) {}
}

struct Side {
    host: DesktopHost,
    wire: Arc<Wire>,
    _dir: tempfile::TempDir,
}

fn side() -> Side {
    let dir = tempfile::tempdir().unwrap();
    let wire = Arc::new(Wire::default());
    let host = DesktopHost::start(
        dir.path().join("engine.db").to_str().unwrap(),
        "duo",
        Arc::new(Keys::default()),
        wire.clone(),
        Arc::new(Quiet),
    )
    .unwrap();
    Side {
        host,
        wire,
        _dir: dir,
    }
}

/// Carry every queued frame to the other side until both are quiet (the page's job).
fn pump(a: &Side, a_uid: &str, b: &Side, b_uid: &str) {
    for _ in 0..50 {
        let from_a: Vec<_> = std::mem::take(&mut *a.wire.0.lock().unwrap());
        let from_b: Vec<_> = std::mem::take(&mut *b.wire.0.lock().unwrap());
        if from_a.is_empty() && from_b.is_empty() {
            return;
        }
        for (_, frame) in from_a {
            b.host
                .invoke("frame_received", &json!({ "peer": a_uid, "frame": frame }))
                .unwrap();
        }
        for (_, frame) in from_b {
            a.host
                .invoke("frame_received", &json!({ "peer": b_uid, "frame": frame }))
                .unwrap();
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

fn snapshot_text(s: &Side) -> String {
    s.host.invoke("snapshot", &json!({})).unwrap().to_string()
}

/// Two engines, paired as verified friends, with their link up (the handshake already carried across).
fn paired() -> (Side, Side, String, String) {
    let (a, b) = (side(), side());
    assert!(a
        .host
        .invoke("create_identity", &json!({}))
        .unwrap()
        .as_str()
        .is_some_and(|words| words.split(' ').count() == 12));
    b.host.invoke("create_identity", &json!({})).unwrap();

    let card_a = a
        .host
        .invoke("own_card", &json!({ "name": "Ann" }))
        .unwrap();
    let card_b = b
        .host
        .invoke("own_card", &json!({ "name": "Bob" }))
        .unwrap();
    let b_uid = a
        .host
        .invoke("add_contact", &json!({ "card": card_b, "verified": true }))
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let a_uid = b
        .host
        .invoke("add_contact", &json!({ "card": card_a, "verified": true }))
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(a_uid, b_uid);

    // The page reports each WebRTC link opening; the engine then runs its handshake through the wire.
    for (side, peer) in [(&a, &b_uid), (&b, &a_uid)] {
        side.host
            .invoke(
                "link_up",
                &json!({ "peer": peer, "path": "direct_lan", "kind": "encrypted" }),
            )
            .unwrap();
    }
    pump(&a, &a_uid, &b, &b_uid);
    assert!(
        snapshot_text(&a).contains("Connected") && snapshot_text(&b).contains("Connected"),
        "both sides should consider the link up"
    );

    (a, b, a_uid, b_uid)
}

#[test]
fn two_hosted_engines_pair_connect_and_exchange_a_message_through_json() {
    let (a, b, a_uid, b_uid) = paired();
    let id = a
        .host
        .invoke(
            "send_message",
            &json!({ "peer": b_uid, "text": "hello from the hosted engine" }),
        )
        .unwrap();
    assert!(id.is_string());
    pump(&a, &a_uid, &b, &b_uid);
    assert!(snapshot_text(&b).contains("hello from the hosted engine"));

    // `WRITE_FIXTURE=1 cargo test -p privcord-desktop-host` refreshes the real snapshot the page's TypeScript tests read.
    if std::env::var_os("WRITE_FIXTURE").is_some() {
        let snapshot = b.host.invoke("snapshot", &json!({})).unwrap();
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/desktop/src/lib/hosted/fixtures/snapshot.json"
        );
        std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_string_pretty(&snapshot).unwrap()).unwrap();
    }

    // Bob's side told the page about it.
    let mut saw_message = false;
    while let Some(event) = b.host.next_event(200) {
        saw_message |= event.to_string().contains("MessageAdded");
    }
    assert!(saw_message, "an engine event should have reached the page");

    a.host.shutdown();
    b.host.shutdown();
}

#[test]
fn unknown_commands_and_bad_arguments_are_errors_not_silence() {
    let a = side();
    assert!(a.host.invoke("no_such_command", &json!({})).is_err());
    assert!(a
        .host
        .invoke("send_message", &json!({ "peer": 7 }))
        .is_err());
    assert!(a
        .host
        .invoke(
            "link_up",
            &json!({ "peer": "x", "path": "wormhole", "kind": "encrypted" })
        )
        .is_err());
    let _: Value = a.host.invoke("snapshot", &json!({})).unwrap();
    a.host.shutdown();
}

#[test]
fn files_search_and_group_commands_work_through_json() {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let (a, b, a_uid, b_uid) = paired();

    // A file goes across as base64 and comes back byte for byte.
    let bytes: Vec<u8> = (0..30_000u32).map(|i| (i % 251) as u8).collect();
    let id = a
        .host
        .invoke(
            "send_file",
            &json!({ "peer": b_uid, "name": "data.bin", "mime": "application/octet-stream", "data": B64.encode(&bytes) }),
        )
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    pump(&a, &a_uid, &b, &b_uid);
    // B sees the file message and can read it.
    let snapshot = b.host.invoke("snapshot", &json!({})).unwrap();
    let file_id = snapshot["conversations"][0]["messages"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(file_id, id);
    let loaded = b
        .host
        .invoke("load_file", &json!({ "message_id": file_id }))
        .unwrap();
    assert_eq!(B64.decode(loaded["data"].as_str().unwrap()).unwrap(), bytes);

    // Search finds a text message.
    a.host
        .invoke(
            "send_message",
            &json!({ "peer": b_uid, "text": "pineapple pizza" }),
        )
        .unwrap();
    pump(&a, &a_uid, &b, &b_uid);
    let hits = b
        .host
        .invoke("search", &json!({ "query": "pineapple" }))
        .unwrap();
    assert_eq!(hits.as_array().unwrap().len(), 1);

    // A group can be made with the friend; the page asks only through commands.
    let group = a
        .host
        .invoke(
            "create_group",
            &json!({ "name": "Trip", "members": [b_uid] }),
        )
        .unwrap();
    assert!(group.is_string());
    assert!(a.host.invoke("snapshot", &json!({})).unwrap()["groups"][0]["name"] == "Trip");
}
