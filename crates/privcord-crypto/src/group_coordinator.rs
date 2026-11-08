//! Group coordination (`groups/coordinator.ts`): authoring events, deciding whom to tell, syncing history between
//! devices, gossiping news, and checking group messages.
//!
//! The coordinator is a plain state machine: methods take frames in and return the frames to send, plus what changed
//! (groups joined or left, people the user does not know yet). The caller does the sending, so it works over any link.

use crate::{
    card::ContactCard,
    error::CryptoError,
    group::{sign_group_event, AddStatus, EventType, GroupEvent, GroupLog, GroupState, NewEvent},
    identity::{uid_from_dh, Identity},
};
use privcord_domain::{
    blob::SealedBlob,
    ids::MessageId,
    limits::MAX_GROUP_MEMBERS,
    message::{parse_timestamp, validate_incoming_text, ReplyRef},
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_EVENTS_PER_FRAME: usize = 40;
pub const MAX_RELAY_HOPS: u64 = 2;
const MAX_HAVE_GROUPS: usize = 200;
const MAX_HAVE_IDS: usize = 6000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupMessage {
    pub group_id: String,
    pub message_id: MessageId,
    pub text: String,
    pub client_created_at: i64,
    pub reply_to: Option<ReplyRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupFrame {
    /// One new event.
    Push(Box<GroupEvent>),
    /// A batch of events (at most 40).
    Events(Vec<GroupEvent>),
    /// "Here is what I have": ids per group. `full` means this is everything the sender has.
    Have {
        groups: Vec<(String, Vec<String>)>,
        full: bool,
    },
    Message(GroupMessage),
    /// A sealed blob a mutual contact should pass on to someone we cannot reach directly.
    RelayBlob {
        blob: Box<SealedBlob>,
        hops: u64,
    },
}

impl GroupFrame {
    /// `None` for anything that is not a well-formed group frame.
    pub fn parse(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        if o.get("v")?.as_u64()? != 1 {
            return None;
        }
        match o.get("kind")?.as_str()? {
            "group_push" => Some(Self::Push(Box::new(GroupEvent::from_value(
                o.get("event")?,
            )?))),
            "group_events" => {
                let arr = o.get("events")?.as_array()?;
                if arr.len() > MAX_EVENTS_PER_FRAME {
                    return None;
                }
                Some(Self::Events(
                    arr.iter()
                        .map(GroupEvent::from_value)
                        .collect::<Option<_>>()?,
                ))
            }
            "group_have" => {
                let arr = o.get("groups")?.as_array()?;
                if arr.len() > MAX_HAVE_GROUPS {
                    return None;
                }
                let mut groups = Vec::new();
                for g in arr {
                    let go = g.as_object()?;
                    let ids = go.get("ids")?.as_array()?;
                    if ids.len() > MAX_HAVE_IDS {
                        return None;
                    }
                    groups.push((
                        go.get("groupId")?.as_str()?.to_owned(),
                        ids.iter()
                            .map(|i| i.as_str().map(str::to_owned))
                            .collect::<Option<_>>()?,
                    ));
                }
                Some(Self::Have {
                    groups,
                    full: o.get("full") == Some(&Value::Bool(true)),
                })
            }
            "gmsg" => {
                let group_id = o.get("groupId")?.as_str()?.to_owned();
                let message_id = MessageId::new(o.get("messageId")?.as_str()?).ok()?;
                let text = o.get("text")?.as_str()?;
                if !validate_incoming_text(text) {
                    return None;
                }
                let reply_to = match o.get("replyTo") {
                    None => None,
                    Some(r) => Some(ReplyRef::from_value(r)?),
                };
                Some(Self::Message(GroupMessage {
                    group_id,
                    message_id,
                    text: text.to_owned(),
                    client_created_at: parse_timestamp(o.get("clientCreatedAt")?)?,
                    reply_to,
                }))
            }
            "relay_blob" => {
                let hops = o.get("hops")?.as_f64()?;
                if hops.fract() != 0.0 || hops < 0.0 || hops > MAX_RELAY_HOPS as f64 {
                    return None;
                }
                Some(Self::RelayBlob {
                    blob: Box::new(SealedBlob::from_value(o.get("blob")?)?),
                    hops: hops as u64,
                })
            }
            _ => None,
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            Self::Push(e) => json!({ "v": 1, "kind": "group_push", "event": e.to_value() }),
            Self::Events(es) => {
                json!({ "v": 1, "kind": "group_events", "events": es.iter().map(GroupEvent::to_value).collect::<Vec<_>>() })
            }
            Self::Have { groups, full } => {
                let mut o = Map::new();
                o.insert("v".into(), json!(1));
                o.insert("kind".into(), json!("group_have"));
                o.insert(
                    "groups".into(),
                    Value::Array(
                        groups
                            .iter()
                            .map(|(g, ids)| json!({ "groupId": g, "ids": ids }))
                            .collect(),
                    ),
                );
                if *full {
                    o.insert("full".into(), json!(true));
                }
                Value::Object(o)
            }
            Self::Message(m) => {
                let mut o = Map::new();
                o.insert("v".into(), json!(1));
                o.insert("kind".into(), json!("gmsg"));
                o.insert("groupId".into(), json!(m.group_id));
                o.insert("messageId".into(), json!(m.message_id));
                o.insert("text".into(), json!(m.text));
                o.insert("clientCreatedAt".into(), json!(m.client_created_at));
                if let Some(r) = &m.reply_to {
                    o.insert("replyTo".into(), json!(r));
                }
                Value::Object(o)
            }
            Self::RelayBlob { blob, hops } => {
                json!({ "v": 1, "kind": "relay_blob", "blob": blob, "hops": hops })
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingFrame {
    pub to: String,
    pub frame: GroupFrame,
}

/// Someone who is in one of our groups but not in our contacts yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewContact {
    pub card: ContactCard,
    pub uid: String,
    pub introduced_by: String,
    pub group_id: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct GroupResult {
    pub outgoing: Vec<OutgoingFrame>,
    pub changed: Vec<String>,
    pub new_contacts: Vec<NewContact>,
    pub joined: Vec<String>,
    pub left: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageVerdict {
    Ok,
    UnknownGroup,
    NotMember,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum GroupError {
    #[error("You are not a member of this group.")]
    NotMember,
    #[error("That change is not allowed (for example, only an admin can remove other members).")]
    NotAllowed,
    #[error("Already in this group.")]
    AlreadyMember,
    #[error("This group is full ({MAX_GROUP_MEMBERS} members is the limit).")]
    Full,
    #[error("A group can have at most {MAX_GROUP_MEMBERS} members, including you.")]
    TooManyMembers,
    #[error(transparent)]
    Crypto(#[from] CryptoError),
}

/// What the caller knows about people, for deciding whom to believe.
#[allow(missing_debug_implementations)]
pub struct Who<'a> {
    /// Everyone in our contacts.
    pub known: &'a BTreeSet<String>,
    /// If set, only these people may introduce us to a group we are not in yet (instead of any known contact).
    pub trusted: Option<&'a dyn Fn(&str) -> bool>,
}

#[derive(Debug)]
pub struct GroupCoordinator {
    own_uid: String,
    own_card: ContactCard,
    logs: BTreeMap<String, GroupLog>,
}

fn name_cut(name: &str) -> String {
    privcord_domain::text::js_trim(name)
        .chars()
        .take(60)
        .collect()
}

impl GroupCoordinator {
    pub fn new(own_uid: &str, own_card: ContactCard) -> Self {
        Self {
            own_uid: own_uid.to_owned(),
            own_card,
            logs: BTreeMap::new(),
        }
    }

    pub fn group_ids(&self) -> Vec<String> {
        self.logs.keys().cloned().collect()
    }
    pub fn state(&self, group_id: &str) -> Option<&GroupState> {
        self.logs.get(group_id).and_then(GroupLog::state)
    }
    pub fn my_groups(&self) -> Vec<&GroupState> {
        self.logs
            .values()
            .filter_map(GroupLog::state)
            .filter(|s| s.members.contains_key(&self.own_uid))
            .collect()
    }
    pub fn is_member(&self, group_id: &str, uid: &str) -> bool {
        self.state(group_id)
            .is_some_and(|s| s.members.contains_key(uid))
    }
    /// Everyone in the group but us.
    pub fn recipients(&self, group_id: &str) -> Vec<String> {
        self.state(group_id)
            .map(|s| {
                s.members
                    .keys()
                    .filter(|u| **u != self.own_uid)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }
    pub fn event_count(&self, group_id: &str) -> usize {
        self.logs.get(group_id).map_or(0, GroupLog::len)
    }

    /// Every group's events, for saving.
    pub fn export(&self) -> BTreeMap<String, Vec<Value>> {
        self.logs
            .iter()
            .map(|(id, l)| {
                (
                    id.clone(),
                    l.all().iter().map(GroupEvent::to_value).collect(),
                )
            })
            .collect()
    }

    /// Restore saved groups. Events that no longer verify are dropped.
    pub fn load(&mut self, saved: &BTreeMap<String, Vec<Value>>) {
        for (group_id, events) in saved {
            let mut log = GroupLog::new(group_id);
            for e in events {
                let _ = log.add(e);
            }
            self.logs.insert(group_id.clone(), log);
        }
    }

    pub fn create_group(
        &mut self,
        identity: &Identity,
        name: &str,
        initial_members: &[ContactCard],
        now_ms: i64,
    ) -> Result<(String, GroupResult), GroupError> {
        if initial_members.len() + 1 > MAX_GROUP_MEMBERS {
            return Err(GroupError::TooManyMembers);
        }
        let create = sign_group_event(
            identity,
            NewEvent {
                group_id: String::new(),
                kind: EventType::Create,
                actor: self.own_uid.clone(),
                ts: now_ms,
                deps: vec![],
                target: None,
                card: Some(self.own_card.clone()),
                name: Some(name_cut(name)),
            },
        )?;
        let group_id = create.group_id.clone();
        let mut log = GroupLog::new(&group_id);
        let _ = log.add(&create.to_value());
        self.logs.insert(group_id.clone(), log);
        let mut result = GroupResult::default();
        result.changed.push(group_id.clone());
        result.joined.push(group_id.clone());
        for card in initial_members {
            let r = self.add_member(identity, &group_id, card, now_ms)?;
            result.outgoing.extend(r.outgoing);
        }
        Ok((group_id, result))
    }

    #[allow(clippy::too_many_arguments)]
    fn author(
        &mut self,
        identity: &Identity,
        group_id: &str,
        kind: EventType,
        target: Option<String>,
        card: Option<ContactCard>,
        name: Option<String>,
        now_ms: i64,
    ) -> Result<GroupResult, GroupError> {
        let own = self.own_uid.clone();
        let log = self.logs.get_mut(group_id).ok_or(GroupError::NotMember)?;
        if !log.state().is_some_and(|s| s.members.contains_key(&own)) {
            return Err(GroupError::NotMember);
        }
        let event = sign_group_event(
            identity,
            NewEvent {
                group_id: group_id.to_owned(),
                kind,
                actor: own.clone(),
                ts: now_ms,
                deps: log.heads(),
                target: target.clone(),
                card,
                name,
            },
        )?;
        if log.add(&event.to_value()) != AddStatus::Applied || !log.is_effective(&event.event_id) {
            return Err(GroupError::NotAllowed);
        }
        let mut result = GroupResult::default();
        result.changed.push(group_id.to_owned());
        // Tell everyone who is a member now, and the removed member so they learn they are out.
        let mut audience: BTreeSet<String> = log
            .state()
            .map(|s| s.members.keys().cloned().collect())
            .unwrap_or_default();
        audience.extend(target.clone());
        audience.remove(&own);
        for uid in audience {
            // A newly added member gets the whole history so they can verify it and meet everyone.
            if event.kind == EventType::Add && Some(&uid) == event.target.as_ref() {
                result.outgoing.extend(chunk(&uid, &log.all()));
            } else {
                result.outgoing.push(OutgoingFrame {
                    to: uid,
                    frame: GroupFrame::Push(Box::new(event.clone())),
                });
            }
        }
        if !log.state().is_some_and(|s| s.members.contains_key(&own)) {
            result.left.push(group_id.to_owned());
        }
        Ok(result)
    }

    pub fn add_member(
        &mut self,
        identity: &Identity,
        group_id: &str,
        card: &ContactCard,
        now_ms: i64,
    ) -> Result<GroupResult, GroupError> {
        let uid = uid_from_dh(&card.dh)?.to_string();
        if self.is_member(group_id, &uid) {
            return Err(GroupError::AlreadyMember);
        }
        if self.state(group_id).map_or(0, |s| s.members.len()) >= MAX_GROUP_MEMBERS {
            return Err(GroupError::Full);
        }
        self.author(
            identity,
            group_id,
            EventType::Add,
            Some(uid),
            Some(card.clone()),
            None,
            now_ms,
        )
    }

    pub fn remove_member(
        &mut self,
        identity: &Identity,
        group_id: &str,
        uid: &str,
        now_ms: i64,
    ) -> Result<GroupResult, GroupError> {
        self.author(
            identity,
            group_id,
            EventType::Remove,
            Some(uid.to_owned()),
            None,
            None,
            now_ms,
        )
    }

    pub fn leave(
        &mut self,
        identity: &Identity,
        group_id: &str,
        now_ms: i64,
    ) -> Result<GroupResult, GroupError> {
        let own = self.own_uid.clone();
        self.author(
            identity,
            group_id,
            EventType::Remove,
            Some(own),
            None,
            None,
            now_ms,
        )
    }

    pub fn rename(
        &mut self,
        identity: &Identity,
        group_id: &str,
        name: &str,
        now_ms: i64,
    ) -> Result<GroupResult, GroupError> {
        self.author(
            identity,
            group_id,
            EventType::Rename,
            None,
            None,
            Some(name_cut(name)),
            now_ms,
        )
    }

    /// A link to `peer` opened: tell them which groups we share and what we have. Always sent, even when empty, because
    /// the peer pushes back the groups we do not have yet.
    pub fn on_link_open(&self, peer: &str) -> Vec<OutgoingFrame> {
        let groups: Vec<(String, Vec<String>)> = self
            .logs
            .iter()
            .filter(|(_, l)| l.state().is_some_and(|s| s.members.contains_key(peer)))
            .map(|(id, l)| (id.clone(), sorted_ids(l)))
            .collect();
        vec![OutgoingFrame {
            to: peer.to_owned(),
            frame: GroupFrame::Have { groups, full: true },
        }]
    }

    pub fn handle(&mut self, from: &str, frame: &GroupFrame, who: &Who<'_>) -> GroupResult {
        let mut result = GroupResult::default();
        match frame {
            GroupFrame::Push(e) => {
                self.apply_events(from, std::slice::from_ref(e.as_ref()), who, &mut result)
            }
            GroupFrame::Events(es) => self.apply_events(from, es, who, &mut result),
            GroupFrame::Have { groups, full } => {
                for (gid, ids) in groups {
                    let Some(log) = self.logs.get(gid) else {
                        continue;
                    };
                    // Only members may pull a group's history; everyone else learns nothing, not even that it exists.
                    if !log.state().is_some_and(|s| s.members.contains_key(from)) {
                        continue;
                    }
                    let missing = log.missing_for(ids.iter().map(String::as_str));
                    if !missing.is_empty() {
                        result.outgoing.extend(chunk(from, &missing));
                    }
                    // If they know events we lack, ask for those by replying with what we have.
                    if ids.iter().any(|i| !log.has(i)) {
                        result.outgoing.push(OutgoingFrame {
                            to: from.to_owned(),
                            frame: GroupFrame::Have {
                                groups: vec![(gid.clone(), sorted_ids(log))],
                                full: false,
                            },
                        });
                    }
                }
                if *full {
                    // They listed everything they have: any group of ours they belong to but did not list is new to them.
                    let listed: BTreeSet<&String> = groups.iter().map(|(g, _)| g).collect();
                    for (gid, log) in &self.logs {
                        if listed.contains(gid)
                            || !log.state().is_some_and(|s| s.members.contains_key(from))
                        {
                            continue;
                        }
                        result.outgoing.extend(chunk(from, &log.missing_for([])));
                    }
                }
            }
            GroupFrame::Message(_) | GroupFrame::RelayBlob { .. } => {}
        }
        result
    }

    /// May `from` post in this group, as far as we can tell?
    pub fn check_message(&self, from: &str, group_id: &str) -> MessageVerdict {
        match self.state(group_id) {
            None => MessageVerdict::UnknownGroup,
            Some(s) if s.members.contains_key(from) && s.members.contains_key(&self.own_uid) => {
                MessageVerdict::Ok
            }
            Some(_) => MessageVerdict::NotMember,
        }
    }

    pub fn request_sync(&self, peer: &str, group_id: Option<&str>) -> Vec<OutgoingFrame> {
        let groups = self
            .logs
            .iter()
            .filter(|(id, _)| group_id.is_none_or(|g| g == id.as_str()))
            .map(|(id, l)| (id.clone(), sorted_ids(l)))
            .collect();
        vec![OutgoingFrame {
            to: peer.to_owned(),
            frame: GroupFrame::Have {
                groups,
                full: false,
            },
        }]
    }

    fn can_accept(&self, from: &str, group_id: &str, who: &Who<'_>) -> bool {
        if self.is_member(group_id, from) {
            return true;
        }
        who.trusted
            .map_or_else(|| who.known.contains(from), |t| t(from))
    }

    fn apply_events(
        &mut self,
        from: &str,
        events: &[GroupEvent],
        who: &Who<'_>,
        result: &mut GroupResult,
    ) {
        let own = self.own_uid.clone();
        let mut touched: Vec<String> = Vec::new();
        // Decide per group BEFORE applying anything: within one batch the sender may only become a member (and so pass the
        // check) after an earlier event of the same batch is applied.
        let mut accepted: BTreeMap<&str, bool> = BTreeMap::new();
        for e in events {
            accepted
                .entry(e.group_id.as_str())
                .or_insert_with(|| self.can_accept(from, &e.group_id, who));
        }
        for event in events {
            if !accepted
                .get(event.group_id.as_str())
                .copied()
                .unwrap_or(false)
            {
                continue;
            }
            let is_new = !self.logs.contains_key(&event.group_id);
            let log = self
                .logs
                .entry(event.group_id.clone())
                .or_insert_with(|| GroupLog::new(&event.group_id));
            let was_member = log.state().is_some_and(|s| s.members.contains_key(&own));
            let status = log.add(&event.to_value());
            if is_new && status == AddStatus::Invalid {
                self.logs.remove(&event.group_id);
                continue;
            }
            match status {
                AddStatus::Applied => {
                    if !touched.contains(&event.group_id) {
                        touched.push(event.group_id.clone());
                    }
                    let Some(log) = self.logs.get(&event.group_id) else {
                        continue;
                    };
                    if !was_member && log.state().is_some_and(|s| s.members.contains_key(&own)) {
                        result.joined.push(event.group_id.clone());
                    }
                    // Gossip the news to members the author could not reach.
                    if let Some(s) = log.state() {
                        for uid in s.members.keys() {
                            if *uid != own && uid != from && *uid != event.actor {
                                result.outgoing.push(OutgoingFrame {
                                    to: uid.clone(),
                                    frame: GroupFrame::Push(Box::new(event.clone())),
                                });
                            }
                        }
                    }
                }
                AddStatus::Buffered => {
                    // We are missing earlier events: ask this peer for the whole group.
                    result
                        .outgoing
                        .extend(self.request_sync(from, Some(&event.group_id)));
                }
                AddStatus::Duplicate | AddStatus::Invalid => {}
            }
        }
        for group_id in touched {
            let Some(log) = self.logs.get(&group_id) else {
                continue;
            };
            let state = log.state().cloned();
            let member = state.as_ref().is_some_and(|s| s.members.contains_key(&own));
            if !member {
                // Never a member (spam from a contact): forget it. Previously a member: keep it, we were removed.
                let ever_member = log.all().iter().any(|e| {
                    (e.kind == EventType::Add && e.target.as_deref() == Some(own.as_str()))
                        || (e.kind == EventType::Create && e.actor == own)
                });
                if !ever_member {
                    self.logs.remove(&group_id);
                    continue;
                }
                if state.is_some() && !result.left.contains(&group_id) {
                    result.left.push(group_id.clone());
                }
            }
            result.changed.push(group_id.clone());
            if let (Some(s), true) = (&state, member) {
                for m in s.members.values() {
                    if m.uid != own
                        && !who.known.contains(&m.uid)
                        && !result.new_contacts.iter().any(|c| c.uid == m.uid)
                    {
                        result.new_contacts.push(NewContact {
                            card: m.card.clone(),
                            uid: m.uid.clone(),
                            introduced_by: m.added_by.clone(),
                            group_id: group_id.clone(),
                        });
                    }
                }
            }
        }
    }
}

fn sorted_ids(log: &GroupLog) -> Vec<String> {
    let mut ids: Vec<String> = log.all().iter().map(|e| e.event_id.clone()).collect();
    ids.sort();
    ids
}

fn chunk(to: &str, events: &[GroupEvent]) -> Vec<OutgoingFrame> {
    events
        .chunks(MAX_EVENTS_PER_FRAME)
        .map(|c| OutgoingFrame {
            to: to.to_owned(),
            frame: GroupFrame::Events(c.to_vec()),
        })
        .collect()
}
