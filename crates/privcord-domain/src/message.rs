//! Messages, replies and the peer message frame. Mirrors `packages/protocol/src/message.ts`.

use crate::{
    error::DomainError,
    ids::{valid_message_id, MessageId, UserId},
    limits::{MAX_REPLY_PREVIEW, MAX_TEXT_LENGTH, PROTOCOL_VERSION},
    text::{count_code_points, js_trim, normalize_newlines, take_code_points, utf16_len},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DeliveryState {
    Queued,
    Sent,
    Delivered,
    Read,
    Failed,
}

impl DeliveryState {
    fn rank(self) -> u8 {
        match self {
            Self::Queued | Self::Failed => 0,
            Self::Sent => 1,
            Self::Delivered => 2,
            Self::Read => 3,
        }
    }

    /// A message only moves forward: Read beats Delivered beats Sent beats Queued, and Failed yields to anything else.
    pub fn highest(a: Self, b: Self) -> Self {
        match (a, b) {
            (Self::Failed, Self::Failed) => Self::Failed,
            (Self::Failed, other) | (other, Self::Failed) => other,
            _ => {
                if a.rank() >= b.rank() {
                    a
                } else {
                    b
                }
            }
        }
    }

    /// Worth trying to send again.
    pub fn is_retryable(self) -> bool {
        matches!(self, Self::Failed | Self::Queued)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransportKind {
    P2p,
    Relay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageKind {
    Text,
    File,
}

/// A quoted message carried with a reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplyRef {
    pub id: String,
    pub author: String,
    pub preview: String,
}

impl ReplyRef {
    /// Quote a message: its id, its author and its first 120 code points.
    pub fn quoting(id: &MessageId, author: &UserId, text: &str) -> Self {
        Self {
            id: id.to_string(),
            author: author.to_string(),
            preview: take_code_points(text, MAX_REPLY_PREVIEW),
        }
    }

    /// A reply reference from the wire; `None` if any part breaks the rules.
    pub fn from_value(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        let id = o.get("id")?.as_str()?;
        let author = o.get("author")?.as_str()?;
        let preview = o.get("preview")?.as_str()?;
        let ok = valid_message_id(id)
            && !author.is_empty()
            && utf16_len(author) <= 128
            && count_code_points(preview) <= MAX_REPLY_PREVIEW;
        ok.then(|| Self {
            id: id.to_owned(),
            author: author.to_owned(),
            preview: preview.to_owned(),
        })
    }
}

/// One chat message as the engine holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    pub message_id: MessageId,
    pub client_message_id: MessageId,
    pub sender_id: UserId,
    pub text: String,
    /// The sender's clock when they wrote it (ms since 1970). Together with the id it fixes the order.
    pub client_created_at: i64,
    pub kind: MessageKind,
    pub transport: TransportKind,
    pub delivery_state: DeliveryState,
    pub reply_to: Option<ReplyRef>,
    pub read_at: Option<i64>,
}

/// Validates text a person typed: not blank, at most 4000 code points. Returns it with newlines normalised.
pub fn validate_outgoing_text(raw: &str) -> Result<String, DomainError> {
    let text = normalize_newlines(raw);
    if js_trim(&text).is_empty() {
        return Err(DomainError::EmptyMessage);
    }
    if count_code_points(&text) > MAX_TEXT_LENGTH {
        return Err(DomainError::MessageTooLong {
            limit: MAX_TEXT_LENGTH,
        });
    }
    Ok(text)
}

/// Text from the wire: not blank and within the limit (it is not rewritten).
pub fn validate_incoming_text(text: &str) -> bool {
    !js_trim(text).is_empty() && count_code_points(text) <= MAX_TEXT_LENGTH
}

/// A timestamp from the wire: a finite whole number of milliseconds above zero and exactly representable.
///
/// Stricter than the TypeScript parser, which also accepts fractions; no real client sends one (they send
/// `Date.now()`), and a fraction cannot be ordered consistently across platforms. See docs/rust/COMPATIBILITY.md.
pub fn parse_timestamp(value: &Value) -> Option<i64> {
    let n = value.as_f64()?;
    let ok = n.is_finite() && n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0;
    ok.then_some(n as i64)
}

/// A timestamp from the wire for events that sign it: same rule as [`parse_timestamp`], allowing zero.
pub fn parse_timestamp_any(value: &Value) -> Option<i64> {
    let n = value.as_f64()?;
    (n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n as i64)
}

impl ChatMessage {
    /// A new outgoing text message. The caller supplies the id and the clock (the domain has neither).
    pub fn outgoing(
        sender: UserId,
        text: &str,
        now_ms: i64,
        id: MessageId,
        reply_to: Option<ReplyRef>,
    ) -> Result<Self, DomainError> {
        let text = validate_outgoing_text(text)?;
        Ok(Self {
            message_id: id.clone(),
            client_message_id: id,
            sender_id: sender,
            text,
            client_created_at: now_ms,
            kind: MessageKind::Text,
            transport: TransportKind::P2p,
            delivery_state: DeliveryState::Queued,
            reply_to,
            read_at: None,
        })
    }

    /// The frame sent to a peer.
    pub fn to_peer_frame(&self) -> Value {
        let mut o = Map::new();
        o.insert("v".into(), json!(PROTOCOL_VERSION));
        o.insert("kind".into(), json!("message"));
        o.insert("messageId".into(), json!(self.message_id));
        o.insert("clientMessageId".into(), json!(self.client_message_id));
        o.insert("senderId".into(), json!(self.sender_id));
        o.insert("text".into(), json!(self.text));
        o.insert("clientCreatedAt".into(), json!(self.client_created_at));
        if let Some(r) = &self.reply_to {
            o.insert("replyTo".into(), json!(r));
        }
        Value::Object(o)
    }

    /// A frame received from a peer. `None` for anything that breaks the rules.
    pub fn from_peer_frame(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        if o.get("kind")?.as_str()? != "message" || o.get("v")?.as_u64()? != PROTOCOL_VERSION {
            return None;
        }
        let message_id = MessageId::new(o.get("messageId")?.as_str()?).ok()?;
        let client_message_id = MessageId::new(o.get("clientMessageId")?.as_str()?).ok()?;
        let sender_id = UserId::new(o.get("senderId")?.as_str()?).ok()?;
        let text = o.get("text")?.as_str()?;
        if !validate_incoming_text(text) {
            return None;
        }
        let reply_to = match o.get("replyTo") {
            None => None,
            Some(v) => Some(ReplyRef::from_value(v)?),
        };
        let client_created_at = parse_timestamp(o.get("clientCreatedAt")?)?;
        Some(Self {
            message_id,
            client_message_id,
            sender_id,
            text: text.to_owned(),
            client_created_at,
            kind: MessageKind::Text,
            transport: TransportKind::P2p,
            delivery_state: DeliveryState::Delivered,
            reply_to,
            read_at: None,
        })
    }
}

/// Why a peer refused something we sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeclineReason {
    DirectNotAccepted,
    TooLarge,
    BadFile,
    Busy,
}

pub fn declined_frame(message_id: &MessageId, reason: DeclineReason) -> Value {
    json!({ "v": PROTOCOL_VERSION, "kind": "declined", "messageId": message_id, "reason": reason })
}

pub fn parse_declined_frame(value: &Value) -> Option<(MessageId, DeclineReason)> {
    let o = value.as_object()?;
    if o.get("kind")?.as_str()? != "declined" || o.get("v")?.as_u64()? != PROTOCOL_VERSION {
        return None;
    }
    let id = MessageId::new(o.get("messageId")?.as_str()?).ok()?;
    let reason = serde_json::from_value(o.get("reason")?.clone()).ok()?;
    Some((id, reason))
}
