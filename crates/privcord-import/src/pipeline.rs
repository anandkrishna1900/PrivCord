use crate::{FileSource, LegacyBundle, LegacyMessage, Source};
use privcord_crypto::{card::ContactCard, group::GroupLog};
use privcord_domain::{
    channel::normalize_channel_name,
    codec,
    files::{file_preview_text, sha256_b64, validate_file_size},
    limits::MAX_TEXT_LENGTH,
    message::{ChatMessage, DeliveryState, MessageKind},
    privacy::ContactTrust,
    social::REACTION_EMOJI,
    ConversationId, GroupId, MessageId, UserId,
};
use privcord_ports::{
    OutboxEntry, Storage, StorageError, StorageOp, StoredContact, StoredFile, StoredMessage,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const KV_GROUPS: &str = "groups.v1";
const KV_CHANNELS: &str = "channels.v1";
const BATCH: usize = 100;

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("the new storage refused a write; nothing was lost, run the import again")]
    Storage(#[from] StorageError),
}

/// What happened. `skipped` says why each thing that did not come over was left behind.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ImportReport {
    /// This source had already been imported completely; nothing was done.
    pub already_done: bool,
    pub contacts: usize,
    pub groups: usize,
    pub channels: usize,
    pub messages: usize,
    pub files: usize,
    pub outbox: usize,
    pub skipped: BTreeMap<&'static str, usize>,
}

impl ImportReport {
    fn skip(&mut self, why: &'static str) {
        *self.skipped.entry(why).or_insert(0) += 1;
    }
}

fn marker_key(source: Source) -> String {
    format!("import.done.{}", source.as_str())
}

