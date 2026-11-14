//! The sync log (docs/design/syncengine.md §3): how the devices of one account agree on everything that happened.
//!
//! Every durable change a device makes is an [`Entry`] in that device's own log, numbered 1, 2, 3 … with no gaps,
//! chained by hash to the one before, ordered by a hybrid logical clock, and signed with the device's key. A
//! [`Replica`] takes entries from any device of the account in any order, any number of times, and ends in the same
//! state as every other replica that has the same entries:
//!
//! * **Gaps** are held back (bounded) until the missing entries arrive, so a device's entries apply in order.
//! * **Merging never depends on order.** A reaction, an edit or a delete is kept against its message's id whether the
//!   message has arrived or not, and shows once it has; the latest edit / reaction / setting wins by clock (device id
//!   breaks a tie); a delete beats any edit; read marks only move forward.
//! * **Clones are caught.** Two different entries with the same number from one device (a copied install, a restored
//!   VM) freeze that device: nothing more is accepted from it.
//! * **Unknown kinds** (from a newer app) are kept and passed on byte for byte, never dropped.
//! * **A bad entry never stops the log.** A signed entry of a known kind that does not make sense is quarantined and
//!   reported, and the entries after it still apply.
//! * **A fingerprint** of the merged state lets two devices check they agree.
//!
//! Live chat is not slowed by any of this: it is the bookkeeping that moves alongside.

use crate::{
    canonical::canonical_json,
    devices::DeviceList,
    error::CryptoError,
    identity::{verify_signature, Identity},
    kdf::sha256,
};
use privcord_domain::codec;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use unicode_normalization::UnicodeNormalization;

/// A clock reading this far ahead of our own is not adopted (risk 14): a device whose clock is wrong cannot drag
/// every other device's clock into the future.
pub const MAX_FUTURE_MS: i64 = 3600 * 1000;
/// Entries held back per device stream, waiting for a gap to fill (risk 58).
pub const MAX_PENDING_PER_STREAM: usize = 1024;
/// Entries held back in all.
pub const MAX_PENDING_TOTAL: usize = 8192;
/// Largest entry body, in bytes of JSON (risk 77).
pub const MAX_BODY_BYTES: usize = 64 * 1024;
/// Longest id, conversation or setting key.
const MAX_ID_CHARS: usize = 256;

const ENTRY_TAG: &str = "duocord-entry-v1";

/// A hybrid logical clock reading: wall-clock milliseconds, and a counter for events in the same millisecond. It
/// never goes backwards and is always ahead of every entry seen, so causes sort before their effects.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
pub struct Hlc {
    pub wall: i64,
    pub count: u32,
}

impl Hlc {
    /// The reading for something happening now.
    pub fn tick(self, now: i64) -> Hlc {
        if now > self.wall {
            Hlc {
                wall: now,
                count: 0,
            }
        } else {
            Hlc {
                wall: self.wall,
                count: self.count.saturating_add(1),
            }
        }
    }

    /// After seeing another device's reading.
    pub fn observe(self, remote: Hlc, now: i64) -> Hlc {
        let cap = now.saturating_add(MAX_FUTURE_MS);
        let remote = if remote.wall > cap {
            Hlc {
                wall: cap,
                count: 0,
            }
        } else {
            remote
        };
        self.max(remote)
    }
}

/// One change, written by one device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub device: String,
    /// A device starts a new series after a restore, so a number is never used twice (risk 15).
    pub series: u32,
    /// 1, 2, 3 … within the series.
    pub seq: u64,
    /// Hash of the previous entry in the series ("" for the first).
    pub prev: String,
    pub hlc: Hlc,
    pub kind: String,
    pub body: Value,
    /// The device's signature over everything above, base64url.
    pub sig: String,
}

impl Entry {
    fn payload(
        device: &str,
        series: u32,
        seq: u64,
        prev: &str,
        hlc: Hlc,
        kind: &str,
        body: &Value,
    ) -> Result<Vec<u8>, CryptoError> {
        let v = json!({
            "t": ENTRY_TAG,
            "device": device,
            "series": series,
            "seq": seq,
            "prev": prev,
            "hlc": [hlc.wall, hlc.count],
            "kind": kind,
            "body": body,
        });
        Ok(canonical_json(&v)?.into_bytes())
    }

    fn signed_bytes(&self) -> Result<Vec<u8>, CryptoError> {
        Self::payload(
            &self.device,
            self.series,
            self.seq,
            &self.prev,
            self.hlc,
            &self.kind,
            &self.body,
        )
    }

