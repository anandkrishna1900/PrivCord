//! Moves an existing install's data into the Rust engine's storage.
//!
//! Two sources, one pipeline. A *reader* turns the old database into a plain [`LegacyBundle`] (desktop: the SQLite file
//! plus the AES key from the OS secret store; Android: the Room file plus a decryptor that calls the Android Keystore,
//! whose key can never leave the device). [`import`] then checks everything it was given (contact cards and their
//! proofs, every group event's signature, message rules, file hashes) and writes what holds up, counting what it
//! skipped and why. Nothing unverifiable is trusted.
//!
//! Safe to run twice: contacts, messages and files are written without duplicating, and a marker is written last, so an
//! interrupted import is simply run again. Each write batch is atomic.

pub mod android;
pub mod backup;
pub mod desktop;
mod pipeline;

pub use pipeline::{import, ImportError, ImportReport};

use privcord_domain::{
    message::{DeliveryState, ReplyRef, TransportKind},
    privacy::ContactTrust,
};
use serde_json::Value;
use std::collections::BTreeMap;

/// Turns what the old app stored encrypted back into text and bytes. The desktop uses an AES key it can read;
/// Android asks its Keystore.
pub trait Decryptor {
    /// `enc1.<iv>.<ciphertext>` text, or text that was never encrypted (returned as it is). `None` if it fails.
    fn text(&self, payload: &str) -> Option<String>;
}

/// Supplies the plain bytes of a file message (the old apps keep them outside the message table).
pub trait FileSource {
    fn file(&self, message_id: &str) -> Option<Vec<u8>>;
}

/// No files to bring over.
#[derive(Debug, Clone, Copy)]
pub struct NoFiles;
impl FileSource for NoFiles {
    fn file(&self, _message_id: &str) -> Option<Vec<u8>> {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Desktop,
    Android,
    /// A backup file made by the apps (or the engine). Importing it adds to what is there and can be done again.
    Backup,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Android => "android",
            Self::Backup => "backup",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LegacyContact {
    pub uid: String,
    /// The card as JSON (`{v, sign, dh, proof, name?}`); it is verified on import.
    pub card: Value,
    /// What the person called them.
    pub nickname: Option<String>,
    pub trust: ContactTrust,
    pub checked: bool,
    pub introduced_by: Option<String>,
    pub created_at: i64,
    pub muted: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LegacyFileMeta {
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LegacyMessage {
    pub id: String,
    pub client_id: String,
    pub sender: String,
    pub text: String,
    pub created_at: i64,
    /// A person's id, a group id, `chan:<name>`, or the old single-chat placeholder `duo`.
    pub conversation: String,
    pub file: Option<LegacyFileMeta>,
    pub reply: Option<ReplyRef>,
    pub delivery: DeliveryState,
    pub read_at: Option<i64>,
    pub transport: TransportKind,
    /// Deleted for everyone: only a tombstone comes over.
    pub deleted: bool,
    /// Who reacted with what.
    pub reactions: Vec<(String, String)>,
    /// People this message still has to reach (group messages, or the one recipient of a direct one).
    pub pending: Vec<(String, u32)>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct LegacyBundle {
    pub contacts: Vec<LegacyContact>,
    /// Group id to its signed events, exactly as the old app saved them.
    pub groups: BTreeMap<String, Vec<Value>>,
    pub channels: Vec<String>,
    /// People whose channel messages are hidden.
    pub muted: Vec<String>,
    pub messages: Vec<LegacyMessage>,
}

pub(crate) fn parse_delivery(s: &str) -> Option<DeliveryState> {
    Some(match s {
        "QUEUED" => DeliveryState::Queued,
        "SENT" => DeliveryState::Sent,
        "DELIVERED" => DeliveryState::Delivered,
        "READ" => DeliveryState::Read,
        "FAILED" => DeliveryState::Failed,
        _ => return None,
    })
}

pub(crate) fn parse_trust(s: &str) -> ContactTrust {
    // Older builds also wrote "confirmed" for a card swapped in person.
    if s == "verified" || s == "confirmed" {
        ContactTrust::Verified
    } else {
        ContactTrust::Introduced
    }
}

pub(crate) fn reply_from(v: Option<&Value>) -> Option<ReplyRef> {
    ReplyRef::from_value(v?)
}

pub(crate) fn file_meta_from(v: Option<&Value>) -> Option<LegacyFileMeta> {
    let o = v?.as_object()?;
    Some(LegacyFileMeta {
        name: o.get("name")?.as_str()?.to_owned(),
        mime: o.get("mime")?.as_str()?.to_owned(),
        size: o.get("size")?.as_u64()?,
        sha256: o.get("sha256")?.as_str()?.to_owned(),
    })
}

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("the database could not be opened or read")]
    Database,
    #[error("the database is not a PrivCord database")]
    NotPrivcord,
}

pub(crate) fn reactions_from(v: Option<&Value>) -> Vec<(String, String)> {
    v.and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .filter_map(|(u, e)| Some((u.clone(), e.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

/// Contacts as the desktop app and its backups write them (`ContactRecord`).
pub(crate) fn contacts_from_json(
    list: &[Value],
    muted: &std::collections::HashSet<String>,
) -> Vec<LegacyContact> {
    list.iter()
        .filter_map(|c| {
            let uid = c.get("uid")?.as_str()?;
            Some(LegacyContact {
                uid: uid.to_owned(),
                card: c.get("card").cloned().unwrap_or(Value::Null),
                nickname: c
                    .get("nickname")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .filter(|n| !n.is_empty()),
                trust: parse_trust(c.get("trust").and_then(Value::as_str).unwrap_or("")),
                checked: c.get("checked").and_then(Value::as_bool).unwrap_or(false),
                introduced_by: c
                    .get("introducedBy")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                created_at: c.get("addedAt").and_then(Value::as_i64).unwrap_or(0),
                muted: muted.contains(uid),
            })
        })
        .collect()
}
