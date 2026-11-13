//! Encrypted backups (`engine.ts` "backup"): a passphrase-protected copy of friends, groups, channels, muted people and
//! messages (no files, no recovery phrase). The file is the one the apps make and read.

use super::{Core, StoredContactState};
use crate::{api::EngineEvent, error::ErrorCode};
use privcord_crypto::backup::{open_backup, seal_backup, BACKUP_MIN_PASSPHRASE};
use privcord_domain::{
    files::sha256_b64,
    message::{DeliveryState, MessageKind, TransportKind},
    privacy::ContactTrust,
    MessageId,
};
use privcord_import::{backup::read_bundle, import, FileSource, Source};
use serde_json::{json, Map, Value};

/// File bytes a backup carries at most (newest files first): enough for months of photos and voice notes, small
/// enough for a phone to build and read in memory.
const BACKUP_FILE_BUDGET: usize = 50 * 1024 * 1024;

/// The file bytes inside a backup, by message id (each is checked against its message's SHA-256 when restored).
struct BackupFiles<'a>(Option<&'a Map<String, Value>>);

impl FileSource for BackupFiles<'_> {
    fn file(&self, message_id: &str) -> Option<Vec<u8>> {
        privcord_domain::codec::decode(self.0?.get(message_id)?.as_str()?)
    }
}

/// What a restore added.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestoreSummary {
    pub friends: usize,
    pub groups: usize,
    pub messages: usize,
}

fn delivery_str(d: DeliveryState) -> &'static str {
    match d {
        DeliveryState::Queued => "QUEUED",
        DeliveryState::Sent => "SENT",
        DeliveryState::Delivered => "DELIVERED",
        DeliveryState::Read => "READ",
        DeliveryState::Failed => "FAILED",
    }
}

impl Core {
    fn contact_json(c: &StoredContactState) -> Value {
        let card = &c.contact.card;
        let mut card_json =
            json!({ "v": 1, "sign": card.sign, "dh": card.dh, "proof": card.proof });
        if let (Some(n), Some(o)) = (
            card.name.as_ref().filter(|n| !n.is_empty()),
            card_json.as_object_mut(),
        ) {
            o.insert("name".into(), json!(n));
        }
        let mut o = Map::new();
        o.insert("uid".into(), json!(c.stored.uid));
        o.insert("card".into(), card_json);
        o.insert(
            "trust".into(),
            json!(if c.stored.trust == ContactTrust::Verified {
                "verified"
            } else {
                "introduced"
            }),
        );
        if let Some(by) = &c.stored.introduced_by {
            o.insert("introducedBy".into(), json!(by));
        }
        // What we call them, if it differs from the name on their card.
        if c.stored.name != card.name {
            if let Some(n) = &c.stored.name {
                o.insert("nickname".into(), json!(n));
            }
        }
        o.insert("checked".into(), json!(c.stored.checked));
        o.insert("addedAt".into(), json!(c.stored.created_at));
        Value::Object(o)
    }

    fn message_json(&self, id: &MessageId) -> Option<Value> {
        let m = self.messages.get(id)?;
        let msg = &m.message;
        let mut o = Map::new();
        o.insert("messageId".into(), json!(msg.message_id));
        o.insert("clientMessageId".into(), json!(msg.client_message_id));
        o.insert("senderId".into(), json!(msg.sender_id));
        o.insert("text".into(), json!(msg.text));
        o.insert("clientCreatedAt".into(), json!(msg.client_created_at));
        let file = (msg.kind == MessageKind::File)
            .then(|| self.ports.storage.file(id).ok().flatten())
            .flatten();
        o.insert(
            "type".into(),
            json!(if file.is_some() { "file" } else { "text" }),
        );
        o.insert(
            "transport".into(),
            json!(if msg.transport == TransportKind::Relay {
                "relay"
            } else {
                "p2p"
            }),
        );
        o.insert(
            "deliveryState".into(),
            json!(delivery_str(msg.delivery_state)),
        );
        o.insert("readAt".into(), json!(msg.read_at));
        o.insert("conversationId".into(), json!(m.conversation.storage_key()));
        if let Some(r) = &msg.reply_to {
            o.insert("replyTo".into(), json!(r));
        }
        if let Some(f) = &file {
            o.insert(
                "file".into(),
                json!({ "name": f.name, "mime": f.mime, "size": f.bytes.len(), "sha256": sha256_b64(&f.bytes) }),
            );
        }
        if let Some(r) = self.reactions.get(id) {
            let map: Map<String, Value> =
                r.iter().map(|(u, e)| (u.to_string(), json!(e))).collect();
            o.insert("reactions".into(), Value::Object(map));
        }
        if self.deleted.contains(id) {
            o.insert("deleted".into(), json!(true));
        }
        // Who a message of ours still has to reach.
        let pending: Map<String, Value> = self
            .outbox
            .iter()
            .filter(|e| &e.message_id == id)
            .map(|e| {
                (
                    e.recipient.to_string(),
                    json!(delivery_str(msg.delivery_state)),
                )
            })
            .collect();
        if !pending.is_empty() {
            o.insert("recipients".into(), Value::Object(pending));
        }
        Some(Value::Object(o))
    }

