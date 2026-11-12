//! Group membership as a signed event log (`groups/events.ts`, `groups/log.ts`).
//!
//! A group is a set of signed events (create, add, remove, rename) that name the events they were written after
//! (`deps`). Every device collects the same events and *folds* them in the same deterministic order, so every device
//! reaches the same member list without a server. Events that arrive before the events they depend on wait in a bounded
//! buffer. An event that was not signed by a current member, or breaks a rule (only admins remove others, at most 10
//! members), simply has no effect, on every device alike.

use crate::{
    canonical::canonical_json,
    card::ContactCard,
    error::CryptoError,
    identity::{uid_from_dh, verify_identity_proof, verify_signature, Identity},
    kdf::sha256_hex,
};
use privcord_domain::{
    blob::PublicJwk,
    codec,
    limits::MAX_GROUP_MEMBERS,
    text::{cmp_utf16, utf16_len},
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub const MAX_GROUP_NAME: usize = 60;
pub const MAX_EVENTS_PER_GROUP: usize = 5000;
pub const MAX_PENDING_EVENTS: usize = 300;
const MAX_DEPS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventType {
    Create,
    Add,
    Remove,
    Rename,
}

impl EventType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Add => "add",
            Self::Remove => "remove",
            Self::Rename => "rename",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "create" => Self::Create,
            "add" => Self::Add,
            "remove" => Self::Remove,
            "rename" => Self::Rename,
            _ => return None,
        })
    }
}

/// One signed event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupEvent {
    pub event_id: String,
    pub group_id: String,
    pub kind: EventType,
    pub actor: String,
    pub ts: i64,
    pub deps: Vec<String>,
    pub target: Option<String>,
    pub card: Option<ContactCard>,
    pub name: Option<String>,
    pub sig: String,
}

fn card_body(c: &ContactCard) -> Value {
    let mut o = Map::new();
    o.insert("v".into(), json!(1));
    o.insert("sign".into(), json!(c.sign));
    o.insert("dh".into(), json!(c.dh));
    o.insert("proof".into(), json!(c.proof));
    if let Some(n) = &c.name {
        o.insert("name".into(), json!(n));
    }
    Value::Object(o)
}

/// The text that is hashed and signed: canonical JSON of every field but the id and signature, with `deps` sorted.
fn body(e: &GroupEvent, group_id: &str) -> Result<String, CryptoError> {
    let mut deps = e.deps.clone();
    deps.sort_by(|a, b| cmp_utf16(a, b));
    let mut o = Map::new();
    o.insert("v".into(), json!(1));
    o.insert("kind".into(), json!("group_event"));
    o.insert("groupId".into(), json!(group_id));
    o.insert("type".into(), json!(e.kind.as_str()));
    o.insert("actor".into(), json!(e.actor));
    o.insert("ts".into(), json!(e.ts));
    o.insert("deps".into(), json!(deps));
    if let Some(t) = &e.target {
        o.insert("target".into(), json!(t));
    }
    if let Some(c) = &e.card {
        o.insert("card".into(), card_body(c));
    }
    if let Some(n) = &e.name {
        o.insert("name".into(), json!(n));
    }
    canonical_json(&Value::Object(o))
}

fn event_id(e: &GroupEvent, group_id: &str) -> Result<String, CryptoError> {
    Ok(sha256_hex(body(e, group_id)?.as_bytes()))
}

/// What the signature covers: the body, and for a `create` also the event id (which is the group id).
fn signed_text(e: &GroupEvent) -> Result<Vec<u8>, CryptoError> {
    let b = body(e, &e.group_id)?;
    Ok(if e.kind == EventType::Create {
        format!("{b}|{}", e.event_id)
    } else {
        b
    }
    .into_bytes())
}

/// What to write.
#[derive(Debug, Clone)]
pub struct NewEvent {
    pub group_id: String,
    pub kind: EventType,
    pub actor: String,
    pub ts: i64,
    pub deps: Vec<String>,
    pub target: Option<String>,
    pub card: Option<ContactCard>,
    pub name: Option<String>,
}

/// Sign an event as `identity`. A `create` event's id becomes the group id.
pub fn sign_group_event(identity: &Identity, new: NewEvent) -> Result<GroupEvent, CryptoError> {
    let mut deps = new.deps;
    deps.sort_by(|a, b| cmp_utf16(a, b));
    let mut e = GroupEvent {
        event_id: String::new(),
        group_id: if new.kind == EventType::Create {
            String::new()
        } else {
            new.group_id
        },
        kind: new.kind,
        actor: new.actor,
        ts: new.ts,
        deps,
        target: new.target,
        card: new.card,
        name: new.name,
        sig: String::new(),
    };
    e.event_id = event_id(&e, &e.group_id)?;
    if e.kind == EventType::Create {
        e.group_id = e.event_id.clone();
    }
    e.sig = codec::encode(&identity.sign_message(&signed_text(&e)?));
    Ok(e)
}

