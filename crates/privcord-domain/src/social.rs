//! Delete-for-everyone and reactions (`social.ts`). Neither can be enforced against a modified app.

use crate::{ids::MessageId, limits::PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const REACTION_EMOJI: [&str; 6] = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

pub fn delete_frame(id: &MessageId) -> Value {
    json!({ "v": PROTOCOL_VERSION, "kind": "delete", "messageId": id })
}

pub fn react_frame(id: &MessageId, emoji: &str, on: bool) -> Value {
    json!({ "v": PROTOCOL_VERSION, "kind": "react", "messageId": id, "emoji": emoji, "on": on })
}

pub fn parse_delete_frame(value: &Value) -> Option<MessageId> {
    let o = value.as_object()?;
    if o.get("kind")?.as_str()? != "delete" || o.get("v")?.as_u64()? != PROTOCOL_VERSION {
        return None;
    }
    MessageId::new(o.get("messageId")?.as_str()?).ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reaction {
    pub message_id: MessageId,
    pub emoji: &'static str,
    /// `false` removes the sender's reaction.
    pub on: bool,
}

pub fn parse_react_frame(value: &Value) -> Option<Reaction> {
    let o = value.as_object()?;
    if o.get("kind")?.as_str()? != "react" || o.get("v")?.as_u64()? != PROTOCOL_VERSION {
        return None;
    }
    let message_id = MessageId::new(o.get("messageId")?.as_str()?).ok()?;
    let on = o.get("on")?.as_bool()?;
    let emoji = o.get("emoji")?.as_str()?;
    let emoji = REACTION_EMOJI.iter().copied().find(|e| *e == emoji)?;
    Some(Reaction {
        message_id,
        emoji,
        on,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReactionChip {
    pub emoji: &'static str,
    pub count: usize,
    pub mine: bool,
}

/// Everyone's reactions on one message, in the fixed emoji order: how many, and whether I reacted.
pub fn summarize_reactions(reactions: &BTreeMap<String, String>, me: &str) -> Vec<ReactionChip> {
    REACTION_EMOJI
        .iter()
        .filter_map(|emoji| {
            let mut count = 0;
            let mut mine = false;
            for (uid, e) in reactions {
                if e == emoji {
                    count += 1;
                    mine |= uid == me;
                }
            }
            (count > 0).then_some(ReactionChip { emoji, count, mine })
        })
        .collect()
}
