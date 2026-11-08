//! Message order and merging (`ordering.ts`). Order is by the sender's clock, then by id, so every device agrees.

use crate::{message::ChatMessage, text::cmp_utf16};
use std::cmp::Ordering;
use std::collections::HashMap;

pub fn compare_messages(a: &ChatMessage, b: &ChatMessage) -> Ordering {
    a.client_created_at
        .cmp(&b.client_created_at)
        .then_with(|| cmp_utf16(a.message_id.as_str(), b.message_id.as_str()))
}

pub fn sort_messages(messages: &mut [ChatMessage]) {
    messages.sort_by(compare_messages);
}

/// Merge two lists by message id: new ones are added; for ones we both have, the delivery state only moves forward
/// and the first known read time is kept. The result is sorted.
pub fn merge_messages(existing: Vec<ChatMessage>, incoming: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let mut by_id: HashMap<String, ChatMessage> = HashMap::new();
    for m in existing {
        by_id.insert(m.message_id.to_string(), m);
    }
    for m in incoming {
        match by_id.remove(m.message_id.as_str()) {
            None => {
                by_id.insert(m.message_id.to_string(), m);
            }
            Some(mut current) => {
                current.delivery_state = crate::message::DeliveryState::highest(
                    current.delivery_state,
                    m.delivery_state,
                );
                current.read_at = current.read_at.or(m.read_at);
                by_id.insert(current.message_id.to_string(), current);
            }
        }
    }
    let mut out: Vec<ChatMessage> = by_id.into_values().collect();
    sort_messages(&mut out);
    out
}