impl GroupEvent {
    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("v".into(), json!(1));
        o.insert("kind".into(), json!("group_event"));
        o.insert("eventId".into(), json!(self.event_id));
        o.insert("groupId".into(), json!(self.group_id));
        o.insert("type".into(), json!(self.kind.as_str()));
        o.insert("actor".into(), json!(self.actor));
        o.insert("ts".into(), json!(self.ts));
        o.insert("deps".into(), json!(self.deps));
        if let Some(t) = &self.target {
            o.insert("target".into(), json!(t));
        }
        if let Some(c) = &self.card {
            o.insert("card".into(), card_body(c));
        }
        if let Some(n) = &self.name {
            o.insert("name".into(), json!(n));
        }
        o.insert("sig".into(), json!(self.sig));
        Value::Object(o)
    }

    /// The same shape test `isGroupEventShape` applies, plus a whole-number timestamp. `None` if anything is off.
    pub fn from_value(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        if o.get("v")?.as_u64()? != 1 || o.get("kind")?.as_str()? != "group_event" {
            return None;
        }
        let event_id = o.get("eventId")?.as_str()?;
        if event_id.len() != 64
            || !event_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return None;
        }
        let group_id = o.get("groupId")?.as_str()?.to_owned();
        let actor = o.get("actor")?.as_str()?.to_owned();
        if actor.is_empty() {
            return None;
        }
        let kind = EventType::parse(o.get("type")?.as_str()?)?;
        let ts = privcord_domain::message::parse_timestamp_any(o.get("ts")?)?;
        let deps_v = o.get("deps")?.as_array()?;
        if deps_v.len() > MAX_DEPS {
            return None;
        }
        let deps: Vec<String> = deps_v
            .iter()
            .map(|d| d.as_str().map(str::to_owned))
            .collect::<Option<_>>()?;
        let target = match o.get("target") {
            None => None,
            Some(t) => Some(t.as_str()?.to_owned()),
        };
        let name = match o.get("name") {
            None => None,
            Some(n) => {
                let n = n.as_str()?;
                if n.is_empty() || utf16_len(n) > MAX_GROUP_NAME {
                    return None;
                }
                Some(n.to_owned())
            }
        };
        let sig = o.get("sig")?.as_str()?.to_owned();
        let card = match o.get("card") {
            None => None,
            Some(c) => Some(card_from_value(c)?),
        };
        if matches!(kind, EventType::Add | EventType::Remove)
            && target.as_deref().is_none_or(str::is_empty)
        {
            return None;
        }
        if matches!(kind, EventType::Create | EventType::Add) && card.is_none() {
            return None;
        }
        if matches!(kind, EventType::Create | EventType::Rename) && name.is_none() {
            return None;
        }
        Some(Self {
            event_id: event_id.to_owned(),
            group_id,
            kind,
            actor,
            ts,
            deps,
            target,
            card,
            name,
            sig,
        })
    }
}

/// A card as it appears inside an event: shape only here; the proof is checked when the event is folded.
fn card_from_value(v: &Value) -> Option<ContactCard> {
    let o = v.as_object()?;
    if o.get("v")?.as_u64()? != 1 {
        return None;
    }
    Some(ContactCard {
        sign: PublicJwk::from_value(o.get("sign")?)?,
        dh: PublicJwk::from_value(o.get("dh")?)?,
        proof: o.get("proof")?.as_str()?.to_owned(),
        name: match o.get("name") {
            None => None,
            Some(n) => Some(n.as_str()?.to_owned()),
        },
    })
}

fn card_is_valid(card: &ContactCard, expected_uid: &str) -> bool {
    verify_identity_proof(&card.sign, &card.dh, &card.proof)
        && uid_from_dh(&card.dh).is_ok_and(|u| u.as_str() == expected_uid)
}

fn signature_valid(e: &GroupEvent, signer: &PublicJwk) -> bool {
    let (Some(sig), Ok(text)) = (codec::decode(&e.sig), signed_text(e)) else {
        return false;
    };
    verify_signature(signer, &sig, &text)
}

