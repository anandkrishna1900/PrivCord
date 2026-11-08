//! The Nostr client against a real, independent Nostr relay (the Python `nostr-relay` package, which verifies the BIP-340
//! signature on every event and the event's age), so the event format and the signing are checked by someone else's
//! code. Needs `nostr-relay` (`pip install nostr-relay`). Set `PRIVCORD_NOSTR_RELAY` to its executable (default: found on
//! PATH); the test is skipped if `PRIVCORD_SKIP_REAL_NOSTR` is set, and fails if the relay cannot be started otherwise.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::{
    identity::Identity,
    rng::SeededEntropy,
    seal::{mailbox_for, seal},
};
use privcord_domain::signaling::PutKind;
use privcord_engine::signaling::{
    hub::{Service, SignalingHub},
    nostr::NostrTransport,
    Action, Event, Out, PutRequest,
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader},
    net::TcpStream,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tungstenite::{stream::MaybeTlsStream, Message, WebSocket};

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

fn start_relay() -> Option<(Server, u16, tempfile::TempDir)> {
    if std::env::var("PRIVCORD_SKIP_REAL_NOSTR").is_ok_and(|v| !v.is_empty()) {
        return None;
    }
    let bin = std::env::var("PRIVCORD_NOSTR_RELAY").unwrap_or_else(|_| "nostr-relay".to_owned());
    let dir = tempfile::tempdir().unwrap();
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let cfg = dir.path().join("cfg.yaml");
    std::fs::write(
        &cfg,
        format!(
            "relay_name: test\nstorage:\n  sqlalchemy.url: sqlite+aiosqlite:///{}/n.sqlite3\n  num_concurrent_reqs: 10\n  num_concurrent_adds: 2\n  validators:\n    - nostr_relay.validators.is_not_too_large\n    - nostr_relay.validators.is_signed\n    - nostr_relay.validators.is_recent\ngunicorn:\n  bind: 127.0.0.1:{port}\n  workers: 1\n  loglevel: warning\nauthentication:\n  enabled: false\n",
            dir.path().display()
        ),
    )
    .unwrap();
    let child = Command::new(bin)
        .args(["-c", cfg.to_str().unwrap(), "serve"])
        .env("HOME", dir.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("nostr-relay is needed for this test (or set PRIVCORD_SKIP_REAL_NOSTR=1)");
    let server = Server(child);
    for _ in 0..100 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Some((server, port, dir));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("the relay did not start");
}

/// Carries out a hub's socket actions over real WebSockets.
struct Driver {
    hub: SignalingHub,
    sockets: BTreeMap<String, WebSocket<MaybeTlsStream<TcpStream>>>,
    events: Vec<Event>,
    start: Instant,
}

impl Driver {
    fn new(url: &str) -> Self {
        Self {
            hub: SignalingHub::new(vec![Service::Nostr(NostrTransport::new(
                &[url.to_owned()],
                "real-nostr",
            ))]),
            sockets: BTreeMap::new(),
            events: Vec::new(),
            start: Instant::now(),
        }
    }
    fn now(&self) -> i64 {
        // Nostr events carry real Unix seconds, and the relay checks their age.
        let _ = self.start;
        i64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap()
    }
    fn apply(&mut self, out: Out) {
        let mut pending = vec![out];
        while let Some(out) = pending.pop() {
            self.events.extend(out.events);
            for a in out.actions {
                match a {
                    Action::Connect { url } => {
                        let (ws, _) =
                            tungstenite::connect(&url).expect("the relay accepts a connection");
                        if let MaybeTlsStream::Plain(s) = ws.get_ref() {
                            s.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
                        }
                        self.sockets.insert(url.clone(), ws);
                        let now = self.now();
                        pending.push(self.hub.socket_opened(&url, now));
                    }
                    Action::Send { url, text } => {
                        self.sockets
                            .get_mut(&url)
                            .unwrap()
                            .send(Message::text(text))
                            .unwrap();
                    }
                    Action::Close { url } => {
                        if let Some(mut s) = self.sockets.remove(&url) {
                            let _ = s.close(None);
                        }
                    }
                }
            }
        }
    }
    /// Read whatever the relay has sent, for up to `ms`.
    fn pump(&mut self, ms: u64) {
        let until = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < until {
            let urls: Vec<String> = self.sockets.keys().cloned().collect();
            for url in urls {
                let read = self.sockets.get_mut(&url).unwrap().read();
                match read {
                    Ok(Message::Text(t)) => {
                        let now = self.now();
                        let out = self.hub.socket_message(&url, t.as_str(), now);
                        self.apply(out);
                    }
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(e))
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) => {}
                    Err(_) => {
                        self.sockets.remove(&url);
                        let now = self.now();
                        let out = self.hub.socket_closed(&url, now);
                        self.apply(out);
                    }
                }
            }
            let now = self.now();
            let out = self.hub.tick(now);
            self.apply(out);
        }
    }
}