    /// A passphrase-protected copy of friends, groups, channels, muted people and messages.
    pub fn export_backup(&mut self, passphrase: &str) -> Result<String, ErrorCode> {
        self.require_live()?;
        let uid = self.uid.clone().ok_or(ErrorCode::NoIdentity)?;
        if passphrase.encode_utf16().count() < BACKUP_MIN_PASSPHRASE {
            return Err(ErrorCode::WeakPassphrase);
        }
        let mut ids: Vec<&MessageId> = self.messages.keys().collect();
        ids.sort();
        // Photos, videos, voice notes and files: the newest first, as many as fit the budget.
        let mut newest: Vec<_> = self
            .messages
            .values()
            .filter(|m| {
                m.message.kind == MessageKind::File && !self.deleted.contains(&m.message.message_id)
            })
            .collect();
        newest.sort_by_key(|m| std::cmp::Reverse(m.message.client_created_at));
        let mut files = Map::new();
        let mut used = 0usize;
        for m in newest {
            if let Ok(Some(f)) = self.ports.storage.file(&m.message.message_id) {
                if used + f.bytes.len() > BACKUP_FILE_BUDGET {
                    continue;
                }
                used += f.bytes.len();
                files.insert(
                    m.message.message_id.to_string(),
                    json!(privcord_domain::codec::encode(&f.bytes)),
                );
            }
        }
        let data = json!({
            "v": 1,
            "uid": uid,
            "at": self.now(),
            "contacts": self.contacts.values().map(Self::contact_json).collect::<Vec<_>>(),
            "groups": self.groups.as_ref().map(|g| g.export()).unwrap_or_default(),
            "channels": self.channels.keys().collect::<Vec<_>>(),
            "blocked": self.muted.iter().collect::<Vec<_>>(),
            "messages": ids.into_iter().filter_map(|id| self.message_json(id)).collect::<Vec<_>>(),
            "files": files,
            "legacyGroups": self.legacy_groups_json(),
        });
        Ok(seal_backup(&data, passphrase, &mut *self.ports.entropy)?)
    }

    /// Add what is in a backup to what is here. Never replaces or removes anything that already exists. A wrong
    /// passphrase, a damaged file and a backup of somebody else are refused.
    pub fn import_backup(
        &mut self,
        text: &str,
        passphrase: &str,
    ) -> Result<RestoreSummary, ErrorCode> {
        self.require_live()?;
        let own = self.uid.clone().ok_or(ErrorCode::NoIdentity)?;
        let data = open_backup(text, passphrase).ok_or(ErrorCode::BackupUnreadable)?;
        let (owner, bundle) = read_bundle(&data).ok_or(ErrorCode::BackupUnreadable)?;
        // A backup made before protocol v2 names its owner by our v1 id: it is ours all the same. It goes in under that
        // id and the reload below moves it to the v2 id.
        let legacy = self
            .identity
            .as_ref()
            .and_then(|i| privcord_crypto::identity::legacy_uid(&i.dh_public()).ok());
        let owner_id = if owner == own.as_str() {
            own
        } else if let Some(old) = legacy.filter(|l| owner == l.as_str()) {
            old
        } else {
            return Err(ErrorCode::BackupNotYours);
        };
        let now = self.now();
        let report = import(
            &bundle,
            Source::Backup,
            &BackupFiles(data.get("files").and_then(Value::as_object)),
            &owner_id,
            &*self.ports.storage,
            now,
        )
        .map_err(|_| ErrorCode::Storage)?;
        self.reload_from_storage()?;
        // Groups from before protocol v2 that were still waiting to be made again come back as well.
        self.merge_legacy_groups_json(data.get("legacyGroups"));
        self.hub.publish(EngineEvent::Restored);
        Ok(RestoreSummary {
            friends: report.contacts,
            groups: report.groups,
            messages: report.messages,
        })
    }
}