/// Write what holds up from `bundle` into `storage`. `own_uid` is whose data this is (group events are checked against
/// it); `files` supplies file bytes by message id.
pub fn import(
    bundle: &LegacyBundle,
    source: Source,
    files: &dyn FileSource,
    own_uid: &UserId,
    storage: &dyn Storage,
    now_ms: i64,
) -> Result<ImportReport, ImportError> {
    let mut report = ImportReport::default();
    let marked = source != Source::Backup;
    if marked && storage.kv(&marker_key(source))?.is_some() {
        report.already_done = true;
        return Ok(report);
    }

    // ---- contacts: the card must verify and give the uid the old app recorded
    let existing: BTreeMap<UserId, StoredContact> = storage
        .contacts()?
        .into_iter()
        .map(|c| (c.uid.clone(), c))
        .collect();
    let mut known: BTreeSet<UserId> = existing.keys().cloned().collect();
    let mut batch = Vec::new();
    for c in &bundle.contacts {
        let Some(contact) = ContactCard::from_value(&c.card) else {
            report.skip("contact_card_not_valid");
            continue;
        };
        // The old apps recorded the v1 id (from the ECDH key alone). It is kept as recorded here, under that id, and the
        // engine moves it (and every chat under it) to the v2 id when it starts.
        let legacy = privcord_crypto::identity::legacy_uid(&contact.card.dh).ok();
        let recorded = if contact.uid.as_str() == c.uid {
            contact.uid.clone()
        } else if let Some(old) = legacy.filter(|u| u.as_str() == c.uid) {
            old
        } else {
            report.skip("contact_uid_mismatch");
            continue;
        };
        if &recorded == own_uid || &contact.uid == own_uid {
            report.skip("contact_uid_mismatch");
            continue;
        }
        let Ok(text) = contact.card.encode() else {
            report.skip("contact_card_not_valid");
            continue;
        };
        // Meeting someone again never lowers trust.
        let prior = existing.get(&recorded);
        let trust = if prior.is_some_and(|p| p.trust == ContactTrust::Verified) {
            ContactTrust::Verified
        } else {
            c.trust
        };
        batch.push(StorageOp::PutContact(StoredContact {
            uid: recorded.clone(),
            card: text,
            name: c.nickname.clone().or_else(|| contact.card.name.clone()),
            trust,
            checked: c.checked || prior.is_some_and(|p| p.checked),
            introduced_by: c.introduced_by.as_deref().and_then(|u| UserId::new(u).ok()),
            created_at: prior.map_or(c.created_at, |p| p.created_at),
        }));
        known.insert(recorded);
        report.contacts += 1;
    }
    if !batch.is_empty() {
        storage.apply(&batch)?;
    }

    // ---- groups: every event is re-verified; what does not verify is dropped
    let mut groups: BTreeMap<String, Vec<Value>> = storage
        .kv(KV_GROUPS)?
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    for (id, events) in &bundle.groups {
        if groups.contains_key(id) {
            continue;
        }
        let mut log = GroupLog::new(id);
        let mut applied = 0usize;
        for e in events {
            if matches!(log.add(e), privcord_crypto::group::AddStatus::Applied) {
                applied += 1;
            }
        }
        if applied == 0 {
            report.skip("group_has_no_valid_events");
            continue;
        }
        if applied < events.len() {
            report.skip("group_event_not_valid");
        }
        groups.insert(
            id.clone(),
            log.all()
                .iter()
                .map(privcord_crypto::group::GroupEvent::to_value)
                .collect(),
        );
        report.groups += 1;
    }
    let group_ids: BTreeSet<&str> = groups.keys().map(String::as_str).collect();

    // ---- channels
    let mut channels: BTreeSet<String> = storage
        .kv(KV_CHANNELS)?
        .and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok())
        .unwrap_or_default()
        .into_iter()
        .collect();
    for raw in &bundle.channels {
        match normalize_channel_name(raw) {
            Some(n) => {
                if channels.insert(n) {
                    report.channels += 1;
                }
            }
            None => report.skip("channel_name_not_valid"),
        }
    }

    // ---- messages, with their files and unsent entries, in atomic batches
    let only_contact = if known.len() == 1 {
        known.iter().next().cloned()
    } else {
        None
    };
    let mut ops: Vec<StorageOp> = Vec::new();
    let mut pending_messages = 0usize;
    for m in &bundle.messages {
        let Some((conversation, message)) =
            convert_message(m, &known, &group_ids, only_contact.as_ref(), &mut report)
        else {
            continue;
        };
        let id = message.message_id.clone();
        ops.push(StorageOp::InsertMessage(StoredMessage {
            conversation,
            message: message.clone(),
        }));
        if let (Some(meta), false) = (&m.file, m.deleted) {
            match files.file(&m.id) {
                None => report.skip("file_bytes_missing"),
                Some(bytes)
                    if bytes.len() as u64 != meta.size
                        || validate_file_size(bytes.len()).is_err()
                        || sha256_b64(&bytes) != meta.sha256 =>
                {
                    report.skip("file_failed_its_hash_check");
                }
                Some(bytes) => {
                    ops.push(StorageOp::PutFile(StoredFile {
                        message_id: id.clone(),
                        name: privcord_domain::files::sanitize_file_name(&meta.name),
                        mime: privcord_domain::files::sanitize_mime(&meta.mime),
                        bytes,
                    }));
                    report.files += 1;
                }
            }
        }
        if m.deleted {
            ops.push(StorageOp::Tombstone(id.clone()));
        } else {
            for (who, emoji) in &m.reactions {
                match (
                    UserId::new(who.as_str()),
                    REACTION_EMOJI.contains(&emoji.as_str()),
                ) {
                    (Ok(uid), true) => ops.push(StorageOp::SetReaction {
                        message_id: id.clone(),
                        uid,
                        emoji: Some(emoji.clone()),
                    }),
                    _ => report.skip("reaction_not_valid"),
                }
            }
        }
        if !m.deleted
            && matches!(
                message.delivery_state,
                DeliveryState::Queued | DeliveryState::Sent | DeliveryState::Failed
            )
            && message.sender_id == *own_uid
        {
            for (to, attempts) in &m.pending {
                if let Ok(recipient) = UserId::new(to.as_str()) {
                    ops.push(StorageOp::PutOutbox(OutboxEntry {
                        message_id: id.clone(),
                        recipient,
                        attempts: *attempts,
                        next_try_ms: now_ms,
                    }));
                    report.outbox += 1;
                }
            }
        }
        report.messages += 1;
        pending_messages += 1;
        if pending_messages >= BATCH {
            storage.apply(&std::mem::take(&mut ops))?;
            pending_messages = 0;
        }
    }

    // ---- muted people
    let mut muted: BTreeSet<String> = storage
        .kv("muted.v1")?
        .and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok())
        .unwrap_or_default()
        .into_iter()
        .collect();
    muted.extend(bundle.muted.iter().cloned());
    muted.extend(
        bundle
            .contacts
            .iter()
            .filter(|c| c.muted)
            .map(|c| c.uid.clone()),
    );

    // ---- settings and the marker, last
    ops.push(StorageOp::SetKv {
        key: "muted.v1".into(),
        value: serde_json::to_vec(&muted).unwrap_or_default(),
    });
    ops.push(StorageOp::SetKv {
        key: KV_GROUPS.into(),
        value: serde_json::to_vec(&groups).unwrap_or_default(),
    });
    ops.push(StorageOp::SetKv {
        key: KV_CHANNELS.into(),
        value: serde_json::to_vec(&channels).unwrap_or_default(),
    });
    if marked {
        ops.push(StorageOp::SetKv {
            key: marker_key(source),
            value: codec::hex(&now_ms.to_be_bytes()).into_bytes(),
        });
    }
    storage.apply(&ops)?;
    Ok(report)
}