    /// The entry's identity: a hash over what it says and its signature.
    pub fn hash(&self) -> String {
        let mut bytes = self.signed_bytes().unwrap_or_default();
        bytes.push(b'\n');
        bytes.extend_from_slice(self.sig.as_bytes());
        codec::hex(&sha256(&bytes))
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Parses an entry from the network. It still has to be checked by a [`Replica`].
    pub fn from_json(text: &str) -> Option<Self> {
        if text.len() > MAX_BODY_BYTES * 2 {
            return None;
        }
        serde_json::from_str(text).ok()
    }
}

/// What a device needs to keep (and save before anything it writes leaves it) to go on writing its log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Writer {
    pub device: String,
    pub series: u32,
    pub next_seq: u64,
    pub last_hash: String,
    pub clock: Hlc,
}

impl Writer {
    pub fn new(device: &str, series: u32) -> Self {
        Self {
            device: device.to_owned(),
            series,
            next_seq: 1,
            last_hash: String::new(),
            clock: Hlc::default(),
        }
    }

    /// Writes the next entry. The caller saves `self` before the entry is sent anywhere.
    pub fn append(
        &mut self,
        key: &Identity,
        kind: &str,
        body: Value,
        now: i64,
    ) -> Result<Entry, CryptoError> {
        if serde_json::to_vec(&body)
            .map_err(|_| CryptoError::Canonical)?
            .len()
            > MAX_BODY_BYTES
        {
            return Err(CryptoError::TooLarge);
        }
        let hlc = self.clock.tick(now);
        let payload = Entry::payload(
            &self.device,
            self.series,
            self.next_seq,
            &self.last_hash,
            hlc,
            kind,
            &body,
        )?;
        let entry = Entry {
            device: self.device.clone(),
            series: self.series,
            seq: self.next_seq,
            prev: self.last_hash.clone(),
            hlc,
            kind: kind.to_owned(),
            body,
            sig: codec::encode(&key.sign_message(&payload)),
        };
        self.next_seq += 1;
        self.last_hash = entry.hash();
        self.clock = hlc;
        Ok(entry)
    }

    /// Keeps this device's clock ahead of what other devices wrote.
    pub fn observe(&mut self, remote: Hlc, now: i64) {
        self.clock = self.clock.observe(remote, now);
    }
}

/* ------------------------------------------------------------------ merge rules */

/// Where an entry sits in the shared order: clock, then device, then number. The same on every device.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Order {
    pub hlc: Hlc,
    pub device: String,
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct MessageRec {
    order: Order,
    hash: String,
    body: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct Lww<T> {
    hlc: Hlc,
    device: String,
    value: T,
}

impl<T> Lww<T> {
    fn newer_than(&self, other: &Lww<T>) -> bool {
        (self.hlc, &self.device) > (other.hlc, &other.device)
    }
}

fn lww<T>(e: &Entry, value: T) -> Lww<T> {
    Lww {
        hlc: e.hlc,
        device: e.device.clone(),
        value,
    }
}

fn put_lww<K: Ord, T>(map: &mut BTreeMap<K, Lww<T>>, key: K, next: Lww<T>) {
    match map.get(&key) {
        Some(cur) if !next.newer_than(cur) => {}
        _ => {
            map.insert(key, next);
        }
    }
}

/// The merged result of every applied entry.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct State {
    messages: BTreeMap<String, MessageRec>,
    edits: BTreeMap<String, Lww<String>>,
    deleted: BTreeSet<String>,
    hidden: BTreeSet<String>,
    reactions: BTreeMap<(String, String), Lww<Option<String>>>,
    read: BTreeMap<String, Hlc>,
    settings: BTreeMap<String, Lww<Value>>,
}

/// The kinds this version understands. Anything else is kept in the log as it is.
pub mod kind {
    pub const MESSAGE: &str = "message";
    pub const EDIT: &str = "edit";
    pub const DELETE: &str = "delete";
    pub const HIDE: &str = "hide";
    pub const REACT: &str = "react";
    pub const READ: &str = "read";
    pub const SETTING: &str = "setting";
}

fn id_field<'a>(body: &'a Value, name: &str) -> Result<&'a str, &'static str> {
    let s = body
        .get(name)
        .and_then(Value::as_str)
        .ok_or("missing field")?;
    if s.is_empty() || s.chars().count() > MAX_ID_CHARS {
        return Err("bad id");
    }
    Ok(s)
}

