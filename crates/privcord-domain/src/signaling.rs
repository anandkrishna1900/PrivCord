//! Manual connection codes (`DUO1:` + base64url JSON) and the rules the signaling services share
//! (`signaling.ts`, `signaling/types.ts`, `signaling/hub.ts`). Sockets stay in the platform adapters.

use crate::{blob::PublicJwk, codec, pairing::is_valid_public_jwk};
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};

pub const MANUAL_SIGNAL_PREFIX: &str = "DUO1:";
pub const MAX_MANUAL_SIGNAL_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalKind {
    Offer,
    Answer,
}

/// A self-contained SDP and identity bundle used when no signaling service is reachable. It is transport data, never
/// proof of identity: people compare safety numbers before trusting it.
#[derive(Debug, Clone, PartialEq)]
pub struct ManualSignal {
    pub kind: SignalKind,
    pub conversation_id: String,
    pub from_uid: String,
    pub from_device_id: String,
    pub public_key: PublicJwk,
    pub dh: PublicJwk,
    pub identity_proof: String,
    pub sdp: String,
    pub nonce: String,
    pub created_at: i64,
}

impl ManualSignal {
    pub fn to_value(&self) -> Value {
        json!({
            "v": 1,
            "kind": match self.kind { SignalKind::Offer => "offer", SignalKind::Answer => "answer" },
            "conversationId": self.conversation_id,
            "fromUid": self.from_uid,
            "fromDeviceId": self.from_device_id,
            "publicKeyJwk": self.public_key,
            "dhJwk": self.dh,
            "identityProof": self.identity_proof,
            "sdp": self.sdp,
            "nonce": self.nonce,
            "createdAt": self.created_at,
        })
    }

    pub fn encode(&self) -> String {
        format!(
            "{MANUAL_SIGNAL_PREFIX}{}",
            codec::encode(self.to_value().to_string().as_bytes())
        )
    }

    /// The code text back into a signal, or the message to show the person.
    pub fn decode(encoded: &str, expected_conversation: &str) -> Result<Self, &'static str> {
        let trimmed = crate::text::js_trim(encoded);
        let Some(body) = trimmed.strip_prefix(MANUAL_SIGNAL_PREFIX) else {
            return Err("This is not a DuoChat connection code.");
        };
        if body.len() > MAX_MANUAL_SIGNAL_BYTES {
            return Err("Connection code is too large.");
        }
        let json = codec::decode(body)
            .and_then(|b| String::from_utf8(b).ok())
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .ok_or("Connection code is malformed.")?;
        Self::validate(&json, expected_conversation)
    }

    pub fn validate(value: &Value, expected_conversation: &str) -> Result<Self, &'static str> {
        let o = value.as_object().ok_or("Connection code is malformed.")?;
        if o.get("v").and_then(Value::as_u64) != Some(1) {
            return Err("Unsupported connection code version.");
        }
        let kind = match o.get("kind").and_then(Value::as_str) {
            Some("offer") => SignalKind::Offer,
            Some("answer") => SignalKind::Answer,
            _ => return Err("Connection code has an invalid type."),
        };
        let conversation_id = o.get("conversationId").and_then(Value::as_str);
        if conversation_id != Some(expected_conversation) {
            return Err("Connection code belongs to another conversation.");
        }
        let nonempty = |k: &str| o.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
        let from_uid = nonempty("fromUid").ok_or("Connection code has no sender.")?;
        let from_device_id = nonempty("fromDeviceId").ok_or("Connection code has no device.")?;
        let public_key = o
            .get("publicKeyJwk")
            .and_then(is_valid_public_jwk)
            .ok_or("Connection code has an invalid identity key.")?;
        let dh = o.get("dhJwk").and_then(is_valid_public_jwk);
        let proof = o
            .get("identityProof")
            .and_then(Value::as_str)
            .filter(|p| p.encode_utf16().count() >= 40);
        let (Some(dh), Some(identity_proof)) = (dh, proof) else {
            return Err("Connection code has no identity proof.");
        };
        let sdp = o
            .get("sdp")
            .and_then(Value::as_str)
            .filter(|s| {
                let n = s.encode_utf16().count();
                (20..=MAX_MANUAL_SIGNAL_BYTES).contains(&n) && s.contains("v=0")
            })
            .ok_or("Connection code has an invalid session description.")?;
        let nonce = o
            .get("nonce")
            .and_then(Value::as_str)
            .filter(|n| n.encode_utf16().count() >= 16)
            .ok_or("Connection code has an invalid nonce.")?;
        let created_at = o
            .get("createdAt")
            .and_then(Value::as_f64)
            .filter(|t| t.is_finite() && *t > 0.0)
            .ok_or("Connection code has an invalid timestamp.")?;
        Ok(Self {
            kind,
            conversation_id: expected_conversation.to_owned(),
            from_uid: from_uid.to_owned(),
            from_device_id: from_device_id.to_owned(),
            public_key,
            dh,
            identity_proof: identity_proof.to_owned(),
            sdp: sdp.to_owned(),
            nonce: nonce.to_owned(),
            created_at: created_at as i64,
        })
    }
}

