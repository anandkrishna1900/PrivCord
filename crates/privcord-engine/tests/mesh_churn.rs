//! Four devices (two laptops, two phones) that are all friends and share a group, with links dropping and coming back
//! at random while everyone writes. Once every link is back, every message must have arrived exactly once everywhere it
//! was meant to, and every sender must see it delivered with nothing left queued.
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
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

struct Node {
    core: Core,
    transport: Arc<RecordingTransport>,
    uid: UserId,
}

fn node(seed: &str, clock: &Arc<FakeClock>) -> Node {
    let transport = RecordingTransport::new();
    let mut core = Core::new(Ports {
        storage: MemoryStorage::new(),
        secure: MemorySecureStore::new(),
        transport: transport.clone(),
        clock: clock.clone(),
        notifier: RecordingNotifier::new(),
        entropy: Box::new(SeededEntropy::new(seed)),
    })
    .unwrap();
    core.create_identity().unwrap();
    let uid = core.own_uid().unwrap().clone();
    Node {
        core,
        transport,
        uid,
    }
}

/// A small deterministic generator, so a failure replays exactly.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

struct Net {
    nodes: Vec<Node>,
    up: HashSet<(usize, usize)>,
}

impl Net {
    fn key(i: usize, j: usize) -> (usize, usize) {
        (i.min(j), i.max(j))
    }

    fn set(&mut self, i: usize, j: usize, on: bool) {
        let k = Self::key(i, j);
        if self.up.contains(&k) == on {
            return;
        }
        let (ui, uj) = (self.nodes[i].uid.clone(), self.nodes[j].uid.clone());
        self.nodes[i].transport.set_connected(&uj, on);
        self.nodes[j].transport.set_connected(&ui, on);
        if on {
            self.up.insert(k);
            self.nodes[i]
                .core
                .link_up(&uj, ConnectionPath::DirectLan)
                .unwrap();
            self.nodes[j]
                .core
                .link_up(&ui, ConnectionPath::DirectLan)
                .unwrap();
        } else {
            self.up.remove(&k);
            self.nodes[i].core.link_down(&uj);
            self.nodes[j].core.link_down(&ui);
        }
    }

    /// Deliver what is in flight over links that are up (frames on a dead link are lost, as on a real network).
    /// `limit` stops early, leaving frames in flight across the next change of links.
    fn pump(&mut self, limit: usize) {
        for _ in 0..limit {
            let mut moved = false;
            let uids: Vec<UserId> = self.nodes.iter().map(|n| n.uid.clone()).collect();
            for i in 0..self.nodes.len() {
                for (to, frame) in self.nodes[i].transport.drain() {
                    moved = true;
                    let Some(j) = uids.iter().position(|u| *u == to) else {
                        continue;
                    };
                    if self.up.contains(&Self::key(i, j)) {
                        let from = uids[i].clone();
                        self.nodes[j].core.frame_received(&from, &frame);
                    }
                }
            }
            if !moved {
                return;
            }
        }
    }

    fn tick(&mut self) {
        for n in &mut self.nodes {
            n.core.tick();
        }
    }
}

/// Every text a node holds, per conversation key, with how many copies.
fn texts(n: &Node) -> HashMap<String, usize> {
    let mut out = HashMap::new();
    for (_, list) in n.core.snapshot().messages {
        for m in list {
            *out.entry(m.text).or_insert(0) += 1;
        }
    }
    out
}

fn run(seed: u64) {
    let clock = FakeClock::at(1_700_000_000_000);
    let names = ["laptop-a", "laptop-b", "phone-c", "phone-d"];
    let mut nodes: Vec<Node> = names.iter().map(|s| node(s, &clock)).collect();
    for i in 0..4 {
        for j in (i + 1)..4 {
            let (ci, cj) = (
                nodes[i].core.own_card(None).unwrap(),
                nodes[j].core.own_card(None).unwrap(),
            );
            nodes[i]
                .core
                .add_contact(&cj, ContactTrust::Verified)
                .unwrap();
            nodes[j]
                .core
                .add_contact(&ci, ContactTrust::Verified)
                .unwrap();
        }
    }
    let others: Vec<UserId> = nodes[1..].iter().map(|n| n.uid.clone()).collect();
    let gid = nodes[0].core.create_group("Four", &others).unwrap();
    let mut net = Net {
        nodes,
        up: HashSet::new(),
    };
    for i in 0..4 {
        for j in (i + 1)..4 {
            net.set(i, j, true);
        }
    }
    net.pump(1000);
    for n in &net.nodes {
        assert_eq!(
            n.core.snapshot().groups.len(),
            1,
            "everyone is in the group before the churn"
        );
    }

    let mut rng = Rng(seed);
    // (sender, text, recipients)
    let mut sent: Vec<(usize, String, Vec<usize>)> = Vec::new();
    for round in 0..120 {
        // Links flap: roughly one change every round.
        let (i, j) = (rng.below(4) as usize, rng.below(4) as usize);
        if i != j {
            let on = rng.below(3) != 0;
            net.set(i, j, on);
        }
        // Someone writes, to one friend or to the group.
        let from = rng.below(4) as usize;
        if rng.below(2) == 0 {
            let to = (from + 1 + rng.below(3) as usize) % 4;
            let text = format!("dm {round} {from}->{to}");
            let peer = net.nodes[to].uid.clone();
            net.nodes[from]
                .core
                .send_message(&peer, &text, None)
                .unwrap();
            sent.push((from, text, vec![to]));
        } else {
            let text = format!("group {round} from {from}");
            net.nodes[from]
                .core
                .send_group_message(&gid, &text, None)
                .unwrap();
            sent.push((from, text, (0..4).filter(|k| *k != from).collect()));
        }
        // Partial delivery, then time passes (pings, retries, liveness).
        net.pump(1 + rng.below(3) as usize);
        clock.advance(rng.below(6_000) as i64);
        net.tick();
        net.pump(1 + rng.below(3) as usize);
    }

    // Everything heals: all links up, enough time for every retry.
    for i in 0..4 {
        for j in (i + 1)..4 {
            net.set(i, j, true);
        }
    }
    for _ in 0..40 {
        net.pump(1000);
        clock.advance(30_000);
        net.tick();
    }
    net.pump(1000);

    let held: Vec<HashMap<String, usize>> = net.nodes.iter().map(texts).collect();
    for (from, text, to) in &sent {
        for k in to {
            let copies = held[*k].get(text).copied().unwrap_or(0);
            assert_eq!(
                copies, 1,
                "seed {seed}: {} holds {copies} copies of {text:?}",
                names[*k]
            );
        }
        assert_eq!(
            held[*from].get(text).copied(),
            Some(1),
            "seed {seed}: sender keeps one copy of {text:?}"
        );
    }
    for (k, n) in net.nodes.iter().enumerate() {
        let snap = n.core.snapshot();
        assert_eq!(
            snap.queued, 0,
            "seed {seed}: {} still has messages queued",
            names[k]
        );
        let own = n.uid.as_str();
        for m in snap.messages.into_iter().flat_map(|(_, v)| v) {
            if m.sender_id.as_str() == own {
                assert!(
                    matches!(
                        m.delivery_state,
                        DeliveryState::Delivered | DeliveryState::Read
                    ),
                    "seed {seed}: {}'s {:?} is {:?}",
                    names[k],
                    m.text,
                    m.delivery_state
                );
            }
        }
    }
}

#[test]
fn four_devices_with_flapping_links_lose_and_duplicate_nothing() {
    for seed in 1..=10u64 {
        run(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    }
}