impl State {
    /// Applies one entry. `Err` means the entry is quarantined (it changed nothing).
    fn apply(&mut self, e: &Entry, hash: &str) -> Result<(), &'static str> {
        let order = Order {
            hlc: e.hlc,
            device: e.device.clone(),
            seq: e.seq,
        };
        let b = &e.body;
        match e.kind.as_str() {
            kind::MESSAGE => {
                let id = id_field(b, "id")?.to_owned();
                id_field(b, "conv")?;
                let rec = MessageRec {
                    order,
                    hash: hash.to_owned(),
                    body: b.clone(),
                };
                // The same id written twice (only a broken or hostile device does that): keep one, the same one
                // everywhere.
                match self.messages.get(&id) {
                    Some(cur) if cur.hash <= rec.hash => {}
                    _ => {
                        self.messages.insert(id, rec);
                    }
                }
            }
            kind::EDIT => {
                let target = id_field(b, "target")?.to_owned();
                let text = b
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or("missing text")?
                    .to_owned();
                put_lww(&mut self.edits, target, lww(e, text));
            }
            kind::DELETE => {
                self.deleted.insert(id_field(b, "target")?.to_owned());
            }
            kind::HIDE => {
                self.hidden.insert(id_field(b, "target")?.to_owned());
            }
            kind::REACT => {
                let target = id_field(b, "target")?.to_owned();
                let by = id_field(b, "by")?.to_owned();
                let emoji = match b.get("emoji") {
                    Some(Value::String(s)) if !s.is_empty() && s.chars().count() <= 16 => {
                        Some(s.clone())
                    }
                    Some(Value::Null) | None => None,
                    _ => return Err("bad emoji"),
                };
                put_lww(&mut self.reactions, (target, by), lww(e, emoji));
            }
            kind::READ => {
                let conv = id_field(b, "conv")?.to_owned();
                let upto: Hlc =
                    serde_json::from_value(b.get("upto").cloned().ok_or("missing upto")?)
                        .map_err(|_| "bad upto")?;
                let cur = self.read.entry(conv).or_default();
                *cur = (*cur).max(upto);
            }
            kind::SETTING => {
                let key = id_field(b, "key")?.to_owned();
                let value = b.get("value").cloned().ok_or("missing value")?;
                put_lww(&mut self.settings, key, lww(e, value));
            }
            _ => {}
        }
        Ok(())
    }

    /// The messages of a conversation as they should be shown: in the shared order, deleted and hidden ones left out,
    /// each with its latest text.
    pub fn conversation(&self, conv: &str) -> Vec<(String, String)> {
        let mut rows: Vec<(&Order, &String, &MessageRec)> = self
            .messages
            .iter()
            .filter(|(id, m)| {
                m.body.get("conv").and_then(Value::as_str) == Some(conv)
                    && !self.deleted.contains(*id)
                    && !self.hidden.contains(*id)
            })
            .map(|(id, m)| (&m.order, id, m))
            .collect();
        rows.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
        rows.into_iter()
            .map(|(_, id, m)| {
                let text = self
                    .edits
                    .get(id)
                    .map(|e| e.value.clone())
                    .or_else(|| {
                        m.body
                            .get("text")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .unwrap_or_default();
                (id.clone(), text)
            })
            .collect()
    }

    /// Who reacted with what to a message (only once the message is here and not deleted).
    pub fn reactions(&self, message: &str) -> BTreeMap<String, String> {
        if !self.messages.contains_key(message) || self.deleted.contains(message) {
            return BTreeMap::new();
        }
        self.reactions
            .range((message.to_owned(), String::new())..)
            .take_while(|((m, _), _)| m == message)
            .filter_map(|((_, by), r)| r.value.clone().map(|e| (by.clone(), e)))
            .collect()
    }

    pub fn read_upto(&self, conv: &str) -> Option<Hlc> {
        self.read.get(conv).copied()
    }

    pub fn setting(&self, key: &str) -> Option<&Value> {
        self.settings.get(key).map(|s| &s.value)
    }

    /// A hash of the merged state (risk 10). Text is normalised first, so the same words typed on two platforms
    /// count as the same (risks 57, 116).
    pub fn fingerprint(&self) -> String {
        // ponytail: recomputed over the whole state each time; an incremental hash tree when histories get large
        // (risk 115).
        let value = normalise(serde_json::to_value(self).unwrap_or(Value::Null));
        codec::hex(&sha256(
            canonical_json(&value).unwrap_or_default().as_bytes(),
        ))
    }
}

fn normalise(v: Value) -> Value {
    match v {
        Value::String(s) => Value::String(s.nfc().collect()),
        Value::Array(a) => Value::Array(a.into_iter().map(normalise).collect()),
        Value::Object(o) => Value::Object(
            o.into_iter()
                .map(|(k, v)| (k.nfc().collect(), normalise(v)))
                .collect(),
        ),
        // Map keys that are tuples serialise as arrays inside strings only for JSON objects; everything else is kept.
        other => other,
    }
}

/* ------------------------------------------------------------------ replica */

/// Why an entry was not taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// Signed by a device that is not in the account's list.
    UnknownDevice,
    /// The device was caught writing two different entries under one number; it must be linked again.
    Frozen,
    BadSignature,
    Malformed,
    TooLarge,
    /// Proof of a cloned or forked device: this entry conflicts with one already held.
    Clone,
    /// Too much is already waiting for gaps to fill; it will be asked for again later.
    PendingFull,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Applied (with any held-back entries it unblocked).
    Applied,
    /// Already held.
    Duplicate,
    /// Held back until the entries before it arrive.
    Pending,
    /// Taken into the log, but it made no sense and changed nothing.
    Quarantined(&'static str),
    Refused(Refused),
}

#[derive(Debug, Clone, Default)]
struct Stream {
    have: u64,
    last_hash: String,
    pending: BTreeMap<u64, Entry>,
}

/// One device's view of the account's logs and their merged state.
#[derive(Debug, Clone)]
pub struct Replica {
    devices: DeviceList,
    streams: BTreeMap<(String, u32), Stream>,
    frozen: BTreeSet<String>,
    // ponytail: the log is kept in memory here; the engine keeps it in its database.
    log: BTreeMap<(String, u32, u64), Entry>,
    hashes: BTreeMap<(String, u32, u64), String>,
    quarantined: Vec<(String, &'static str)>,
    pending_total: usize,
    state: State,
    /// The latest clock reading seen, for this device's own writer.
    pub clock: Hlc,
}

/// How far each device's log a replica holds: "device/series" → highest number held with no gap before it.
pub type Summary = BTreeMap<String, u64>;

impl Replica {
    /// `devices` must already be verified against the account.
    pub fn new(devices: DeviceList) -> Self {
        Self {
            devices,
            streams: BTreeMap::new(),
            frozen: BTreeSet::new(),
            log: BTreeMap::new(),
            hashes: BTreeMap::new(),
            quarantined: Vec::new(),
            pending_total: 0,
            state: State::default(),
            clock: Hlc::default(),
        }
    }

    /// A newer device list (already checked with [`DeviceList::accepts`]).
    pub fn set_devices(&mut self, devices: DeviceList) {
        self.devices = devices;
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    pub fn quarantined(&self) -> &[(String, &'static str)] {
        &self.quarantined
    }

    pub fn is_frozen(&self, device: &str) -> bool {
        self.frozen.contains(device)
    }

    /// Takes an entry from anywhere: this device's own writer, another device, a relay.
    pub fn receive(&mut self, e: Entry, now: i64) -> Outcome {
        if let Err(r) = self.check(&e) {
            return Outcome::Refused(r);
        }
        let key = (e.device.clone(), e.series);
        let hash = e.hash();
        let stream = self.streams.entry(key.clone()).or_default();
        if e.seq <= stream.have {
            return if self.hashes.get(&(key.0.clone(), key.1, e.seq)) == Some(&hash) {
                Outcome::Duplicate
            } else {
                self.freeze(&e.device)
            };
        }
        if let Some(waiting) = stream.pending.get(&e.seq) {
            return if waiting.hash() == hash {
                Outcome::Duplicate
            } else {
                self.freeze(&e.device)
            };
        }
        if e.seq > stream.have + 1 {
            if stream.pending.len() >= MAX_PENDING_PER_STREAM
                || self.pending_total >= MAX_PENDING_TOTAL
            {
                return Outcome::Refused(Refused::PendingFull);
            }
            stream.pending.insert(e.seq, e);
            self.pending_total += 1;
            return Outcome::Pending;
        }
        let first = self.take(e, hash, now);
        // Entries that were waiting for this one.
        loop {
            let stream = self.streams.entry(key.clone()).or_default();
            let next = stream.have + 1;
            let Some(e) = stream.pending.remove(&next) else {
                break;
            };
            self.pending_total -= 1;
            let h = e.hash();
            if let Outcome::Refused(_) = self.take(e, h, now) {
                // A held-back entry that does not chain on is a fork: the device is frozen by `take`.
                break;
            }
        }
        first
    }

    fn check(&self, e: &Entry) -> Result<(), Refused> {
        if self.frozen.contains(&e.device) {
            return Err(Refused::Frozen);
        }
        if e.seq == 0 || e.kind.is_empty() || e.kind.len() > 64 || e.device.len() > 64 {
            return Err(Refused::Malformed);
        }
        if serde_json::to_vec(&e.body)
            .map(|b| b.len())
            .unwrap_or(usize::MAX)
            > MAX_BODY_BYTES
        {
            return Err(Refused::TooLarge);
        }
        let device = self.devices.get(&e.device).ok_or(Refused::UnknownDevice)?;
        let sig = codec::decode(&e.sig).ok_or(Refused::BadSignature)?;
        let payload = e.signed_bytes().map_err(|_| Refused::Malformed)?;
        if !verify_signature(&device.sign, &sig, &payload) {
            return Err(Refused::BadSignature);
        }
        Ok(())
    }

    /// Applies the next entry of a stream.
    fn take(&mut self, e: Entry, hash: String, now: i64) -> Outcome {
        let key = (e.device.clone(), e.series);
        let stream = self.streams.entry(key.clone()).or_default();
        if e.prev != stream.last_hash {
            // Signed by the device, numbered right, but not the entry we hold before it: two histories.
            return self.freeze(&e.device);
        }
        stream.have = e.seq;
        stream.last_hash = hash.clone();
        self.clock = self.clock.observe(e.hlc, now);
        let result = self.state.apply(&e, &hash);
        self.hashes
            .insert((key.0.clone(), key.1, e.seq), hash.clone());
        self.log.insert((key.0, key.1, e.seq), e);
        match result {
            Ok(()) => Outcome::Applied,
            Err(reason) => {
                self.quarantined.push((hash, reason));
                Outcome::Quarantined(reason)
            }
        }
    }

    fn freeze(&mut self, device: &str) -> Outcome {
        self.frozen.insert(device.to_owned());
        // Whatever it had waiting goes too.
        for ((d, _), s) in self.streams.iter_mut() {
            if d == device {
                self.pending_total -= s.pending.len();
                s.pending.clear();
            }
        }
        Outcome::Refused(Refused::Clone)
    }

    /// How far this replica has every device's log.
    pub fn summary(&self) -> Summary {
        self.streams
            .iter()
            .filter(|(_, s)| s.have > 0)
            .map(|((d, series), s)| (format!("{d}/{series}"), s.have))
            .collect()
    }

    /// Entries this replica holds that a replica with summary `theirs` is missing, oldest first per stream.
    pub fn missing_for(&self, theirs: &Summary, limit: usize) -> Vec<Entry> {
        let mut out = Vec::new();
        for ((d, series), s) in &self.streams {
            let from = theirs.get(&format!("{d}/{series}")).copied().unwrap_or(0) + 1;
            for seq in from..=s.have {
                if out.len() >= limit {
                    return out;
                }
                if let Some(e) = self.log.get(&(d.clone(), *series, seq)) {
                    out.push(e.clone());
                }
            }
        }
        out
    }

    /// Every entry held, for a device catching up from nothing.
    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.log.values()
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;
    use crate::devices::DeviceEntry;
    use crate::rng::OsEntropy;

    struct Device {
        key: Identity,
        writer: Writer,
        replica: Replica,
    }

    /// An account with `n` devices, each with a writer and a replica.
    fn account(n: usize) -> (Identity, Vec<Device>, DeviceList) {
        let account = Identity::generate(&mut OsEntropy).unwrap();
        let keys: Vec<Identity> = (0..n)
            .map(|_| Identity::generate(&mut OsEntropy).unwrap())
            .collect();
        let mut list = DeviceList::first(&account, &keys[0], "D0", 1).unwrap();
        for (i, k) in keys.iter().enumerate().skip(1) {
            list = list
                .with_added(&account, DeviceEntry::new(k, &format!("D{i}"), 1).unwrap())
                .unwrap();
        }
        let devices = keys
            .into_iter()
            .map(|key| {
                let id = crate::devices::device_id(&key.sign_public(), &key.dh_public()).unwrap();
                Device {
                    writer: Writer::new(&id, 1),
                    key,
                    replica: Replica::new(list.clone()),
                }
            })
            .collect();
        (account, devices, list)
    }

    fn write(d: &mut Device, kind: &str, body: Value, now: i64) -> Entry {
        d.writer.observe(d.replica.clock, now);
        let e = d.writer.append(&d.key, kind, body, now).unwrap();
        assert_eq!(d.replica.receive(e.clone(), now), Outcome::Applied);
        e
    }

    /// Writes an entry without applying it anywhere.
    fn raw(d: &mut Device, kind: &str, body: Value, now: i64) -> Entry {
        d.writer.append(&d.key, kind, body, now).unwrap()
    }

    /// A tiny deterministic generator, so a failing run can be replayed from its seed.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    #[test]
    fn entries_apply_in_order_even_when_they_arrive_out_of_order() {
        let (_, mut ds, list) = account(2);
        let a: Vec<Entry> = (0..5)
            .map(|i| {
                write(
                    &mut ds[0],
                    kind::MESSAGE,
                    json!({"id": format!("m{i}"), "conv": "c", "text": format!("t{i}")}),
                    10 + i,
                )
            })
            .collect();
        let mut r = Replica::new(list);
        assert_eq!(r.receive(a[3].clone(), 100), Outcome::Pending);
        assert_eq!(r.receive(a[1].clone(), 100), Outcome::Pending);
        assert_eq!(r.state().conversation("c"), vec![]);
        assert_eq!(r.receive(a[0].clone(), 100), Outcome::Applied);
        assert_eq!(r.state().conversation("c").len(), 2);
        assert_eq!(r.receive(a[2].clone(), 100), Outcome::Applied);
        assert_eq!(r.receive(a[4].clone(), 100), Outcome::Applied);
        assert_eq!(r.receive(a[2].clone(), 100), Outcome::Duplicate);
        let texts: Vec<String> = r
            .state()
            .conversation("c")
            .into_iter()
            .map(|(_, t)| t)
            .collect();
        assert_eq!(texts, ["t0", "t1", "t2", "t3", "t4"]);
        assert_eq!(r.state().fingerprint(), ds[0].replica.state().fingerprint());
    }

    #[test]
    fn strangers_forgeries_and_tampering_are_refused() {
        let (_, mut ds, list) = account(1);
        let e = write(
            &mut ds[0],
            kind::MESSAGE,
            json!({"id": "m", "conv": "c", "text": "hi"}),
            1,
        );
        let mut r = Replica::new(list.clone());

        let mut changed = e.clone();
        changed.body = json!({"id": "m", "conv": "c", "text": "send money"});
        assert_eq!(
            r.receive(changed, 2),
            Outcome::Refused(Refused::BadSignature)
        );

        let stranger = Identity::generate(&mut OsEntropy).unwrap();
        let sid =
            crate::devices::device_id(&stranger.sign_public(), &stranger.dh_public()).unwrap();
        let fake = Writer::new(&sid, 1)
            .append(&stranger, kind::MESSAGE, json!({"id": "x", "conv": "c"}), 1)
            .unwrap();
        assert_eq!(r.receive(fake, 2), Outcome::Refused(Refused::UnknownDevice));

        // Signed by a stranger but claiming to be our device.
        let mut claimed = Writer::new(&ds[0].writer.device, 1)
            .append(&stranger, kind::MESSAGE, json!({"id": "y", "conv": "c"}), 1)
            .unwrap();
        assert_eq!(
            r.receive(claimed.clone(), 2),
            Outcome::Refused(Refused::BadSignature)
        );
        claimed.seq = 0;
        assert!(matches!(r.receive(claimed, 2), Outcome::Refused(_)));

        assert_eq!(r.receive(e, 2), Outcome::Applied);
    }

    #[test]
    fn a_cloned_device_is_caught_and_frozen() {
        let (_, mut ds, list) = account(2);
        // A copy of device 0's install (same keys, same counter) writes its own entry 1.
        let mut clone = ds[0].writer.clone();
        let original = write(
            &mut ds[0],
            kind::MESSAGE,
            json!({"id": "a", "conv": "c", "text": "real"}),
            1,
        );
        let copy = clone
            .append(
                &ds[0].key,
                kind::MESSAGE,
                json!({"id": "b", "conv": "c", "text": "copy"}),
                1,
            )
            .unwrap();

        let mut r = Replica::new(list);
        assert_eq!(r.receive(original, 2), Outcome::Applied);
        assert_eq!(r.receive(copy, 2), Outcome::Refused(Refused::Clone));
        assert!(r.is_frozen(&ds[0].writer.device));
        let later = write(
            &mut ds[0],
            kind::MESSAGE,
            json!({"id": "z", "conv": "c"}),
            3,
        );
        assert_eq!(r.receive(later, 4), Outcome::Refused(Refused::Frozen));
        // Other devices are unaffected.
        let other = write(
            &mut ds[1],
            kind::MESSAGE,
            json!({"id": "o", "conv": "c"}),
            3,
        );
        assert_eq!(r.receive(other, 4), Outcome::Applied);
    }

    #[test]
    fn a_fork_found_among_held_back_entries_freezes_the_device() {
        let (_, mut ds, list) = account(1);
        let e1 = write(
            &mut ds[0],
            kind::MESSAGE,
            json!({"id": "1", "conv": "c"}),
            1,
        );
        let mut fork = ds[0].writer.clone();
        let e2 = write(
            &mut ds[0],
            kind::MESSAGE,
            json!({"id": "2", "conv": "c"}),
            2,
        );
        let _ = e2;
        // A different entry 2 (another history), and an entry 3 built on it.
        let f2 = fork
            .append(
                &ds[0].key,
                kind::MESSAGE,
                json!({"id": "2x", "conv": "c"}),
                2,
            )
            .unwrap();
        let f3 = fork
            .append(
                &ds[0].key,
                kind::MESSAGE,
                json!({"id": "3x", "conv": "c"}),
                3,
            )
            .unwrap();
        let mut r = Replica::new(list);
        assert_eq!(r.receive(f3, 5), Outcome::Pending);
        assert_eq!(r.receive(e1, 5), Outcome::Applied);
        assert_eq!(r.receive(f2, 5), Outcome::Applied);
        // Now the real entry 2 shows up: the device signed two different second entries.
        let real2 = ds[0]
            .replica
            .entries()
            .find(|e| e.seq == 2)
            .unwrap()
            .clone();
        assert_eq!(r.receive(real2, 5), Outcome::Refused(Refused::Clone));
        assert!(r.is_frozen(&ds[0].writer.device));
    }

    #[test]
    fn a_bad_entry_is_quarantined_and_the_log_goes_on() {
        let (_, mut ds, list) = account(1);
        let bad = raw(&mut ds[0], kind::REACT, json!({"target": "m"}), 1);
        let good = raw(
            &mut ds[0],
            kind::MESSAGE,
            json!({"id": "m", "conv": "c", "text": "after"}),
            2,
        );
        let mut r = Replica::new(list);
        assert_eq!(r.receive(bad, 3), Outcome::Quarantined("missing field"));
        assert_eq!(r.receive(good, 3), Outcome::Applied);
        assert_eq!(r.state().conversation("c").len(), 1);
        assert_eq!(r.quarantined().len(), 1);
    }

    #[test]
    fn unknown_kinds_are_kept_and_passed_on_unchanged() {
        let (_, mut ds, list) = account(2);
        let future = raw(
            &mut ds[0],
            "poll",
            json!({"question": "lunch?", "options": ["a", "b"]}),
            1,
        );
        let mut r = Replica::new(list.clone());
        assert_eq!(r.receive(future.clone(), 2), Outcome::Applied);
        // Passed on to a third replica byte for byte, and it still verifies there.
        let forwarded: Vec<Entry> = r.missing_for(&Summary::new(), 10);
        assert_eq!(forwarded, vec![future.clone()]);
        let mut third = Replica::new(list);
        assert_eq!(
            third.receive(Entry::from_json(&forwarded[0].to_json()).unwrap(), 3),
            Outcome::Applied
        );
        assert_eq!(third.entries().next().unwrap().hash(), future.hash());
    }

    #[test]
    fn delete_beats_edit_reactions_wait_for_their_message_and_read_marks_only_move_forward() {
        let (_, mut ds, list) = account(2);
        let msg = write(
            &mut ds[0],
            kind::MESSAGE,
            json!({"id": "m", "conv": "c", "text": "hello"}),
            1,
        );
        let react = write(
            &mut ds[1],
            kind::REACT,
            json!({"target": "m", "by": "me", "emoji": "👍"}),
            2,
        );
        let edit = write(
            &mut ds[1],
            kind::EDIT,
            json!({"target": "m", "text": "hello!"}),
            3,
        );
        let read_late = write(
            &mut ds[0],
            kind::READ,
            json!({"conv": "c", "upto": {"wall": 50, "count": 0}}),
            4,
        );
        let read_early = write(
            &mut ds[1],
            kind::READ,
            json!({"conv": "c", "upto": {"wall": 20, "count": 0}}),
            5,
        );
        let delete = write(&mut ds[0], kind::DELETE, json!({"target": "m"}), 6);

        let mut r = Replica::new(list);
        // The reaction and the edit arrive before the message.
        for e in [react.clone(), edit.clone()] {
            assert_eq!(r.receive(e, 9), Outcome::Applied);
        }
        assert!(r.state().reactions("m").is_empty());
        assert_eq!(r.receive(msg, 9), Outcome::Applied);
        assert_eq!(
            r.state().reactions("m").get("me").map(String::as_str),
            Some("👍")
        );
        assert_eq!(
            r.state().conversation("c"),
            vec![("m".to_owned(), "hello!".to_owned())]
        );
        for e in [read_late, read_early] {
            r.receive(e, 9);
        }
        assert_eq!(r.state().read_upto("c"), Some(Hlc { wall: 50, count: 0 }));
        assert_eq!(r.receive(delete, 9), Outcome::Applied);
        assert!(r.state().conversation("c").is_empty());
        assert!(r.state().reactions("m").is_empty());
    }

    #[test]
    fn a_clock_far_in_the_future_does_not_drag_the_others_along() {
        let c = Hlc::default().observe(
            Hlc {
                wall: 10_000_000_000,
                count: 0,
            },
            1_000,
        );
        assert_eq!(c.wall, 1_000 + MAX_FUTURE_MS);
        let t = Hlc { wall: 5, count: 3 };
        assert_eq!(t.tick(5), Hlc { wall: 5, count: 4 });
        assert_eq!(t.tick(9), Hlc { wall: 9, count: 0 });
        assert_eq!(t.tick(1), Hlc { wall: 5, count: 4 }, "never backwards");
    }

    #[test]
    fn the_fingerprint_ignores_how_text_was_encoded() {
        let (_, mut ds, list) = account(2);
        // "é" as one code point on one device, as e + accent on the other.
        write(
            &mut ds[0],
            kind::SETTING,
            json!({"key": "nick:a", "value": "Ren\u{e9}"}),
            1,
        );
        let mut a = Replica::new(list.clone());
        let mut b = Replica::new(list);
        a.receive(ds[0].replica.entries().next().unwrap().clone(), 2);
        let mut state_b = a.state().clone();
        state_b.settings.get_mut("nick:a").unwrap().value = json!("Rene\u{301}");
        assert_eq!(a.state().fingerprint(), state_b.fingerprint());
        b.receive(ds[0].replica.entries().next().unwrap().clone(), 2);
        assert_eq!(a.state().fingerprint(), b.state().fingerprint());
    }

    #[test]
    fn summaries_tell_each_side_exactly_what_the_other_is_missing() {
        let (_, mut ds, _) = account(2);
        for i in 0..4 {
            write(
                &mut ds[0],
                kind::MESSAGE,
                json!({"id": format!("a{i}"), "conv": "c"}),
                i,
            );
        }
        for i in 0..3 {
            write(
                &mut ds[1],
                kind::MESSAGE,
                json!({"id": format!("b{i}"), "conv": "c"}),
                i,
            );
        }
        let (left, right) = ds.split_at_mut(1);
        let (a, b) = (&mut left[0], &mut right[0]);
        let for_b = a.replica.missing_for(&b.replica.summary(), 100);
        let for_a = b.replica.missing_for(&a.replica.summary(), 100);
        assert_eq!((for_b.len(), for_a.len()), (4, 3));
        for e in for_b {
            assert_eq!(b.replica.receive(e, 10), Outcome::Applied);
        }
        for e in for_a {
            assert_eq!(a.replica.receive(e, 10), Outcome::Applied);
        }
        assert_eq!(a.replica.summary(), b.replica.summary());
        assert_eq!(
            a.replica.state().fingerprint(),
            b.replica.state().fingerprint()
        );
        assert!(a.replica.missing_for(&b.replica.summary(), 100).is_empty());
    }

    /// Many devices doing many things at once, every entry delivered to every replica in a random order, some twice,
    /// with partial syncs between devices along the way: every replica ends in the same state (risk 10).
    #[test]
    fn replicas_converge_whatever_the_order() {
        for seed in 1..=40u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
            let (_, mut ds, list) = account(3);
            let mut all: Vec<Entry> = Vec::new();
            let mut now = 1_000i64;
            for step in 0..120 {
                now += rng.below(3) as i64;
                let who = rng.below(ds.len());
                let target = format!("m{}", rng.below(step + 1));
                let (k, body) = match rng.below(7) {
                    0 | 1 => (
                        kind::MESSAGE,
                        json!({"id": format!("m{step}"), "conv": format!("c{}", rng.below(2)), "text": format!("t{step}")}),
                    ),
                    2 => (
                        kind::EDIT,
                        json!({"target": target, "text": format!("e{step}")}),
                    ),
                    3 => (kind::DELETE, json!({"target": target})),
                    4 => (
                        kind::REACT,
                        json!({"target": target, "by": format!("u{}", rng.below(3)), "emoji": if rng.below(4) == 0 { Value::Null } else { json!("❤") }}),
                    ),
                    5 => (
                        kind::READ,
                        json!({"conv": "c0", "upto": {"wall": now - rng.below(50) as i64, "count": 0}}),
                    ),
                    _ => (
                        kind::SETTING,
                        json!({"key": format!("mute:{}", rng.below(3)), "value": rng.below(2) == 0}),
                    ),
                };
                all.push(write(&mut ds[who], k, body, now));
                // Now and then two devices sync with each other part of the way.
                if rng.below(5) == 0 {
                    let (x, y) = (rng.below(ds.len()), rng.below(ds.len()));
                    if x != y {
                        let summary = ds[y].replica.summary();
                        let give = ds[x].replica.missing_for(&summary, rng.below(10) + 1);
                        for e in give {
                            ds[y].replica.receive(e, now);
                        }
                    }
                }
            }
            // Finally every replica gets everything, shuffled, with duplicates.
            let mut expected: Option<String> = None;
            for d in ds.iter_mut() {
                let mut mixed = all.clone();
                mixed.extend(all.iter().take(rng.below(all.len())).cloned());
                for i in (1..mixed.len()).rev() {
                    mixed.swap(i, rng.below(i + 1));
                }
                for e in mixed {
                    assert!(
                        !matches!(
                            d.replica.receive(e, now),
                            Outcome::Refused(_) | Outcome::Quarantined(_)
                        ),
                        "seed {seed}"
                    );
                }
                assert_eq!(
                    d.replica.summary().values().sum::<u64>(),
                    all.len() as u64,
                    "seed {seed}"
                );
                let fp = d.replica.state().fingerprint();
                assert_eq!(expected.get_or_insert(fp.clone()), &fp, "seed {seed}");
            }
            let mut fresh = Replica::new(list);
            for e in all.iter().rev() {
                fresh.receive(e.clone(), now);
            }
            assert_eq!(Some(fresh.state().fingerprint()), expected, "seed {seed}");
        }
    }
}
