//! Groups made before protocol v2. Their signed history names members by v1 ids, which v2 no longer accepts (accepting
//! them is what let a forged card claim someone's id), so the group log drops them on load. What they were (the last
//! name, and who was in them) is kept here, so the person can make each one again with one tap, its messages included.

use super::{Core, StorageOp};
use crate::{api::LegacyGroupView, error::ErrorCode, EngineEvent};
use privcord_crypto::{
    group::{EventType, GroupEvent},
    identity::{legacy_uid, uid_from_keys},
};
use privcord_domain::{ConversationId, GroupId, UserId};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const KV_LEGACY_GROUPS: &str = "groups.legacy";

impl Core {
    /// Called with the saved group logs and the ids the group log kept: every other group with a readable history is
    /// remembered (once) under `groups.legacy`, which survives the logs being saved without it.
    pub(super) fn remember_legacy_groups(
        &mut self,
        saved: &BTreeMap<String, Vec<Value>>,
        live: &BTreeSet<String>,
    ) {
        let mut known = self.load_legacy_groups();
        let own = self.uid.clone();
        let mut changed = false;
        for (gid, events) in saved {
            if live.contains(gid) || known.iter().any(|g| &g.old_id == gid) {
                continue;
            }
            if let Some(g) = legacy_group_of(gid, events, own.as_ref()) {
                known.push(g);
                changed = true;
            }
        }
        if changed {
            self.save_legacy_groups(&known);
        }
        self.legacy_groups = known;
    }

