//! The signaling clients (relay, Nostr, hub) driven the way an adapter drives them, against small fake servers that speak
//! the real wire protocols.
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
use privcord_domain::{blob::SealedBlob, signaling::PutKind};
use privcord_engine::signaling::{
    hub::{Service, SignalingHub},
    nostr::NostrTransport,
    relay::RelayClient,
    Action, Event, Out, PutRequest, SignalingStatus,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn blob_for(seed: &str, to: &Identity) -> (SealedBlob, String) {
    let mut rng = SeededEntropy::new(seed);
    let from = Identity::generate(&mut rng).unwrap();
    let b = seal(
        &from,
        &to.uid().unwrap(),
        &to.dh_public(),
        &json!({ "t": seed }),
        &mut rng,
    )
    .unwrap();
    (b, mailbox_for(to.uid().unwrap().as_str()))
}

/// A relay that behaves like `relay/server.js` for the frames the client uses.
#[derive(Default)]
struct FakeRelay {
    subs: Vec<(String, String)>,                // (client key, mailbox)
    stored: Vec<(String, String, String, i64)>, // (mailbox, id, blob, ts)
    answer: bool,
    clock: i64,
}

impl FakeRelay {
    fn handle(&mut self, who: &str, text: &str) -> Vec<(String, String)> {
        let v: Value = serde_json::from_str(text).unwrap();
        let mut out = Vec::new();
        match v["op"].as_str().unwrap() {
            "sub" => {
                let mb = v["mailbox"].as_str().unwrap().to_owned();
                let since = v["since"].as_i64().unwrap();
                for (m, id, blob, ts) in &self.stored {
                    if *m == mb && *ts > since {
                        out.push((
                            who.to_owned(),
                            json!({ "op": "event", "id": id, "blob": blob, "ts": ts }).to_string(),
                        ));
                    }
                }
                self.subs.push((who.to_owned(), mb));
            }
            "put" => {
                let (mb, id, blob) = (
                    v["mailbox"].as_str().unwrap(),
                    v["id"].as_str().unwrap(),
                    v["blob"].as_str().unwrap(),
                );
                self.clock += 1;
                if v["kind"] == "msg" {
                    self.stored
                        .push((mb.to_owned(), id.to_owned(), blob.to_owned(), self.clock));
                }
                for (client, m) in &self.subs {
                    if m == mb {
                        out.push((
                            client.clone(),
                            json!({ "op": "event", "id": id, "blob": blob, "ts": self.clock })
                                .to_string(),
                        ));
                    }
                }
                if self.answer {
                    out.push((who.to_owned(), json!({ "op": "ok", "id": id }).to_string()));
                }
            }
            "del" => {
                let (mb, id) = (v["mailbox"].as_str().unwrap(), v["id"].as_str().unwrap());
                self.stored.retain(|(m, i, _, _)| !(m == mb && i == id));
            }
            _ => {}
        }
        out
    }
    fn disconnect(&mut self, who: &str) {
        self.subs.retain(|(c, _)| c != who);
    }
}

/// A Nostr relay: remembers subscriptions and forwards events to subscribers.
#[derive(Default)]
struct FakeNostr {
    subs: Vec<(String, String, Value)>, // (client, subId, filter)
}
impl FakeNostr {
    fn handle(&mut self, who: &str, text: &str) -> Vec<(String, String)> {
        let v: Value = serde_json::from_str(text).unwrap();
        match v[0].as_str().unwrap() {
            "REQ" => {
                self.subs.push((
                    who.to_owned(),
                    v[1].as_str().unwrap().to_owned(),
                    v[2].clone(),
                ));
                Vec::new()
            }
            "EVENT" => {
                let ev = &v[1];
                self.subs
                    .iter()
                    .filter(|(_, _, f)| {
                        ev["tags"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|t| t[0] == "t" && f["#t"][0] == t[1])
                    })
                    .map(|(c, sub, _)| (c.clone(), json!(["EVENT", sub, ev]).to_string()))
                    .collect()
            }
            _ => Vec::new(),
        }
    }
}

/// Executes actions for several hubs, in the order they come, until quiet.
struct World {
    relay: FakeRelay,
    nostr: FakeNostr,
    hubs: BTreeMap<String, SignalingHub>,
    events: BTreeMap<String, Vec<Event>>,
    sent: Vec<(String, Action)>,
    now: i64,
    down: Vec<String>, // urls that refuse to connect
}

impl World {
    fn new() -> Self {
        Self {
            relay: FakeRelay {
                answer: true,
                ..Default::default()
            },
            nostr: FakeNostr::default(),
            hubs: BTreeMap::new(),
            events: BTreeMap::new(),
            sent: Vec::new(),
            now: 1_700_000_000_000,
            down: vec![],
        }
    }

    fn run(&mut self, who: &str, out: Out) {
        let mut queue = vec![(who.to_owned(), out)];
        while let Some((who, out)) = queue.pop() {
            self.events
                .entry(who.clone())
                .or_default()
                .extend(out.events);
            for action in out.actions {
                self.sent.push((who.clone(), action.clone()));
                let hub_now = self.now;
                match action {
                    Action::Connect { url } => {
                        let next = if self.down.contains(&url) {
                            self.hubs
                                .get_mut(&who)
                                .unwrap()
                                .socket_closed(&url, hub_now)
                        } else {
                            self.hubs
                                .get_mut(&who)
                                .unwrap()
                                .socket_opened(&url, hub_now)
                        };
                        queue.push((who.clone(), next));
                    }
                    Action::Send { url, text } => {
                        let replies = if url.starts_with("ws://relay") {
                            self.relay.handle(&who, &text)
                        } else {
                            self.nostr.handle(&who, &text)
                        };
                        for (to, frame) in replies {
                            if let Some(h) = self.hubs.get_mut(&to) {
                                let n = h.socket_message(&url, &frame, hub_now);
                                queue.push((to, n));
                            }
                        }
                    }
                    Action::Close { url } => {
                        if url.starts_with("ws://relay") {
                            self.relay.disconnect(&who);
                        }
                    }
                }
            }
        }
    }

    fn blobs(&self, who: &str) -> Vec<SealedBlob> {
        self.events
            .get(who)
            .into_iter()
            .flatten()
            .filter_map(|e| match e {
                Event::Blob { blob, .. } => Some((**blob).clone()),
                _ => None,
            })
            .collect()
    }
    fn puts(&self, who: &str) -> Vec<(String, bool)> {
        self.events
            .get(who)
            .into_iter()
            .flatten()
            .filter_map(|e| match e {
                Event::PutOk { put_id } => Some((put_id.clone(), true)),
                Event::PutFailed { put_id, .. } => Some((put_id.clone(), false)),
                Event::Blob { .. } => None,
            })
            .collect()
    }
}

fn relay_hub() -> SignalingHub {
    SignalingHub::new(vec![Service::Relay(RelayClient::new("ws://relay.test"))])
}

#[test]
fn a_blob_goes_through_a_relay_to_the_listener_and_the_put_is_acknowledged() {
    let mut w = World::new();
    let mut rng = SeededEntropy::new("hub");
    let bob = Identity::generate(&mut rng).unwrap();
    let (blob, mailbox) = blob_for("hello", &bob);
    w.hubs.insert("alice".into(), relay_hub());
    w.hubs.insert("bob".into(), relay_hub());
    let o = w.hubs.get_mut("bob").unwrap().start(&mailbox);
    w.run("bob", o);
    let o = w.hubs.get_mut("alice").unwrap().start("alice-box");
    w.run("alice", o);
    assert_eq!(w.hubs["bob"].status(), SignalingStatus::Online);
    let o = w
        .hubs
        .get_mut("alice")
        .unwrap()
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &blob,
                kind: PutKind::Sig,
                ttl_sec: 120,
                put_id: "p1",
            },
            w.now,
            &mut rng,
        )
        .unwrap();
    w.run("alice", o);
    assert_eq!(w.puts("alice"), [("p1".to_owned(), true)]);
    assert_eq!(w.blobs("bob"), std::slice::from_ref(&blob));
    // The same blob again (a republish) is not delivered twice.
    let o = w
        .hubs
        .get_mut("alice")
        .unwrap()
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &blob,
                kind: PutKind::Sig,
                ttl_sec: 120,
                put_id: "p2",
            },
            w.now,
            &mut rng,
        )
        .unwrap();
    w.run("alice", o);
    assert_eq!(w.blobs("bob").len(), 1);
}

