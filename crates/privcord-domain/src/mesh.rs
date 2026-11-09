//! Radio-independent logic of the Bluetooth mesh (`mesh/node.ts`): validate, drop repeats, count hops, flood to
//! neighbours, carry messages for neighbours that arrive later, and refuse spammers.
//!
//! It handles `SealedBlob`s only. Relaying phones need no keys and cannot alter a message (the signature would break).

use crate::{
    blob::SealedBlob,
    limits::{MESH_CARRY_MS, MESH_MAX_TTL},
};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

pub const MESH_MAX_PACKET_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MeshPacket {
    pub v: u8,
    pub kind: &'static str,
    /// Identifies the message across the whole mesh: the first 24 characters of the blob's signature.
    pub id: String,
    /// Hops left.
    pub ttl: u32,
    pub blob: SealedBlob,
}

pub fn packet_id(blob: &SealedBlob) -> String {
    blob.sig.chars().take(24).collect()
}

impl MeshPacket {
    /// What this phone remembers a packet by: the wire id plus a hash of the whole blob. The wire id is only a prefix of
    /// the signature, so a neighbour could send junk with a real message's id first; keyed this way the junk and the
    /// real message are different packets and the real one still gets through.
    fn key(&self) -> String {
        let body = serde_json::to_string(&self.blob).unwrap_or_default();
        format!("{}:{}", self.id, crate::files::sha256_b64(body.as_bytes()))
    }

    pub fn new(blob: SealedBlob, ttl: u32) -> Self {
        Self {
            v: 1,
            kind: "mesh",
            id: packet_id(&blob),
            ttl: ttl.clamp(1, MESH_MAX_TTL),
            blob,
        }
    }

    /// `None` for garbage, a wrong id, a zero ttl or an oversize packet. A neighbour cannot make a message travel
    /// further than the mesh allows, whatever it writes in `ttl`.
    pub fn parse(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        if o.get("v")?.as_u64()? != 1 || o.get("kind")?.as_str()? != "mesh" {
            return None;
        }
        let id = o.get("id")?.as_str()?;
        let ttl = o.get("ttl")?.as_f64()?;
        if ttl.fract() != 0.0 || ttl < 1.0 {
            return None;
        }
        let blob = SealedBlob::from_value(o.get("blob")?)?;
        if id != packet_id(&blob) {
            return None;
        }
        if serde_json::to_string(value).ok()?.encode_utf16().count() > MESH_MAX_PACKET_BYTES {
            return None;
        }
        let ttl = if ttl >= f64::from(MESH_MAX_TTL) {
            MESH_MAX_TTL
        } else {
            ttl as u32
        };
        Some(Self {
            v: 1,
            kind: "mesh",
            id: id.to_owned(),
            ttl,
            blob,
        })
    }
}

#[derive(Debug, Clone)]
pub struct MeshOptions {
    /// How many new messages one neighbour may hand us per minute before we stop taking them. This is counted per radio
    /// link, not per sender name: the name inside a message is not verified by relays, so anyone could use up another
    /// person's allowance by writing it into junk.
    pub per_sender_per_minute: usize,
    pub seen_capacity: usize,
    pub carry_ms: u64,
    pub carry_capacity: usize,
}