    fn load_legacy_groups(&self) -> Vec<LegacyGroupView> {
        self.ports
            .storage
            .kv(KV_LEGACY_GROUPS)
            .ok()
            .flatten()
            .and_then(|b| serde_json::from_slice::<Vec<(String, String, Vec<String>)>>(&b).ok())
            .map(|v| {
                v.into_iter()
                    .map(|(old_id, name, members)| LegacyGroupView {
                        old_id,
                        name,
                        members: members
                            .into_iter()
                            .filter_map(|m| UserId::new(m).ok())
                            .collect(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn save_legacy_groups(&mut self, groups: &[LegacyGroupView]) {
        let rows: Vec<(&str, &str, Vec<&str>)> = groups
            .iter()
            .map(|g| {
                (
                    g.old_id.as_str(),
                    g.name.as_str(),
                    g.members.iter().map(UserId::as_str).collect(),
                )
            })
            .collect();
        if let Ok(value) = serde_json::to_vec(&rows) {
            let _ = self.ports.storage.apply(&[StorageOp::SetKv {
                key: KV_LEGACY_GROUPS.into(),
                value,
            }]);
        }
    }

    /// For a backup: the old groups still waiting, as `[old id, name, [member ids]]`.
    pub(super) fn legacy_groups_json(&self) -> Value {
        Value::Array(
            self.legacy_groups
                .iter()
                .map(|g| serde_json::json!([g.old_id, g.name, g.members]))
                .collect(),
        )
    }

    /// From a restored backup: old groups not already waiting (and not made again since) are offered again.
    pub(super) fn merge_legacy_groups_json(&mut self, value: Option<&Value>) {
        let Some(Value::Array(rows)) = value else {
            return;
        };
        self.ensure_groups().ok();
        let live: BTreeSet<String> = self
            .groups
            .as_ref()
            .map(|g| {
                g.my_groups()
                    .into_iter()
                    .map(|s| s.group_id.clone())
                    .collect()
            })
            .unwrap_or_default();
        let mut groups = self.legacy_groups.clone();
        for row in rows {
            let Ok((old_id, name, members)) =
                serde_json::from_value::<(String, String, Vec<String>)>(row.clone())
            else {
                continue;
            };
            if live.contains(&old_id)
                || groups.iter().any(|g| g.old_id == old_id)
                || name.trim().is_empty()
            {
                continue;
            }
            groups.push(LegacyGroupView {
                old_id,
                name,
                members: members
                    .into_iter()
                    .filter_map(|m| UserId::new(m).ok())
                    .collect(),
            });
        }
        if groups.len() != self.legacy_groups.len() {
            self.save_legacy_groups(&groups);
            self.legacy_groups = groups;
        }
    }

    /// Make an old group again: same name, every member who is still a friend, and its messages moved into the new
    /// group. Returns the new group's id.
    pub fn recreate_legacy_group(&mut self, old_id: &str) -> Result<String, ErrorCode> {
        self.require_live()?;
        let g = self
            .legacy_groups
            .iter()
            .find(|g| g.old_id == old_id)
            .cloned()
            .ok_or(ErrorCode::NoSuchGroup)?;
        let members: Vec<UserId> = g
            .members
            .iter()
            .filter(|u| self.contacts.contains_key(*u))
            .cloned()
            .collect();
        let new_id = self.create_group(&g.name, &members)?;
        if let (Ok(old), Ok(new)) = (GroupId::new(old_id), GroupId::new(new_id.as_str())) {
            let (from, to) = (ConversationId::Group(old), ConversationId::Group(new));
            if self
                .ports
                .storage
                .apply(&[StorageOp::MoveConversation {
                    from: from.clone(),
                    to: to.clone(),
                }])
                .is_ok()
            {
                for m in self.messages.values_mut() {
                    if m.conversation == from {
                        m.conversation = to.clone();
                    }
                }
            }
        }
        self.forget_legacy_group(old_id);
        Ok(new_id)
    }

    /// Don't offer this old group again (its messages stay where they are).
    pub fn dismiss_legacy_group(&mut self, old_id: &str) -> Result<(), ErrorCode> {
        self.require_live()?;
        self.forget_legacy_group(old_id);
        Ok(())
    }

    fn forget_legacy_group(&mut self, old_id: &str) {
        let mut groups = std::mem::take(&mut self.legacy_groups);
        groups.retain(|g| g.old_id != old_id);
        self.save_legacy_groups(&groups);
        self.legacy_groups = groups;
        self.hub.publish(EngineEvent::GroupChanged {
            group_id: old_id.to_owned(),
        });
    }
}

/// What a group's history says, read without verifying it (it cannot verify under v2): its last name, and who was in
/// it at the end, by their v2 ids (from the cards in it). Removals name v1 ids, which the cards' v1 ids are matched to.
fn legacy_group_of(gid: &str, events: &[Value], own: Option<&UserId>) -> Option<LegacyGroupView> {
    let mut parsed: Vec<GroupEvent> = events.iter().filter_map(GroupEvent::from_value).collect();
    parsed.sort_by_key(|e| e.ts);
    let mut name = None;
    // v1 id -> v2 id, for everyone who is in.
    let mut members: BTreeMap<String, UserId> = BTreeMap::new();
    // Only a group whose history names people by v1 ids is from before v2 (a v2 group we were removed from is not).
    let mut v1 = false;
    for e in &parsed {
        if e.group_id != gid {
            continue;
        }
        match e.kind {
            EventType::Create | EventType::Rename => name = e.name.clone().or(name),
            EventType::Add | EventType::Remove => {}
        }
        match e.kind {
            EventType::Create | EventType::Add => {
                if let Some(c) = &e.card {
                    if let (Ok(old), Ok(new)) = (legacy_uid(&c.dh), uid_from_keys(&c.sign, &c.dh)) {
                        let named = if e.kind == EventType::Create {
                            Some(&e.actor)
                        } else {
                            e.target.as_ref()
                        };
                        v1 |= named.is_some_and(|n| n == old.as_str());
                        members.insert(old.to_string(), new);
                    }
                }
            }
            EventType::Remove => {
                if let Some(t) = &e.target {
                    members.remove(t);
                }
            }
            EventType::Rename => {}
        }
    }
    if !v1 {
        return None;
    }
    let name = name.filter(|n| !n.trim().is_empty())?;
    let members: Vec<UserId> = members.into_values().filter(|u| Some(u) != own).collect();
    Some(LegacyGroupView {
        old_id: gid.to_owned(),
        name,
        members,
    })
}
