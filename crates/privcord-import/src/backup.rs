//! A backup file's contents (the JSON inside `PRIVCORD-BACKUP1:`) as a bundle for the importer. The shape is what
//! `exportBackup` in the desktop app writes and the engine writes too: contacts, groups, channels, muted people, messages
//! (without file bytes).

use crate::{
    contacts_from_json, file_meta_from, parse_delivery, reactions_from, reply_from, LegacyBundle,
    LegacyMessage,
};
use privcord_domain::message::TransportKind;
use serde_json::Value;
use std::collections::HashSet;

/// `None` unless it is a version-1 backup. The backup's owner is returned too, so a backup of someone else is refused.
pub fn read_bundle(data: &Value) -> Option<(String, LegacyBundle)> {
    let o = data.as_object()?;
    if o.get("v")?.as_u64()? != 1 {
        return None;
    }
    let owner = o.get("uid")?.as_str()?.to_owned();
    let muted: Vec<String> = o
        .get("blocked")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let muted_set: HashSet<String> = muted.iter().cloned().collect();
    let mut bundle = LegacyBundle {
        muted,
        ..LegacyBundle::default()
    };
    if let Some(list) = o.get("contacts").and_then(Value::as_array) {
        bundle.contacts = contacts_from_json(list, &muted_set);
    }
    if let Some(groups) = o.get("groups").and_then(Value::as_object) {
        for (id, events) in groups {
            if let Some(events) = events.as_array() {
                bundle.groups.insert(id.clone(), events.clone());
            }
        }
    }
    if let Some(names) = o.get("channels").and_then(Value::as_array) {
        bundle
            .channels
            .extend(names.iter().filter_map(|n| n.as_str().map(str::to_owned)));
    }
    for m in o
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let text = |k: &str| m.get(k).and_then(Value::as_str).map(str::to_owned);
        let (Some(id), Some(sender)) = (text("messageId"), text("senderId")) else {
            continue;
        };
        let Some(delivery) = m
            .get("deliveryState")
            .and_then(Value::as_str)
            .and_then(parse_delivery)
        else {
            continue;
        };
        let file = if text("type").as_deref() == Some("file") {
            file_meta_from(m.get("file"))
        } else {
            None
        };
        let pending = m
            .get("recipients")
            .and_then(Value::as_object)
            .map(|r| {
                r.iter()
                    .filter(|(_, s)| matches!(s.as_str(), Some("QUEUED" | "SENT" | "FAILED")))
                    .map(|(u, _)| (u.clone(), 0))
                    .collect()
            })
            .unwrap_or_default();
        bundle.messages.push(LegacyMessage {
            client_id: text("clientMessageId").unwrap_or_else(|| id.clone()),
            id,
            sender,
            text: text("text").unwrap_or_default(),
            created_at: m
                .get("clientCreatedAt")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            conversation: text("conversationId").unwrap_or_default(),
            file,
            reply: reply_from(m.get("replyTo")),
            delivery,
            read_at: m.get("readAt").and_then(Value::as_i64),
            transport: if text("transport").as_deref() == Some("relay") {
                TransportKind::Relay
            } else {
                TransportKind::P2p
            },
            deleted: m.get("deleted").and_then(Value::as_bool).unwrap_or(false),
            reactions: reactions_from(m.get("reactions")),
            pending,
        });
    }
    Some((owner, bundle))
}