impl Default for MeshOptions {
    fn default() -> Self {
        Self {
            per_sender_per_minute: 60,
            seen_capacity: 4000,
            carry_ms: MESH_CARRY_MS,
            carry_capacity: 300,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outgoing {
    pub link: String,
    pub packet: MeshPacket,
}

#[derive(Debug, Default)]
pub struct HandleResult {
    /// A blob this phone has not seen before: the caller tries to open it (direct message? joined channel?).
    pub accepted: Option<SealedBlob>,
    pub forward: Vec<Outgoing>,
}

#[derive(Debug)]
struct Carried {
    packet: MeshPacket,
    /// Who handed it to us ("" for a message we wrote ourselves).
    via: String,
    stored_at: u64,
    sent_to: HashSet<String>,
}

/// One phone's view of the mesh. Link ids are whatever the radio layer uses to name a neighbour.
#[derive(Debug)]
pub struct MeshNode {
    links: HashSet<String>,
    seen: VecDeque<String>,
    seen_set: HashSet<String>,
    carried: Vec<(String, Carried)>,
    sender_window: HashMap<String, Vec<u64>>,
    sender_order: VecDeque<String>,
    options: MeshOptions,
}

impl Default for MeshNode {
    fn default() -> Self {
        Self::new(MeshOptions::default())
    }
}

impl MeshNode {
    pub fn new(options: MeshOptions) -> Self {
        Self {
            links: HashSet::new(),
            seen: VecDeque::new(),
            seen_set: HashSet::new(),
            carried: Vec::new(),
            sender_window: HashMap::new(),
            sender_order: VecDeque::new(),
            options,
        }
    }

    pub fn neighbours(&self) -> Vec<String> {
        let mut v: Vec<String> = self.links.iter().cloned().collect();
        v.sort();
        v
    }

    /// A message we wrote: send it to every neighbour and keep it for ones that arrive later.
    pub fn inject(&mut self, blob: SealedBlob, now_ms: u64) -> Vec<Outgoing> {
        let packet = MeshPacket::new(blob, MESH_MAX_TTL);
        self.remember(&packet.key());
        let links = self.sorted_links();
        self.carry(packet.clone(), "", now_ms, links.iter().cloned());
        links
            .into_iter()
            .map(|link| Outgoing {
                link,
                packet: packet.clone(),
            })
            .collect()
    }

    /// A packet from a neighbour.
    pub fn handle(&mut self, raw: &Value, from: &str, now_ms: u64) -> HandleResult {
        let Some(packet) = MeshPacket::parse(raw) else {
            return HandleResult::default();
        };
        let key = packet.key();
        if self.seen_set.contains(&key) {
            return HandleResult::default();
        }
        // Over the sender's limit: not remembered, so it is accepted when it comes round again after the window.
        if !self.allow_sender(from, now_ms) {
            return HandleResult::default();
        }
        self.remember(&key);
        let mut forward = Vec::new();
        if packet.ttl > 1 {
            let next = MeshPacket {
                ttl: packet.ttl - 1,
                ..packet.clone()
            };
            let targets: Vec<String> = self
                .sorted_links()
                .into_iter()
                .filter(|l| l != from)
                .collect();
            let mut sent: Vec<String> = vec![from.to_owned()];
            sent.extend(targets.iter().cloned());
            self.carry(next.clone(), from, now_ms, sent);
            forward.extend(targets.into_iter().map(|link| Outgoing {
                link,
                packet: next.clone(),
            }));
        }
        HandleResult {
            accepted: Some(packet.blob),
            forward,
        }
    }

    /// A new neighbour: hand it everything we are carrying that it has not been given.
    pub fn link_up(&mut self, link: &str, now_ms: u64) -> Vec<Outgoing> {
        self.links.insert(link.to_owned());
        self.expire(now_ms);
        let mut out = Vec::new();
        for (_, c) in &mut self.carried {
            if c.sent_to.contains(link) {
                continue;
            }
            c.sent_to.insert(link.to_owned());
            out.push(Outgoing {
                link: link.to_owned(),
                packet: c.packet.clone(),
            });
        }
        out
    }

    /// A link went away. It may have dropped a packet in flight, so forget what we "sent" over it: the next link-up
    /// hands everything over again, and the other phone ignores copies it already has.
    pub fn link_down(&mut self, link: &str) {
        self.links.remove(link);
        for (_, c) in &mut self.carried {
            c.sent_to.remove(link);
        }
    }

    fn sorted_links(&self) -> Vec<String> {
        self.neighbours()
    }

    fn remember(&mut self, id: &str) {
        if self.seen_set.insert(id.to_owned()) {
            self.seen.push_back(id.to_owned());
        }
        while self.seen.len() > self.options.seen_capacity {
            if let Some(old) = self.seen.pop_front() {
                self.seen_set.remove(&old);
            }
        }
    }

    fn carry(
        &mut self,
        packet: MeshPacket,
        via: &str,
        now_ms: u64,
        sent_to: impl IntoIterator<Item = String>,
    ) {
        if packet.ttl < 1 {
            return;
        }
        self.expire(now_ms);
        let key = packet.key();
        self.carried.retain(|(k, _)| *k != key);
        self.carried.push((
            key,
            Carried {
                packet,
                via: via.to_owned(),
                stored_at: now_ms,
                sent_to: sent_to.into_iter().collect(),
            },
        ));
        // Full: drop the oldest packet of whichever neighbour has handed us the most, so one noisy (or hostile) neighbour
        // cannot push everybody else's messages out of the buffer. Messages we wrote ourselves go last.
        while self.carried.len() > self.options.carry_capacity {
            let mut count: HashMap<&str, usize> = HashMap::new();
            for (_, c) in &self.carried {
                if !c.via.is_empty() {
                    *count.entry(c.via.as_str()).or_default() += 1;
                }
            }
            let heaviest = count
                .into_iter()
                .max_by_key(|(via, n)| (*n, std::cmp::Reverse(*via)))
                .map(|(via, _)| via.to_owned());
            let at = heaviest
                .and_then(|v| self.carried.iter().position(|(_, c)| c.via == v))
                .unwrap_or(0);
            self.carried.remove(at);
        }
    }

    fn expire(&mut self, now_ms: u64) {
        let carry = self.options.carry_ms;
        self.carried
            .retain(|(_, c)| now_ms.saturating_sub(c.stored_at) <= carry);
    }

    /// At most `per_sender_per_minute` new messages from one sender are passed on; the rest are ignored.
    fn allow_sender(&mut self, from: &str, now_ms: u64) -> bool {
        let limit = self.options.per_sender_per_minute;
        let window = self.sender_window.entry(from.to_owned()).or_default();
        window.retain(|t| now_ms.saturating_sub(*t) < 60_000);
        if window.len() >= limit {
            return false;
        }
        window.push(now_ms);
        if !self.sender_order.iter().any(|s| s == from) {
            self.sender_order.push_back(from.to_owned());
        }
        while self.sender_order.len() > 2000 {
            if let Some(old) = self.sender_order.pop_front() {
                self.sender_window.remove(&old);
            }
        }
        true
    }
}