#[test]
fn a_stored_blob_waits_for_a_listener_who_arrives_later_and_a_reconnect_asks_only_for_newer() {
    let mut w = World::new();
    let mut rng = SeededEntropy::new("stored");
    let bob = Identity::generate(&mut rng).unwrap();
    let (b1, mailbox) = blob_for("one", &bob);
    let (b2, _) = blob_for("two", &bob);
    w.hubs.insert("alice".into(), relay_hub());
    w.hubs.insert("bob".into(), relay_hub());
    let o = w.hubs.get_mut("alice").unwrap().start("alice-box");
    w.run("alice", o);
    let o = w
        .hubs
        .get_mut("alice")
        .unwrap()
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &b1,
                kind: PutKind::Msg,
                ttl_sec: 3600,
                put_id: "p1",
            },
            w.now,
            &mut rng,
        )
        .unwrap();
    w.run("alice", o);
    // Bob comes online afterwards and is given what was stored.
    let o = w.hubs.get_mut("bob").unwrap().start(&mailbox);
    w.run("bob", o);
    assert_eq!(w.blobs("bob"), std::slice::from_ref(&b1));
    // Bob's socket drops; the client waits (1 s), reconnects, and asks only for what is newer than it has seen.
    w.relay.disconnect("bob");
    let o = w
        .hubs
        .get_mut("bob")
        .unwrap()
        .socket_closed("ws://relay.test", w.now);
    w.run("bob", o);
    assert_eq!(w.hubs["bob"].status(), SignalingStatus::Error);
    w.now += 999;
    let o = w.hubs.get_mut("bob").unwrap().tick(w.now);
    assert!(o.actions.is_empty(), "not yet");
    w.now += 2;
    let o = w.hubs.get_mut("bob").unwrap().tick(w.now);
    w.run("bob", o);
    assert_eq!(w.hubs["bob"].status(), SignalingStatus::Online);
    assert_eq!(w.blobs("bob").len(), 1, "the old one is not sent again");
    let o = w
        .hubs
        .get_mut("alice")
        .unwrap()
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &b2,
                kind: PutKind::Msg,
                ttl_sec: 3600,
                put_id: "p2",
            },
            w.now,
            &mut rng,
        )
        .unwrap();
    w.run("alice", o);
    assert_eq!(w.blobs("bob"), [b1, b2]);
    // The backoff doubles on repeated failures and stops at 30 seconds.
    w.down.push("ws://relay.test".into());
    let mut waits = Vec::new();
    let o = w
        .hubs
        .get_mut("bob")
        .unwrap()
        .socket_closed("ws://relay.test", w.now);
    w.run("bob", o);
    for _ in 0..8 {
        let start = w.now;
        loop {
            w.now += 500;
            let o = w.hubs.get_mut("bob").unwrap().tick(w.now);
            if !o.actions.is_empty() {
                w.run("bob", o);
                break;
            }
        }
        waits.push(w.now - start);
    }
    assert_eq!(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
}