fn id_matches(e: &GroupEvent) -> bool {
    let group_id = if e.kind == EventType::Create {
        ""
    } else {
        e.group_id.as_str()
    };
    event_id(e, group_id)
        .is_ok_and(|id| id == e.event_id && (e.kind != EventType::Create || e.group_id == id))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddStatus {
    Applied,
    Buffered,
    Duplicate,
    Invalid,
}

impl AddStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Buffered => "buffered",
            Self::Duplicate => "duplicate",
            Self::Invalid => "invalid",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Admin,
    Member,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub uid: String,
    pub card: ContactCard,
    pub role: Role,
    pub added_by: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupState {
    pub group_id: String,
    pub name: String,
    pub created_by: String,
    pub members: BTreeMap<String, Member>,
}

/// All the events of one group and the state they fold to.
#[derive(Debug)]
pub struct GroupLog {
    group_id: String,
    events: HashMap<String, GroupEvent>,
    pending: HashMap<String, GroupEvent>,
    sig_cache: HashMap<(String, String), bool>,
    current: Option<GroupState>,
    valid: BTreeSet<String>,
}

impl GroupLog {
    pub fn new(group_id: &str) -> Self {
        Self {
            group_id: group_id.to_owned(),
            events: HashMap::new(),
            pending: HashMap::new(),
            sig_cache: HashMap::new(),
            current: None,
            valid: BTreeSet::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
    pub fn state(&self) -> Option<&GroupState> {
        self.current.as_ref()
    }
    pub fn has(&self, id: &str) -> bool {
        self.events.contains_key(id)
    }
    /// Did this event take effect (was it allowed), as opposed to merely being stored?
    pub fn is_effective(&self, id: &str) -> bool {
        self.valid.contains(id)
    }

    /// Events nobody has built on yet.
    pub fn heads(&self) -> Vec<String> {
        let referenced: BTreeSet<&String> =
            self.events.values().flat_map(|e| e.deps.iter()).collect();
        let mut out: Vec<String> = self
            .events
            .keys()
            .filter(|id| !referenced.contains(id))
            .cloned()
            .collect();
        out.sort_by(|a, b| cmp_utf16(a, b));
        out
    }

    pub fn all(&self) -> Vec<GroupEvent> {
        self.order()
    }

    /// What we have that they do not (given the ids they have).
    pub fn missing_for<'a>(&self, theirs: impl IntoIterator<Item = &'a str>) -> Vec<GroupEvent> {
        let have: BTreeSet<&str> = theirs.into_iter().collect();
        self.order()
            .into_iter()
            .filter(|e| !have.contains(e.event_id.as_str()))
            .collect()
    }

    /// Events waiting on others that we do not have yet.
    pub fn missing_deps(&self) -> Vec<String> {
        let mut out = BTreeSet::new();
        for e in self.pending.values() {
            for d in &e.deps {
                if !self.events.contains_key(d) && !self.pending.contains_key(d) {
                    out.insert(d.clone());
                }
            }
        }
        out.into_iter().collect()
    }

    pub fn add(&mut self, event: &Value) -> AddStatus {
        let Some(e) = GroupEvent::from_value(event) else {
            return AddStatus::Invalid;
        };
        if e.group_id != self.group_id {
            return AddStatus::Invalid;
        }
        if let Some(stored) = self.events.get(&e.event_id) {
            // The id does not cover the signature: a copy with a broken signature, relayed first by anyone, must not
            // shadow the genuine one forever. Take another copy of an event that had no effect if it then takes effect.
            if stored.sig == e.sig || self.valid.contains(&e.event_id) || !id_matches(&e) {
                return AddStatus::Duplicate;
            }
            let id = e.event_id.clone();
            let old = self.events.insert(id.clone(), e);
            self.refold();
            if self.valid.contains(&id) {
                return AddStatus::Applied;
            }
            if let Some(old) = old {
                self.events.insert(id, old);
            }
            self.refold();
            return AddStatus::Duplicate;
        }
        if self.pending.contains_key(&e.event_id) {
            return AddStatus::Duplicate;
        }
        if !id_matches(&e) {
            return AddStatus::Invalid;
        }
        if self.events.len() >= MAX_EVENTS_PER_GROUP {
            return AddStatus::Invalid;
        }
        if e.kind != EventType::Create && e.deps.is_empty() {
            return AddStatus::Invalid;
        }
        if e.deps.iter().any(|d| !self.events.contains_key(d)) {
            if self.pending.len() >= MAX_PENDING_EVENTS {
                return AddStatus::Invalid;
            }
            self.pending.insert(e.event_id.clone(), e);
            return AddStatus::Buffered;
        }
        self.events.insert(e.event_id.clone(), e);
        self.drain_pending();
        self.refold();
        AddStatus::Applied
    }

    fn drain_pending(&mut self) {
        loop {
            let ready: Vec<String> = self
                .pending
                .iter()
                .filter(|(_, e)| e.deps.iter().all(|d| self.events.contains_key(d)))
                .map(|(id, _)| id.clone())
                .collect();
            if ready.is_empty() {
                return;
            }
            for id in ready {
                if let Some(e) = self.pending.remove(&id) {
                    self.events.insert(id, e);
                }
            }
        }
    }

    /// Dependencies first; among events that could go next, removals before the rest, then by id. Every device
    /// computes the same order, which is what makes the result the same everywhere.
    fn order(&self) -> Vec<GroupEvent> {
        let mut indeg: HashMap<&str, usize> = HashMap::new();
        let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
        for e in self.events.values() {
            indeg.insert(&e.event_id, e.deps.len());
            for d in &e.deps {
                children.entry(d.as_str()).or_default().push(&e.event_id);
            }
        }
        let rank = |id: &str| {
            (
                u8::from(
                    self.events
                        .get(id)
                        .is_none_or(|e| e.kind != EventType::Remove),
                ),
                id.to_owned(),
            )
        };
        let mut ready: Vec<&str> = indeg
            .iter()
            .filter(|(_, n)| **n == 0)
            .map(|(id, _)| *id)
            .collect();
        let mut out = Vec::new();
        while !ready.is_empty() {
            ready.sort_by(|a, b| {
                let (ra, rb) = (rank(a), rank(b));
                ra.0.cmp(&rb.0).then_with(|| cmp_utf16(&ra.1, &rb.1))
            });
            let id = ready.remove(0);
            if let Some(e) = self.events.get(id) {
                out.push(e.clone());
            }
            for c in children.get(id).cloned().unwrap_or_default() {
                if let Some(n) = indeg.get_mut(c) {
                    *n = n.saturating_sub(1);
                    if *n == 0 {
                        ready.push(c);
                    }
                }
            }
        }
        out
    }

    fn verify_sig(&mut self, e: &GroupEvent, signer: &ContactCard) -> bool {
        let key = (
            e.event_id.clone(),
            format!("{}.{}.{}", signer.sign.x, signer.sign.y, e.sig),
        );
        if let Some(hit) = self.sig_cache.get(&key) {
            return *hit;
        }
        let ok = signature_valid(e, &signer.sign);
        self.sig_cache.insert(key, ok);
        ok
    }

    fn refold(&mut self) {
        let mut state: Option<GroupState> = None;
        let mut valid = BTreeSet::new();
        for e in self.order() {
            if e.kind == EventType::Create {
                let Some(card) = e.card.as_ref() else {
                    continue;
                };
                if state.is_some() || !e.deps.is_empty() || e.group_id != e.event_id {
                    continue;
                }
                if !card_is_valid(card, &e.actor) || !self.verify_sig(&e, card) {
                    continue;
                }
                let mut members = BTreeMap::new();
                members.insert(
                    e.actor.clone(),
                    Member {
                        uid: e.actor.clone(),
                        card: card.clone(),
                        role: Role::Admin,
                        added_by: e.actor.clone(),
                    },
                );
                state = Some(GroupState {
                    group_id: e.group_id.clone(),
                    name: e.name.clone().unwrap_or_default(),
                    created_by: e.actor.clone(),
                    members,
                });
                valid.insert(e.event_id.clone());
                continue;
            }
            let Some(s) = state.as_mut() else { continue };
            let Some(author) = s.members.get(&e.actor).cloned() else {
                continue;
            };
            // Borrow juggling: verification needs `self`, so take the state out for the call.
            let ok_sig = {
                let key = (
                    e.event_id.clone(),
                    format!("{}.{}.{}", author.card.sign.x, author.card.sign.y, e.sig),
                );
                match self.sig_cache.get(&key) {
                    Some(hit) => *hit,
                    None => {
                        let ok = signature_valid(&e, &author.card.sign);
                        self.sig_cache.insert(key, ok);
                        ok
                    }
                }
            };
            if !ok_sig {
                continue;
            }
            let target = e.target.clone().unwrap_or_default();
            match e.kind {
                EventType::Add => {
                    let Some(card) = e.card.as_ref() else {
                        continue;
                    };
                    if !card_is_valid(card, &target) {
                        continue;
                    }
                    // Hard size limit. The fold order is deterministic, so every replica drops the same overflow adds.
                    if !s.members.contains_key(&target) && s.members.len() >= MAX_GROUP_MEMBERS {
                        continue;
                    }
                    s.members.entry(target.clone()).or_insert_with(|| Member {
                        uid: target.clone(),
                        card: card.clone(),
                        role: Role::Member,
                        added_by: e.actor.clone(),
                    });
                    valid.insert(e.event_id.clone());
                }
                EventType::Remove => {
                    let self_leave = e.actor == target;
                    if (!self_leave && author.role != Role::Admin)
                        || !s.members.contains_key(&target)
                    {
                        continue;
                    }
                    s.members.remove(&target);
                    valid.insert(e.event_id.clone());
                }
                EventType::Rename => {
                    if author.role != Role::Admin {
                        continue;
                    }
                    s.name = e.name.clone().unwrap_or_default();
                    valid.insert(e.event_id.clone());
                }
                EventType::Create => {}
            }
        }
        self.current = state;
        self.valid = valid;
    }
}
