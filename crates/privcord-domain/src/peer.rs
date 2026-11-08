//! Link housekeeping frames: liveness and receipts (`peerAuth.ts`, the non-handshake part).

use crate::{ids::MessageId, limits::PROTOCOL_VERSION, message::parse_timestamp_any};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptState {
    Delivered,
    Read,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerFrame {
    Ping {
        at: i64,
    },
    Pong {
        at: i64,
    },
    Ack {
        message_id: MessageId,
        state: ReceiptState,
        at: i64,
    },
    Read {
        last_read_message_id: String,
        at: i64,
    },
}

impl PeerFrame {
    /// `None` for anything that is not a well-formed liveness or receipt frame.
    pub fn parse(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        if o.get("v")?.as_u64()? != PROTOCOL_VERSION {
            return None;
        }
        let at = || parse_timestamp_any(o.get("at")?);
        match o.get("kind")?.as_str()? {
            "ping" => Some(Self::Ping { at: at()? }),
            "pong" => Some(Self::Pong { at: at()? }),
            "ack" => {
                let state = match o.get("state")?.as_str()? {
                    "DELIVERED" => ReceiptState::Delivered,
                    "READ" => ReceiptState::Read,
                    _ => return None,
                };
                // The TypeScript parser only needs a non-empty id here.
                let id = o.get("messageId")?.as_str()?;
                if id.is_empty() {
                    return None;
                }
                Some(Self::Ack {
                    message_id: MessageId::new(id).ok()?,
                    state,
                    at: at()?,
                })
            }
            "read" => {
                let id = o.get("lastReadMessageId")?.as_str()?;
                if id.is_empty() {
                    return None;
                }
                Some(Self::Read {
                    last_read_message_id: id.to_owned(),
                    at: at()?,
                })
            }
            _ => None,
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            Self::Ping { at } => json!({ "v": PROTOCOL_VERSION, "kind": "ping", "at": at }),
            Self::Pong { at } => json!({ "v": PROTOCOL_VERSION, "kind": "pong", "at": at }),
            Self::Ack {
                message_id,
                state,
                at,
            } => json!({
                "v": PROTOCOL_VERSION, "kind": "ack", "messageId": message_id,
                "state": if *state == ReceiptState::Read { "READ" } else { "DELIVERED" }, "at": at
            }),
            Self::Read {
                last_read_message_id,
                at,
            } => {
                json!({ "v": PROTOCOL_VERSION, "kind": "read", "lastReadMessageId": last_read_message_id, "at": at })
            }
        }
    }
}