#[test]
fn puts_fail_when_not_connected_or_unanswered_and_stop_closes_everything() {
    let mut w = World::new();
    let mut rng = SeededEntropy::new("fail");
    let bob = Identity::generate(&mut rng).unwrap();
    let (blob, mailbox) = blob_for("x", &bob);
    w.hubs.insert("alice".into(), relay_hub());
    // Not started: refused at once.
    let o = w
        .hubs
        .get_mut("alice")
        .unwrap()
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &blob,
                kind: PutKind::Sig,
                ttl_sec: 120,
                put_id: "p0",
            },
            w.now,
            &mut rng,
        )
        .unwrap();
    w.run("alice", o);
    assert_eq!(w.puts("alice"), [("p0".to_owned(), false)]);
    // Connected but the relay never answers: failed after 8 seconds, not before.
    w.relay.answer = false;
    let o = w.hubs.get_mut("alice").unwrap().start("alice-box");
    w.run("alice", o);
    let o = w
        .hubs
        .get_mut("alice")
        .unwrap()
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &blob,
                kind: PutKind::Sig,
                ttl_sec: 120,
                put_id: "p1",
            },
            w.now,
            &mut rng,
        )
        .unwrap();
    w.run("alice", o);
    w.now += 7_999;
    let o = w.hubs.get_mut("alice").unwrap().tick(w.now);
    w.run("alice", o);
    assert_eq!(w.puts("alice").len(), 1);
    w.now += 2;
    let o = w.hubs.get_mut("alice").unwrap().tick(w.now);
    w.run("alice", o);
    assert_eq!(w.puts("alice")[1], ("p1".to_owned(), false));
    // A drop fails what is waiting; stop closes the socket and the status is idle.
    let o = w
        .hubs
        .get_mut("alice")
        .unwrap()
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &blob,
                kind: PutKind::Sig,
                ttl_sec: 120,
                put_id: "p2",
            },
            w.now,
            &mut rng,
        )
        .unwrap();
    w.run("alice", o);
    let o = w
        .hubs
        .get_mut("alice")
        .unwrap()
        .socket_closed("ws://relay.test", w.now);
    w.run("alice", o);
    assert_eq!(w.puts("alice")[2], ("p2".to_owned(), false));
    let o = w.hubs.get_mut("alice").unwrap().stop();
    w.run("alice", o);
    assert_eq!(w.hubs["alice"].status(), SignalingStatus::Idle);
    // Nothing configured at all.
    let mut empty = SignalingHub::new(vec![]);
    assert!(!empty.enabled());
    let o = empty
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &blob,
                kind: PutKind::Sig,
                ttl_sec: 1,
                put_id: "p",
            },
            0,
            &mut rng,
        )
        .unwrap();
    assert!(
        matches!(&o.events[0], Event::PutFailed { reason, .. } if reason == "No signaling is configured.")
    );
}