/// One old message as the engine stores it, or `None` (counted) if it cannot come over.
fn convert_message(
    m: &LegacyMessage,
    known: &BTreeSet<UserId>,
    groups: &BTreeSet<&str>,
    only_contact: Option<&UserId>,
    report: &mut ImportReport,
) -> Option<(ConversationId, ChatMessage)> {
    let (Ok(id), Ok(client_id), Ok(sender)) = (
        MessageId::new(m.id.as_str()),
        MessageId::new(m.client_id.as_str()),
        UserId::new(m.sender.as_str()),
    ) else {
        report.skip("message_id_not_valid");
        return None;
    };
    let conversation = if let Some(name) = m.conversation.strip_prefix("chan:") {
        match normalize_channel_name(name) {
            Some(n) => ConversationId::Channel(n),
            None => {
                report.skip("channel_name_not_valid");
                return None;
            }
        }
    } else if groups.contains(m.conversation.as_str()) {
        ConversationId::Group(GroupId::new(m.conversation.as_str()).ok()?)
    } else if m.conversation.is_empty() || m.conversation == "duo" {
        // The pre-groups single chat: unambiguous only when there is exactly one friend.
        match only_contact {
            Some(u) => ConversationId::Direct(u.clone()),
            None => {
                report.skip("old_single_chat_with_several_friends");
                return None;
            }
        }
    } else {
        match UserId::new(m.conversation.as_str()) {
            Ok(u) if known.contains(&u) => ConversationId::Direct(u),
            _ => {
                report.skip("conversation_with_nobody_we_know");
                return None;
            }
        }
    };
    let (kind, text) = match &m.file {
        Some(meta) => (
            MessageKind::File,
            privcord_domain::files::sanitize_file_name(&meta.name),
        ),
        None => (MessageKind::Text, m.text.clone()),
    };
    if kind == MessageKind::Text
        && !m.deleted
        && (text.trim().is_empty() || text.chars().count() > MAX_TEXT_LENGTH)
    {
        report.skip("message_text_not_valid");
        return None;
    }
    let _ = file_preview_text(&text);
    Some((
        conversation,
        ChatMessage {
            message_id: id,
            client_message_id: client_id,
            sender_id: sender,
            text,
            client_created_at: m.created_at,
            kind,
            transport: m.transport,
            delivery_state: m.delivery,
            reply_to: if m.deleted { None } else { m.reply.clone() },
            read_at: m.read_at,
        },
    ))
}
