//! The desktop shell's own relay sockets against the real relay (`relay/server.js`, run by Node): a blob put by one
//! install reaches another that listens on the mailbox, including one put while the listener was not there yet (stored
//! on the relay). Needs Node and the relay's packages; set `PRIVCORD_SKIP_REAL_RELAY=1` to skip it where they are not
//! installed.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use privcord_crypto::{identity::Identity, rng::SeededEntropy, seal::seal};
use privcord_desktop_host::native_signaling::NativeSignaling;
use privcord_domain::signaling::PutKind;
use serde_json::json;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

fn start_relay() -> Option<(Server, u16)> {
    if std::env::var("PRIVCORD_SKIP_REAL_RELAY").is_ok_and(|v| !v.is_empty()) {
        return None;
    }
    let script = format!(
        "{}/../privcord-engine/tests/support/real_relay.mjs",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut child = Command::new("node")
        .arg(script)
        .stdout(Stdio::piped())
        .spawn()
        .expect("node is needed for this test (or set PRIVCORD_SKIP_REAL_RELAY=1)");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let port = line
        .trim()
        .strip_prefix("PORT ")
        .expect("the relay printed its port")
        .parse()
        .unwrap();
    Some((Server(child), port))
}

type Inbox = Arc<Mutex<Vec<(String, String)>>>;

fn install(port: u16) -> (NativeSignaling, Inbox) {
    let inbox: Inbox = Arc::default();
    let sink = inbox.clone();
    let s = NativeSignaling::start(
        Arc::new(move |mailbox, blob| sink.lock().unwrap().push((mailbox, blob))),
        Arc::new(|_| {}),
    );
    s.configure(
        &json!({ "signaling": [{ "kind": "relay", "url": format!("ws://127.0.0.1:{port}") }] })
            .to_string(),
        None,
    );
    (s, inbox)
}

fn wait(what: &str, mut ok: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !ok() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn blobs_cross_between_two_installs_through_the_real_relay() {
    let Some((_server, port)) = start_relay() else {
        return;
    };
    let mut rng = SeededEntropy::new("native-signaling");
    let (ann, bob) = (
        Identity::generate(&mut rng).unwrap(),
        Identity::generate(&mut rng).unwrap(),
    );
    let blob = |n: &str, rng: &mut SeededEntropy| {
        seal(
            &ann,
            &bob.uid().unwrap(),
            &bob.dh_public(),
            &json!({ "n": n }),
            rng,
        )
        .unwrap()
        .encode()
    };

    let (sender, _) = install(port);
    sender.subscribe("sender-own");
    wait("the sender to be online", || sender.online());

    // Put while nobody listens: the relay keeps it.
    let early = blob("early", &mut rng);
    assert!(sender.put("bob-box", &early, PutKind::Msg, 3600));
    std::thread::sleep(Duration::from_millis(300));

    let (listener, inbox) = install(port);
    listener.subscribe("bob-box");
    wait("the stored blob", || {
        inbox
            .lock()
            .unwrap()
            .iter()
            .any(|(m, b)| m == "bob-box" && b == &early)
    });

    // And one put while it listens.
    let live = blob("live", &mut rng);
    assert!(sender.put("bob-box", &live, PutKind::Msg, 3600));
    wait("the live blob", || {
        inbox.lock().unwrap().iter().any(|(_, b)| b == &live)
    });

    // Unsubscribed: nothing more arrives for that mailbox.
    listener.unsubscribe("bob-box");
    std::thread::sleep(Duration::from_millis(200));
    let before = inbox.lock().unwrap().len();
    assert!(sender.put("bob-box", &blob("after", &mut rng), PutKind::Msg, 3600));
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(inbox.lock().unwrap().len(), before);
}

#[test]
fn with_no_relay_configured_it_stays_offline_and_refuses_puts() {
    let s = NativeSignaling::start(Arc::new(|_, _| {}), Arc::new(|_| {}));
    s.configure(&json!({ "signaling": [] }).to_string(), None);
    s.subscribe("m");
    std::thread::sleep(Duration::from_millis(200));
    assert!(!s.online());
    assert!(!s.put("m", "x", PutKind::Msg, 60));
}