fn nostr_hub(urls: &[&str]) -> SignalingHub {
    let urls: Vec<String> = urls.iter().map(|u| (*u).to_owned()).collect();
    SignalingHub::new(vec![Service::Nostr(NostrTransport::new(&urls, "sub-1"))])
}

#[test]
fn nostr_delivers_signed_events_and_drops_everything_else() {
    let mut w = World::new();
    let mut rng = SeededEntropy::new("nostr");
    let bob = Identity::generate(&mut rng).unwrap();
    let (blob, mailbox) = blob_for("via nostr", &bob);
    w.hubs.insert(
        "alice".into(),
        nostr_hub(&["wss://nostr-a.test", "wss://nostr-b.test"]),
    );
    w.hubs.insert(
        "bob".into(),
        nostr_hub(&["wss://nostr-a.test", "wss://nostr-b.test"]),
    );
    let o = w.hubs.get_mut("bob").unwrap().start(&mailbox);
    w.run("bob", o);
    let o = w.hubs.get_mut("alice").unwrap().start("alice-box");
    w.run("alice", o);
    assert_eq!(w.hubs["bob"].status(), SignalingStatus::Online);
    // Alice's put goes to both relays; Bob hears it twice and keeps one.
    let o = w
        .hubs
        .get_mut("alice")
        .unwrap()
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &blob,
                kind: PutKind::Sig,
                ttl_sec: 120,
                put_id: "n1",
            },
            w.now,
            &mut rng,
        )
        .unwrap();
    assert_eq!(o.actions.len(), 2, "one event per open relay");
    w.run("alice", o);
    assert_eq!(w.puts("alice"), [("n1".to_owned(), true)]);
    assert_eq!(w.blobs("bob"), std::slice::from_ref(&blob));
    // What Alice sent is a valid Nostr event under a throwaway key, never her identity.
    let sent: Vec<&str> = w
        .sent
        .iter()
        .filter_map(|(_, a)| match a {
            Action::Send { text, .. } if text.starts_with("[\"EVENT\"") => Some(text.as_str()),
            _ => None,
        })
        .collect();
    let ev: Value = serde_json::from_str(sent[0]).unwrap();
    assert_eq!(ev[1]["kind"], 21733);
    // Garbage, someone else's subscription, a changed event and an expired one are all dropped.
    let good = sent[0].to_owned();
    let bob_hub = w.hubs.get_mut("bob").unwrap();
    for bad in [
        "not json".to_owned(),
        good.replace("\"EVENT\",{", "\"EVENT\",{\"x\":1,"), // not the shape of a relay message
        json!(["EVENT", "other-sub", ev[1]]).to_string(),
        json!(["EVENT", "sub-1", { "id": "0".repeat(64) }]).to_string(),
    ] {
        assert!(bob_hub
            .socket_message("wss://nostr-a.test", &bad, w.now)
            .events
            .is_empty());
    }
    // Both relays down: a put fails; one relay down: it still succeeds.
    let o = w
        .hubs
        .get_mut("alice")
        .unwrap()
        .socket_closed("wss://nostr-a.test", w.now);
    w.run("alice", o);
    assert_eq!(w.hubs["alice"].status(), SignalingStatus::Online);
    let o = w
        .hubs
        .get_mut("alice")
        .unwrap()
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &blob,
                kind: PutKind::Sig,
                ttl_sec: 120,
                put_id: "n2",
            },
            w.now,
            &mut rng,
        )
        .unwrap();
    assert_eq!(o.actions.len(), 1);
    let o2 = w
        .hubs
        .get_mut("alice")
        .unwrap()
        .socket_closed("wss://nostr-b.test", w.now);
    w.run("alice", o2);
    assert_eq!(w.hubs["alice"].status(), SignalingStatus::Error);
    let o = w
        .hubs
        .get_mut("alice")
        .unwrap()
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &blob,
                kind: PutKind::Sig,
                ttl_sec: 120,
                put_id: "n3",
            },
            w.now,
            &mut rng,
        )
        .unwrap();
    assert!(
        matches!(&o.events[0], Event::PutFailed { reason, .. } if reason == "No Nostr relay is connected.")
    );
}

