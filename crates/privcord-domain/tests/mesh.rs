//! The mesh logic exercised by simulation, as the TypeScript and Kotlin suites do, plus flaky links.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_domain::{
    blob::{PublicJwk, SealedBlob},
    mesh::{MeshNode, MeshOptions, MeshPacket, Outgoing},
};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

fn blob(n: usize, from: &str) -> SealedBlob {
    SealedBlob {
        v: 1,
        to: "ch:abcd".into(),
        from: from.into(),
        epk: PublicJwk::p256("x", "y"),
        iv: "iv".into(),
        ct: format!("ct{n}"),
        // Distinct in the first 24 characters, as real signatures are.
        sig: format!("{n:0>24}tail"),
    }
}

struct Sim {
    nodes: HashMap<String, MeshNode>,
    got: HashMap<String, Vec<SealedBlob>>,
    edges: BTreeSet<(String, String)>,
    sent: usize,
    now: u64,
}

impl Sim {
    fn new(ids: &[&str]) -> Self {
        Self::with(ids, MeshOptions::default())
    }
    fn with(ids: &[&str], options: MeshOptions) -> Self {
        Self {
            nodes: ids
                .iter()
                .map(|i| ((*i).to_owned(), MeshNode::new(options.clone())))
                .collect(),
            got: ids.iter().map(|i| ((*i).to_owned(), vec![])).collect(),
            edges: BTreeSet::new(),
            sent: 0,
            now: 1_000_000,
        }
    }
    fn key(a: &str, b: &str) -> (String, String) {
        if a < b {
            (a.into(), b.into())
        } else {
            (b.into(), a.into())
        }
    }
    fn connect(&mut self, a: &str, b: &str) {
        self.edges.insert(Self::key(a, b));
        let outs = self.nodes.get_mut(a).unwrap().link_up(b, self.now);
        self.deliver(a, outs);
        let outs = self.nodes.get_mut(b).unwrap().link_up(a, self.now);
        self.deliver(b, outs);
    }
    fn disconnect(&mut self, a: &str, b: &str) {
        self.edges.remove(&Self::key(a, b));
        self.nodes.get_mut(a).unwrap().link_down(b);
        self.nodes.get_mut(b).unwrap().link_down(a);
    }
    fn deliver(&mut self, from: &str, outs: Vec<Outgoing>) {
        let mut queue: VecDeque<(String, Outgoing)> =
            outs.into_iter().map(|o| (from.to_owned(), o)).collect();
        while let Some((src, o)) = queue.pop_front() {
            if !self.edges.contains(&Self::key(&src, &o.link)) {
                continue;
            }
            self.sent += 1;
            let raw: Value = serde_json::to_value(&o.packet).unwrap();
            let r = self
                .nodes
                .get_mut(&o.link)
                .unwrap()
                .handle(&raw, &src, self.now);
            if let Some(b) = r.accepted {
                self.got.get_mut(&o.link).unwrap().push(b);
            }
            for f in r.forward {
                queue.push_back((o.link.clone(), f));
            }
        }
    }
    fn send(&mut self, origin: &str, b: SealedBlob) {
        let outs = self.nodes.get_mut(origin).unwrap().inject(b, self.now);
        self.deliver(origin, outs);
    }
    fn count(&self, id: &str) -> usize {
        self.got[id].len()
    }
}

#[test]
fn crosses_several_phones_and_is_never_echoed_back() {
    let mut s = Sim::new(&["A", "B", "C", "D", "E"]);
    for (x, y) in [("A", "B"), ("B", "C"), ("C", "D"), ("D", "E")] {
        s.connect(x, y);
    }
    s.send("A", blob(1, "Ann"));
    for id in ["B", "C", "D", "E"] {
        assert_eq!(s.count(id), 1, "{id}");
    }
    assert_eq!(s.count("A"), 0);
}

