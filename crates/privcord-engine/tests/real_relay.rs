//! The relay client against the real relay (`relay/server.js`, run by Node), so the wire protocol is checked against the
//! server the apps actually use, not against a copy of it. Needs Node and the relay's `ws` package (`npm ci`). Set
//! `PRIVCORD_SKIP_REAL_RELAY=1` to skip it where they are not installed.
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
    relay::RelayClient,
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

fn start_relay() -> Option<(Server, u16)> {
    if std::env::var("PRIVCORD_SKIP_REAL_RELAY").is_ok_and(|v| !v.is_empty()) {
        return None;
    }
    let script = format!(
        "{}/tests/support/real_relay.mjs",
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
    let port: u16 = line
        .trim()
        .strip_prefix("PORT ")
        .expect("the relay printed its port")
        .parse()
        .unwrap();
    Some((Server(child), port))
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
            hub: SignalingHub::new(vec![Service::Relay(RelayClient::new(url))]),
            sockets: BTreeMap::new(),
            events: Vec::new(),
            start: Instant::now(),
        }
    }
    fn now(&self) -> i64 {
        i64::try_from(self.start.elapsed().as_millis()).unwrap()
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
fn the_client_talks_to_the_real_relay_live_stored_and_refused() {
    let Some((_server, port)) = start_relay() else {
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

    // The relay refuses what it should: an oversize blob gets an error, not an ack.
    let mut big = seal_to("big", &mut rng);
    big.ct = "A".repeat(70_000);
    let now = alice.now();
    let out = alice
        .hub
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &big,
                kind: PutKind::Sig,
                ttl_sec: 120,
                put_id: "put-big",
            },
            now,
            &mut rng,
        )
        .unwrap();
    alice.apply(out);
    alice.pump(300);
    assert!(
        alice
            .events
            .iter()
            .any(|e| matches!(e, Event::PutFailed { put_id, .. } if put_id == "put-big")),
        "{:?}",
        alice.events
    );
}