/// `Sig`: short-lived live signaling. `Msg`: held for an offline contact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PutKind {
    Sig,
    Msg,
}

impl PutKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sig => "sig",
            Self::Msg => "msg",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalingStatus {
    Idle,
    Connecting,
    Online,
    Error,
}

/// Reconnect delay for a dropped relay socket: 1 s doubling to 30 s.
pub fn socket_backoff_ms(attempt: u32) -> u64 {
    30_000u64.min(1_000u64 << attempt.min(5))
}

/// How the hub reports several transports as one: any online wins, then connecting; none configured is idle.
pub fn aggregate_status(states: &[SignalingStatus]) -> SignalingStatus {
    if states.contains(&SignalingStatus::Online) {
        SignalingStatus::Online
    } else if states.contains(&SignalingStatus::Connecting) {
        SignalingStatus::Connecting
    } else if states.is_empty() {
        SignalingStatus::Idle
    } else {
        SignalingStatus::Error
    }
}

/// Remembers recent ids, forgetting the oldest beyond `capacity`; the hub uses it so the first copy of a blob wins when
/// several transports deliver it, and the engine so a relayed blob is passed on at most once.
#[derive(Debug)]
pub struct SeenSet {
    capacity: usize,
    order: VecDeque<String>,
    set: HashSet<String>,
}

impl Default for SeenSet {
    fn default() -> Self {
        Self::new(2000)
    }
}

impl SeenSet {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            order: VecDeque::new(),
            set: HashSet::new(),
        }
    }

    /// True the first time `id` is offered.
    pub fn first_time(&mut self, id: &str) -> bool {
        if !self.set.insert(id.to_owned()) {
            return false;
        }
        self.order.push_back(id.to_owned());
        while self.order.len() > self.capacity {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }
}

/// What the relay protocol says in each direction (`relayClient.ts`; the server is `relay/server.js`).
pub mod relay {
    use serde_json::{json, Value};

    pub fn sub_frame(mailbox: &str, since: i64) -> String {
        json!({ "op": "sub", "mailbox": mailbox, "since": since }).to_string()
    }
    pub fn put_frame(mailbox: &str, id: &str, blob: &str, ttl_sec: u32, kind: &str) -> String {
        json!({ "op": "put", "mailbox": mailbox, "id": id, "blob": blob, "ttl": ttl_sec, "kind": kind })
            .to_string()
    }
    pub fn del_frame(mailbox: &str, id: &str) -> String {
        json!({ "op": "del", "mailbox": mailbox, "id": id }).to_string()
    }

    #[derive(Debug, Clone, PartialEq)]
    pub enum Incoming {
        /// A stored or live blob (still encoded), its id and the relay's timestamp if it sent one.
        Event {
            id: String,
            blob: String,
            ts: Option<i64>,
        },
        Ok {
            id: String,
        },
        Err {
            id: String,
            reason: String,
        },
    }

    /// `None` for anything that is not one of the three frames the client acts on.
    pub fn parse_incoming(raw: &str) -> Option<Incoming> {
        let v: Value = serde_json::from_str(raw).ok()?;
        let o = v.as_object()?;
        let id = o.get("id")?.as_str()?.to_owned();
        match o.get("op")?.as_str()? {
            "event" => Some(Incoming::Event {
                id,
                blob: o.get("blob")?.as_str()?.to_owned(),
                ts: o.get("ts").and_then(Value::as_f64).map(|t| t as i64),
            }),
            "ok" => Some(Incoming::Ok { id }),
            "err" => Some(Incoming::Err {
                id,
                reason: o.get("reason").map_or_else(
                    || "Relay refused the message.".to_owned(),
                    |r| r.as_str().map_or_else(|| r.to_string(), str::to_owned),
                ),
            }),
            _ => None,
        }
    }
}