#[test]
fn a_hub_with_a_relay_and_nostr_reports_the_best_status_takes_any_put_and_delivers_once() {
    let mut w = World::new();
    let mut rng = SeededEntropy::new("both");
    let bob = Identity::generate(&mut rng).unwrap();
    let (blob, mailbox) = blob_for("both ways", &bob);
    let both = || {
        SignalingHub::new(vec![
            Service::Relay(RelayClient::new("ws://relay.test")),
            Service::Nostr(NostrTransport::new(
                &["wss://nostr-a.test".to_owned()],
                "sub-1",
            )),
        ])
    };
    w.hubs.insert("alice".into(), both());
    w.hubs.insert("bob".into(), both());
    w.down.push("ws://relay.test".into()); // the relay is unreachable
    let o = w.hubs.get_mut("bob").unwrap().start(&mailbox);
    w.run("bob", o);
    let o = w.hubs.get_mut("alice").unwrap().start("alice-box");
    w.run("alice", o);
    assert_eq!(
        w.hubs["alice"].status(),
        SignalingStatus::Online,
        "Nostr is enough"
    );
    let o = w
        .hubs
        .get_mut("alice")
        .unwrap()
        .put(
            PutRequest {
                mailbox: &mailbox,
                blob: &blob,
                kind: PutKind::Sig,
                ttl_sec: 120,
                put_id: "b1",
            },
            w.now,
            &mut rng,
        )
        .unwrap();
    w.run("alice", o);
    assert_eq!(
        w.puts("alice"),
        [("b1".to_owned(), true)],
        "one answer, success because Nostr took it"
    );
    assert_eq!(w.blobs("bob"), [blob]);
}