#[test]
fn the_client_talks_to_a_real_nostr_relay_live_stored_and_refused() {
    let Some((_server, port, _dir)) = start_relay() else {
        return;
    };
    let url = format!("ws://127.0.0.1:{port}");
    let mut rng = SeededEntropy::new("real-relay");
    let (ann, bob) = (
        Identity::generate(&mut rng).unwrap(),
        Identity::generate(&mut rng).unwrap(),
    );
    let seal_to = |n: &str, rng: &mut SeededEntropy| {
        seal(
            &ann,
            &bob.uid().unwrap(),
            &bob.dh_public(),
            &json!({ "n": n }),
            rng,
        )
        .unwrap()
    };
    let mailbox = mailbox_for(bob.uid().unwrap().as_str());
    let (live, stored) = (seal_to("live", &mut rng), seal_to("stored", &mut rng));

    let mut alice = Driver::new(&url);
    let out = alice.hub.start("alice-mailbox");
    alice.apply(out);
    alice.pump(200);
    // A stored message (kind "msg") is kept by the relay (this relay allows it) until a listener comes.
    let now = alice.now();
    let out = alice
        .hub
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &stored,
                kind: PutKind::Msg,
                ttl_sec: 3600,
                put_id: "put-stored",
            },
            now,
            &mut rng,
        )
        .unwrap();
    alice.apply(out);
    alice.pump(200);
    assert!(
        alice
            .events
            .iter()
            .any(|e| matches!(e, Event::PutOk { put_id } if put_id == "put-stored")),
        "the relay acknowledged the put: {:?}",
        alice.events
    );

    let mut bobd = Driver::new(&url);
    let out = bobd.hub.start(&mailbox);
    bobd.apply(out);
    bobd.pump(400);
    let blobs = |d: &Driver| {
        d.events
            .iter()
            .filter_map(|e| match e {
                Event::Blob { blob, .. } => Some((**blob).clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        blobs(&bobd),
        std::slice::from_ref(&stored),
        "the stored blob was handed over on subscribe"
    );

    // A live blob (kind "sig") reaches a listener who is online right now.
    let now = alice.now();
    let out = alice
        .hub
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &live,
                kind: PutKind::Sig,
                ttl_sec: 120,
                put_id: "put-live",
            },
            now,
            &mut rng,
        )
        .unwrap();
    alice.apply(out);
    alice.pump(100);
    bobd.pump(400);
    assert_eq!(
        blobs(&bobd),
        [stored, live],
        "stored first, then the live one"
    );

    // The relay checks signatures: one of our events is accepted, the same event with a damaged signature is refused.
    // (An oversize blob is not tested: the size limit is relay policy, and public relays differ.)
    let good = privcord_crypto::nostr::make_event(
        &mailbox,
        &seal_to("raw", &mut rng),
        PutKind::Sig,
        120,
        alice.now() / 1000,
        &mut rng,
    )
    .unwrap();
    let mut bad = good.clone();
    bad.sig = format!(
        "{}{}",
        &good.sig[..good.sig.len() - 1],
        if good.sig.ends_with('0') { '1' } else { '0' }
    );
    let (mut raw, _) = tungstenite::connect(&url).unwrap();
    if let MaybeTlsStream::Plain(s) = raw.get_ref() {
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    }
    let mut verdict = |e: &privcord_crypto::nostr::NostrEvent| -> bool {
        raw.send(Message::text(privcord_crypto::nostr::event_frame(e)))
            .unwrap();
        // A refusal is an OK with `false` or a NOTICE; silence for 5 s counts as refused too.
        loop {
            let Ok(Message::Text(t)) = raw.read() else {
                return false;
            };
            let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
            if v[0] == "OK" && v[1] == e.id.as_str() {
                return v[2] == true;
            }
            if v[0] == "NOTICE" {
                return false;
            }
        }
    };
    assert!(verdict(&good), "the relay accepted a validly signed event");
    assert!(!verdict(&bad), "the relay refused a damaged signature");
}