#[test]
fn stops_after_the_hop_limit() {
    let ids: Vec<String> = (0..12).map(|i| format!("N{i}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let mut s = Sim::new(&refs);
    for i in 0..11 {
        s.connect(&ids[i], &ids[i + 1]);
    }
    s.send("N0", blob(2, "Ann"));
    // ttl 7 reaches 7 hops away and no further.
    assert_eq!(s.count("N7"), 1);
    assert_eq!(s.count("N8"), 0);
}

#[test]
fn loops_do_not_flood_endlessly() {
    let mut s = Sim::new(&["A", "B", "C", "D"]);
    for (x, y) in [("A", "B"), ("B", "C"), ("C", "D"), ("D", "A"), ("A", "C")] {
        s.connect(x, y);
    }
    s.send("A", blob(3, "Ann"));
    for id in ["B", "C", "D"] {
        assert_eq!(s.count(id), 1, "{id}");
    }
    assert!(s.sent <= s.edges.len() * 2, "sent {}", s.sent);
}

#[test]
fn carries_for_a_phone_that_shows_up_later_once_only_and_forgets_after_the_carry_time() {
    let mut s = Sim::new(&["A", "B", "C", "D"]);
    s.connect("A", "B");
    s.send("A", blob(4, "Ann"));
    s.now += 10 * 60_000;
    s.disconnect("A", "B");
    s.connect("B", "C");
    assert_eq!(s.count("C"), 1);
    s.disconnect("B", "C");
    s.connect("B", "C");
    assert_eq!(s.count("C"), 1);
    s.now += 31 * 60_000;
    s.connect("B", "D");
    assert_eq!(s.count("D"), 0);
}

#[test]
fn refuses_a_flooding_sender_garbage_and_a_huge_ttl() {
    let mut s = Sim::with(
        &["A", "B"],
        MeshOptions {
            per_sender_per_minute: 3,
            ..MeshOptions::default()
        },
    );
    s.connect("A", "B");
    for n in 0..6 {
        s.send("A", blob(10 + n, "Spammer"));
    }
    assert_eq!(s.count("B"), 3);

    let good = serde_json::to_value(MeshPacket::new(blob(99, "Ann"), 7)).unwrap();
    let mut node = MeshNode::default();
    node.link_up("x", 0);
    for bad in [
        json!(null),
        json!("str"),
        json!({ "v": 1, "kind": "mesh" }),
        {
            let mut g = good.clone();
            g["id"] = "wrong".into();
            g
        },
        {
            let mut g = good.clone();
            g["ttl"] = 0.into();
            g
        },
        {
            let mut g = good.clone();
            g["ttl"] = 1.5.into();
            g
        },
        {
            let mut g = good.clone();
            g["blob"]["ct"] = "x".repeat(9000).into();
            g
        },
    ] {
        assert!(MeshPacket::parse(&bad).is_none(), "{bad}");
    }
    let mut big_ttl = good;
    big_ttl["ttl"] = 9999.into();
    assert_eq!(MeshPacket::parse(&big_ttl).unwrap().ttl, 7);
}

#[test]
fn a_packet_lost_because_the_link_dropped_mid_send_arrives_when_it_returns() {
    let mut s = Sim::new(&["A", "B", "C"]);
    s.connect("A", "B");
    s.connect("B", "C");
    let outs = s.nodes.get_mut("A").unwrap().inject(blob(5, "Ann"), s.now); // handed to the radio...
    assert_eq!(outs.len(), 1);
    s.disconnect("A", "B"); // ...which loses the link before it arrives
    assert_eq!(s.count("B"), 0);
    s.connect("A", "B");
    assert_eq!(s.count("B"), 1);
    assert_eq!(s.count("C"), 1);
}

#[test]
fn flapping_links_still_deliver_everything_exactly_once() {
    let ids: Vec<String> = (0..12).map(|i| format!("F{i}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let mut s = Sim::new(&refs);
    let ring: Vec<(String, String)> = (0..12)
        .map(|i| (ids[i].clone(), ids[(i + 1) % 12].clone()))
        .collect();
    for (a, b) in &ring {
        s.connect(a, b);
    }
    let mut seed: u64 = 99;
    let mut rnd = move || {
        seed = (seed.wrapping_mul(1_103_515_245).wrapping_add(12345)) & 0x7fff_ffff;
        seed as f64 / f64::from(0x7fff_ffffu32)
    };
    let mut sent = vec![];
    for round in 0..40usize {
        let (a, b) = &ring[(rnd() * ring.len() as f64) as usize % ring.len()];
        if s.edges.contains(&Sim::key(a, b)) {
            s.disconnect(a, b)
        } else {
            s.connect(a, b)
        }
        if round % 8 == 0 {
            let b = blob(200 + round, &format!("Who{round}"));
            sent.push(b.clone());
            let origin = ids[(rnd() * 12.0) as usize % 12].clone();
            s.send(&origin, b);
        }
        s.now += 1000;
    }
    for (a, b) in &ring {
        if !s.edges.contains(&Sim::key(a, b)) {
            s.connect(a, b);
        }
    }
    for id in &ids {
        let cts: HashSet<&String> = s.got[id].iter().map(|b| &b.ct).collect();
        assert_eq!(cts.len(), s.got[id].len(), "{id} received a duplicate");
    }
    for b in &sent {
        let holders = ids
            .iter()
            .filter(|id| s.got[*id].iter().any(|x| x.ct == b.ct))
            .count();
        assert!(
            holders >= ids.len() - 1,
            "message {} reached {holders}",
            b.ct
        );
    }
}

#[test]
fn a_random_30_phone_network_reaches_exactly_who_the_hop_limit_allows() {
    let ids: Vec<String> = (0..30).map(|i| format!("P{i}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let mut s = Sim::new(&refs);
    let mut seed: u64 = 7;
    let mut rnd = move || {
        seed = (seed.wrapping_mul(1_103_515_245).wrapping_add(12345)) & 0x7fff_ffff;
        (seed as f64 / f64::from(0x7fff_ffffu32) * 1e9) as usize
    };
    for i in 1..30 {
        let j = rnd() % i;
        s.connect(&ids[i], &ids[j]);
    }
    for _ in 0..15 {
        let (a, b) = (rnd() % 30, rnd() % 30);
        if a != b {
            s.connect(&ids[a], &ids[b]);
        }
    }
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    for (a, b) in &s.edges {
        adj.entry(a.clone()).or_default().push(b.clone());
        adj.entry(b.clone()).or_default().push(a.clone());
    }
    let mut dist: HashMap<String, u32> = HashMap::from([("P0".to_owned(), 0)]);
    let mut q = VecDeque::from(["P0".to_owned()]);
    while let Some(x) = q.pop_front() {
        for y in adj.get(&x).cloned().unwrap_or_default() {
            if !dist.contains_key(&y) {
                dist.insert(y.clone(), dist[&x] + 1);
                q.push_back(y);
            }
        }
    }
    s.send("P0", blob(7, "Ann"));
    for id in &ids[1..] {
        let reachable = dist.get(id).copied().unwrap_or(99) <= 7;
        assert_eq!(
            s.count(id),
            usize::from(reachable),
            "{id} at distance {:?}",
            dist.get(id)
        );
    }
}
