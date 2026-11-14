//! Keeping the devices of one account in step (docs/design/syncengine.md §5, step 4).
//!
//! * **Recording.** Every change this install stores that matters to the person (a message sent or received, a delete,
//!   a reaction, a contact, who is muted) becomes an entry in this device's sync log, automatically: the storage port is
//!   wrapped by [`Recorder`], so no code path can store a change and forget to sync it.
//! * **The self-mailbox.** Entries go to the account's self-mailbox on the relays (`privcord_crypto::selfbox`): a
//!   weekly label and key only the account's devices can compute. Relays keep them for 7 days, so a device that comes
//!   online later still finds them.
//! * **Catching up.** On start and every few minutes, a device posts a short *hello* with how far it has each device's
//!   log; any other device that has more answers with exactly the missing entries. That also covers anything older
//!   than the relays keep.
//! * **Applying.** Entries from another device go through the sync log's merge rules, then into storage the way a
//!   restored backup does (nothing that exists is replaced), with the recorder quiet so they are not recorded again.
//!
//! Which devices count: this install's own device list, and the lists of other installs of the same account that
//! verify against the account's keys (an install restored from the recovery phrase). Linking a device by QR code adds
//! to the same list once its screens are in.
//!
//! "Sent means synced": entries are posted on the first tick after they are written, before the store-and-forward
//! pass of the same tick. ponytail: a message delivered over a direct link in the second before that tick is ahead of
//! its sync copy; holding delivery for the copy comes with the delivery rework (step 5).

use super::{Core, StorageOp, StoredContactState};
use crate::{api::EngineEvent, error::ErrorCode};
use privcord_crypto::{
    card::ContactCard,
    devices::DeviceList,
    identity::Identity,
    selfbox::SelfBox,
    synclog::{kind, Entry, Replica, Summary, Writer},
};
use privcord_domain::{blob::SealedBlob, signaling::PutKind, ConversationId, MessageId, UserId};
use privcord_import::{backup::read_bundle, import, FileSource, Source};
use privcord_ports::{
    OutboxEntry, Storage, StorageError, StoredContact, StoredFile, StoredMessage, StoredReaction,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

const KV_WRITER: &str = "sync.writer";
const KV_INDEX: &str = "sync.index";
const KV_LISTS: &str = "sync.lists";
const KV_PUSHED: &str = "sync.pushed";
/// Set on an install that restored an existing account from its recovery phrase.
const KV_JOINED: &str = "sync.joined";
/// Contacts and groups are not merge-rule kinds of the log; the engine applies them (unknown kinds pass through).
const KIND_CONTACT: &str = "contact";
/// One group's signed events (membership, name): merged event by event, each one checked again.
const KIND_GROUP: &str = "group";
/// Set once this install has put the history it had before sync into its log.
const KV_BACKFILLED: &str = "sync.backfilled";
const SETTING_MUTED: &str = "muted";
const HELLO_EVERY_MS: i64 = 10 * 60 * 1000;
/// An answer to a hello is sent at most this often (several devices may ask at once).
const ANSWER_GAP_MS: i64 = 20 * 1000;
const RELAY_TTL_SEC: u32 = 7 * 24 * 3600;
/// Plaintext per blob, below what relays accept.
const BATCH_BYTES: usize = 24 * 1024;
/// Entries one answer carries at most; the rest follow on the next hello.
const ANSWER_MAX: usize = 400;

fn entry_key(device: &str, series: u32, seq: u64) -> String {
    format!("sync.e.{device}.{series}.{seq}")
}

/* ------------------------------------------------------------------ recorder */

/// The storage port, wrapped: changes worth syncing are queued for the sync log as they are stored.
pub(crate) struct Recorder {
    inner: Arc<dyn Storage>,
    queue: Mutex<Vec<StorageOp>>,
    quiet: AtomicBool,
}

impl Recorder {
    pub(crate) fn new(inner: Arc<dyn Storage>) -> Self {
        Self {
            inner,
            queue: Mutex::new(Vec::new()),
            quiet: AtomicBool::new(false),
        }
    }

    fn take(&self) -> Vec<StorageOp> {
        self.queue
            .lock()
            .map(|mut q| std::mem::take(&mut *q))
            .unwrap_or_default()
    }

    fn quiet(&self, on: bool) {
        self.quiet.store(on, Ordering::SeqCst);
    }

    /// Queues changes as if they had just been stored (the history that predates sync).
    fn push(&self, ops: Vec<StorageOp>) {
        if let Ok(mut q) = self.queue.lock() {
            q.extend(ops);
        }
    }
}

impl Storage for Recorder {
    fn apply(&self, batch: &[StorageOp]) -> Result<(), StorageError> {
        self.inner.apply(batch)?;
        if self.quiet.load(Ordering::SeqCst) {
            return Ok(());
        }
        let worth: Vec<StorageOp> = batch
            .iter()
            .filter(|op| match op {
                StorageOp::InsertMessage(m) => {
                    !matches!(m.conversation, ConversationId::Channel(_))
                }
                StorageOp::Tombstone(_)
                | StorageOp::DeleteMessage(_)
                | StorageOp::SetReaction { .. }
                | StorageOp::PutContact(_) => true,
                StorageOp::SetKv { key, .. } => {
                    key == super::social::KV_MUTED || key == super::KV_GROUPS
                }
                // A message read here (the engine decides below whether it was someone else's).
                StorageOp::SetDelivery {
                    read_at: Some(_), ..
                } => true,
                _ => false,
            })
            .cloned()
            .collect();
        if !worth.is_empty() {
            if let Ok(mut q) = self.queue.lock() {
                // ponytail: bounded so a long run without an identity cannot grow it forever.
                if q.len() < 100_000 {
                    q.extend(worth);
                }
            }
        }
        Ok(())
    }
    fn contacts(&self) -> Result<Vec<StoredContact>, StorageError> {
        self.inner.contacts()
    }
    fn messages(&self) -> Result<Vec<StoredMessage>, StorageError> {
        self.inner.messages()
    }
    fn outbox(&self) -> Result<Vec<OutboxEntry>, StorageError> {
        self.inner.outbox()
    }
    fn kv(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        self.inner.kv(key)
    }
    fn file(&self, id: &MessageId) -> Result<Option<StoredFile>, StorageError> {
        self.inner.file(id)
    }
    fn file_info(&self, id: &MessageId) -> Result<Option<privcord_ports::FileInfo>, StorageError> {
        self.inner.file_info(id)
    }
    fn reactions(&self) -> Result<Vec<StoredReaction>, StorageError> {
        self.inner.reactions()
    }
    fn deleted(&self) -> Result<Vec<MessageId>, StorageError> {
        self.inner.deleted()
    }
}

/* ------------------------------------------------------------------ state */

pub(super) struct SyncState {
    device: Identity,
    writer: Writer,
    replica: Replica,
    /// Other devices of this account seen so far.
    others: BTreeSet<String>,
    /// Device lists of other installs, as received (kept to vouch for them again after a restart).
    lists: Vec<String>,
    subscribed: Vec<String>,
    last_hello: i64,
    last_answer: i64,
    /// Our own entries up to this number have been posted.
    pushed: u64,
    /// How many events of each group were last put in the log.
    group_counts: BTreeMap<String, usize>,
}

struct NoFiles;
impl FileSource for NoFiles {
    fn file(&self, _message_id: &str) -> Option<Vec<u8>> {
        None
    }
}

impl Core {
    fn kv_json<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.ports
            .storage
            .kv(key)
            .ok()
            .flatten()
            .and_then(|b| serde_json::from_slice(&b).ok())
    }

    /// Loads (or starts) this device's sync log. Runs whenever the identity and device are known.
    pub(super) fn ensure_sync(&mut self, device: Identity) -> Result<(), ErrorCode> {
        let (Some(list), Some(id)) = (self.device_list.clone(), self.device_id.clone()) else {
            self.sync = None;
            return Ok(());
        };
        let now = self.now();
        let writer = self
            .kv_json::<Writer>(KV_WRITER)
            .filter(|w| w.device == id)
            .unwrap_or_else(|| Writer::new(&id, 1));
        let mut replica = Replica::new(list);
        let mut others = BTreeSet::new();
        let lists: Vec<String> = self.kv_json(KV_LISTS).unwrap_or_default();
        if let Some(account) = &self.identity {
            let (sign, dh) = (account.sign_public(), account.dh_public());
            for text in &lists {
                if let Ok(l) = DeviceList::from_json(text) {
                    if l.verify(&sign, &dh).is_ok() {
                        replica.vouch(&l);
                        others.extend(l.devices.iter().map(|d| d.id.clone()).filter(|d| d != &id));
                    }
                }
            }
        }
        // ponytail: every entry is read and checked again at start; a stored snapshot when logs get long (step 8).
        let index: BTreeMap<String, u64> = self.kv_json(KV_INDEX).unwrap_or_default();
        for (stream, have) in &index {
            let Some((dev, series)) = stream.rsplit_once('/') else {
                continue;
            };
            let Ok(series) = series.parse::<u32>() else {
                continue;
            };
            for seq in 1..=*have {
                if let Some(e) = self.kv_json::<Entry>(&entry_key(dev, series, seq)) {
                    replica.receive(e, now);
                }
            }
        }
        let pushed = self.kv_json(KV_PUSHED).unwrap_or(0);
        let group_counts = self
            .kv_json::<BTreeMap<String, Vec<Value>>>(super::KV_GROUPS)
            .unwrap_or_default()
            .into_iter()
            .map(|(id, events)| (id, events.len()))
            .collect();
        self.sync = Some(SyncState {
            device,
            writer,
            replica,
            others,
            lists,
            subscribed: Vec::new(),
            last_hello: i64::MIN / 2,
            last_answer: i64::MIN / 2,
            pushed,
            group_counts,
        });
        Ok(())
    }

    /// Other devices of this account seen so far (none until another install of it shows up).
    pub fn sync_devices(&self) -> Vec<String> {
        self.sync
            .as_ref()
            .map(|s| s.others.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// The merged sync state's fingerprint, for checks.
    pub fn sync_fingerprint(&self) -> Option<String> {
        self.sync.as_ref().map(|s| s.replica.state().fingerprint())
    }

    fn index_value(replica: &Replica) -> Vec<u8> {
        serde_json::to_vec(&replica.summary()).unwrap_or_default()
    }

    /// Turns what was stored since the last tick into entries of this device's log.
    fn record(&mut self) {
        let ops = self.recorder.take();
        if ops.is_empty() || self.sync.is_none() {
            return;
        }
        let now = self.now();
        let mut items: Vec<(&'static str, Value)> = Vec::new();
        for op in ops {
            match op {
                StorageOp::InsertMessage(row) => {
                    let mut v = self.row_json(&row);
                    if let Some(o) = v.as_object_mut() {
                        // Who it still has to reach, its reactions and deletion travel separately.
                        for k in ["recipients", "reactions", "deleted"] {
                            o.remove(k);
                        }
                        o.insert("id".into(), json!(row.message.message_id));
                        o.insert("conv".into(), json!(row.conversation.storage_key()));
                    }
                    items.push((kind::MESSAGE, v));
                }
                StorageOp::Tombstone(id) => items.push((kind::DELETE, json!({ "target": id }))),
                StorageOp::DeleteMessage(id) => items.push((kind::HIDE, json!({ "target": id }))),
                StorageOp::SetReaction {
                    message_id,
                    uid,
                    emoji,
                } => items.push((
                    kind::REACT,
                    json!({ "target": message_id, "by": uid, "emoji": emoji }),
                )),
                StorageOp::PutContact(stored) => {
                    if let Some(contact) =
                        ContactCard::decode(&stored.card).filter(|c| c.uid == stored.uid)
                    {
                        let v = Self::contact_json(&StoredContactState { stored, contact });
                        items.push((KIND_CONTACT, v));
                    }
                }
                StorageOp::SetKv { key, value } if key == super::KV_GROUPS => {
                    let groups: BTreeMap<String, Vec<Value>> =
                        serde_json::from_slice(&value).unwrap_or_default();
                    for (id, events) in groups {
                        let known = self
                            .sync
                            .as_ref()
                            .and_then(|s| s.group_counts.get(&id))
                            .copied();
                        if known == Some(events.len()) {
                            continue;
                        }
                        if let Some(s) = self.sync.as_mut() {
                            s.group_counts.insert(id.clone(), events.len());
                        }
                        items.push((KIND_GROUP, json!({ "id": id, "events": events })));
                    }
                }
                StorageOp::SetKv { value, .. } => {
                    let list: Value = serde_json::from_slice(&value).unwrap_or(json!([]));
                    items.push((
                        kind::SETTING,
                        json!({ "key": SETTING_MUTED, "value": list }),
                    ));
                }
                StorageOp::SetDelivery { id, .. } => {
                    // Only messages from someone else count as read; our own messages' ticks are not synced.
                    let theirs = self
                        .messages
                        .get(&id)
                        .is_some_and(|m| Some(&m.message.sender_id) != self.uid.as_ref());
                    if theirs {
                        items.push((kind::SEEN, json!({ "target": id })));
                    }
                }
                _ => {}
            }
        }
        let Some(sync) = self.sync.as_mut() else {
            return;
        };
        let mut batch = Vec::new();
        for (k, body) in items {
            sync.writer.observe(sync.replica.clock, now);
            let Ok(e) = sync.writer.append(&sync.device, k, body, now) else {
                continue;
            };
            batch.push(StorageOp::SetKv {
                key: entry_key(&e.device, e.series, e.seq),
                value: serde_json::to_vec(&e).unwrap_or_default(),
            });
            sync.replica.receive(e, now);
        }
        if batch.is_empty() {
            return;
        }
        // The counter is saved with the entries, before any of them leaves this device (risk 15).
        batch.push(StorageOp::SetKv {
            key: KV_WRITER.into(),
            value: serde_json::to_vec(&sync.writer).unwrap_or_default(),
        });
        batch.push(StorageOp::SetKv {
            key: KV_INDEX.into(),
            value: Self::index_value(&sync.replica),
        });
        let _ = self.ports.storage.apply(&batch);
    }

    /// Posts `payload` to this week's self-mailbox.
    fn post_self(&mut self, payload: &Value) -> bool {
        let now = self.now();
        let Some(account) = self.identity.as_ref() else {
            return false;
        };
        let Ok([this_week, _]) = SelfBox::current(account, now) else {
            return false;
        };
        let Ok(blob) = this_week.seal(account, payload, &mut *self.ports.entropy) else {
            return false;
        };
        self.ports
            .transport
            .signal_put(
                &this_week.label,
                &blob.encode(),
                PutKind::Msg,
                RELAY_TTL_SEC,
            )
            .is_ok()
    }

    /// Posts entries in batches that fit a relay event.
    fn post_entries(&mut self, entries: Vec<Entry>) -> bool {
        let Some(list) = self.device_list.as_ref().map(DeviceList::to_json) else {
            return false;
        };
        let mut batch: Vec<Value> = Vec::new();
        let mut size = 0;
        let mut ok = true;
        for e in entries {
            let v = serde_json::to_value(&e).unwrap_or(Value::Null);
            let n = v.to_string().len();
            if n > BATCH_BYTES {
                // Too big for one relay event (a very long message with a large card): it waits for a direct sync
                // between the devices instead of holding up everything after it.
                continue;
            }
            if !batch.is_empty() && size + n > BATCH_BYTES {
                ok &= self.post_self(
                    &json!({ "t": "entries", "list": list, "entries": std::mem::take(&mut batch) }),
                );
                size = 0;
            }
            size += n;
            batch.push(v);
        }
        if !batch.is_empty() {
            ok &= self.post_self(&json!({ "t": "entries", "list": list, "entries": batch }));
        }
        ok
    }

    fn post_hello(&mut self) {
        let (Some(sync), Some(list)) = (self.sync.as_ref(), self.device_list.as_ref()) else {
            return;
        };
        let payload =
            json!({ "t": "hello", "list": list.to_json(), "summary": sync.replica.summary() });
        if self.post_self(&payload) {
            if let Some(s) = self.sync.as_mut() {
                s.last_hello = self.ports.clock.now_ms();
            }
        }
    }

    /// Runs every engine tick, before the store-and-forward pass.
    pub(super) fn tick_sync(&mut self) {
        self.record();
        if self.sync.is_none() || self.identity.is_none() {
            return;
        }
        if !self.ports.transport.signal_available() {
            if let Some(s) = self.sync.as_mut() {
                s.subscribed.clear();
            }
            return;
        }
        let now = self.now();
        let labels: Vec<String> = match self.identity.as_ref().map(|a| SelfBox::current(a, now)) {
            Some(Ok(boxes)) => boxes.iter().map(|b| b.label.clone()).collect(),
            _ => return,
        };
        let mut fresh = false;
        for label in &labels {
            let known = self
                .sync
                .as_ref()
                .is_some_and(|s| s.subscribed.contains(label));
            if !known && self.ports.transport.signal_subscribe(label).is_ok() {
                if let Some(s) = self.sync.as_mut() {
                    s.subscribed.push(label.clone());
                    fresh = true;
                }
            }
        }
        if let Some(s) = self.sync.as_mut() {
            s.subscribed.retain(|l| labels.contains(l));
        }
        // A lone install posts nothing at all (risk 25): it only listens. It says hello once it knows another device of
        // the account, or when it was itself set up from the recovery phrase (it is joining an account that already
        // has a device).
        let joined = matches!(self.ports.storage.kv(KV_JOINED), Ok(Some(_)));
        let talk = joined || self.sync.as_ref().is_some_and(|s| !s.others.is_empty());
        let due = self
            .sync
            .as_ref()
            .is_some_and(|s| now - s.last_hello >= HELLO_EVERY_MS);
        if talk && (fresh || due) {
            self.post_hello();
        }
        // Our own new entries, once there is another device to read them.
        let Some(s) = self.sync.as_ref() else { return };
        if s.others.is_empty() {
            return;
        }
        let (device, series, pushed) = (s.writer.device.clone(), s.writer.series, s.pushed);
        let mut summary = Summary::new();
        summary.insert(format!("{device}/{series}"), pushed);
        let mine: Vec<Entry> = s
            .replica
            .missing_for(&summary, ANSWER_MAX)
            .into_iter()
            .filter(|e| e.device == device && e.series == series)
            .collect();
        let Some(top) = mine.last().map(|e| e.seq) else {
            return;
        };
        if self.post_entries(mine) {
            if let Some(s) = self.sync.as_mut() {
                s.pushed = top;
            }
            let _ = self.ports.storage.apply(&[StorageOp::SetKv {
                key: KV_PUSHED.into(),
                value: serde_json::to_vec(&top).unwrap_or_default(),
            }]);
        }
    }

    /// Is this mailbox one of our self-mailboxes?
    pub(super) fn is_self_mailbox(&self, mailbox: &str) -> bool {
        self.sync
            .as_ref()
            .is_some_and(|s| s.subscribed.iter().any(|l| l == mailbox))
    }

    /// A blob arrived on our self-mailbox.
    pub(super) fn sync_blob(&mut self, mailbox: &str, blob: &SealedBlob) {
        let now = self.now();
        let Some(account) = self.identity.as_ref() else {
            return;
        };
        let Ok(boxes) = SelfBox::current(account, now) else {
            return;
        };
        let Some(payload) = boxes
            .iter()
            .find(|b| b.label == mailbox)
            .and_then(|b| b.open(account, blob))
        else {
            return;
        };
        // The author's device list, checked against the account's keys.
        let (sign, dh) = (account.sign_public(), account.dh_public());
        let Some(text) = payload.get("list").and_then(Value::as_str) else {
            return;
        };
        let Ok(list) = DeviceList::from_json(text) else {
            return;
        };
        if list.verify(&sign, &dh).is_err() {
            return;
        }
        if self.learn_list(&list, text) {
            // A device we did not know: tell it about us, so it starts posting what it writes, and give it our history.
            self.backfill();
            self.record();
            self.post_hello();
        }
        match payload.get("t").and_then(Value::as_str) {
            Some("hello") => {
                let theirs: Summary = payload
                    .get("summary")
                    .and_then(|s| serde_json::from_value(s.clone()).ok())
                    .unwrap_or_default();
                self.answer_hello(&theirs, now);
            }
            Some("entries") => {
                let entries: Vec<Entry> = payload
                    .get("entries")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| serde_json::from_value(v.clone()).ok())
                            .collect()
                    })
                    .unwrap_or_default();
                self.take_entries(entries, now);
            }
            _ => {}
        }
    }

    /// Puts what this install held before sync into its log, once: contacts, groups, messages (newest first), their
    /// reactions, deletions and read marks. Runs when another device of the account first shows up, so that device
    /// gets the whole history, not only what changes from now on.
    fn backfill(&mut self) {
        if matches!(self.ports.storage.kv(KV_BACKFILLED), Ok(Some(_))) {
            return;
        }
        let mut ops: Vec<StorageOp> = self
            .contacts
            .values()
            .map(|c| StorageOp::PutContact(c.stored.clone()))
            .collect();
        if let Ok(Some(value)) = self.ports.storage.kv(super::KV_GROUPS) {
            if let Some(s) = self.sync.as_mut() {
                s.group_counts.clear();
            }
            ops.push(StorageOp::SetKv {
                key: super::KV_GROUPS.into(),
                value,
            });
        }
        let mut rows: Vec<&StoredMessage> = self
            .messages
            .values()
            .filter(|m| !matches!(m.conversation, ConversationId::Channel(_)))
            .collect();
        rows.sort_by_key(|m| std::cmp::Reverse(m.message.client_created_at));
        for m in rows {
            let id = m.message.message_id.clone();
            ops.push(StorageOp::InsertMessage(m.clone()));
            if self.deleted.contains(&id) {
                ops.push(StorageOp::Tombstone(id.clone()));
            }
            if m.message.read_at.is_some() {
                ops.push(StorageOp::SetDelivery {
                    id: id.clone(),
                    state: m.message.delivery_state,
                    read_at: m.message.read_at,
                });
            }
            for (uid, emoji) in self.reactions.get(&id).into_iter().flatten() {
                ops.push(StorageOp::SetReaction {
                    message_id: id.clone(),
                    uid: uid.clone(),
                    emoji: Some(emoji.clone()),
                });
            }
        }
        if let Ok(list) =
            serde_json::to_vec(&self.muted.iter().map(UserId::as_str).collect::<Vec<_>>())
        {
            ops.push(StorageOp::SetKv {
                key: super::social::KV_MUTED.into(),
                value: list,
            });
        }
        self.recorder.push(ops);
        let _ = self.ports.storage.apply(&[StorageOp::SetKv {
            key: KV_BACKFILLED.into(),
            value: b"1".to_vec(),
        }]);
    }

    /// Marks this install as joining an account that already exists (restored from the recovery phrase).
    pub(super) fn mark_joined(&mut self) {
        let _ = self.ports.storage.apply(&[StorageOp::SetKv {
            key: KV_JOINED.into(),
            value: b"1".to_vec(),
        }]);
    }

    /// Remembers another install's device list. Returns whether it named a device we did not know.
    fn learn_list(&mut self, list: &DeviceList, text: &str) -> bool {
        let own = self.device_id.clone().unwrap_or_default();
        let Some(s) = self.sync.as_mut() else {
            return false;
        };
        let ids: Vec<String> = list
            .devices
            .iter()
            .map(|d| d.id.clone())
            .filter(|d| d != &own)
            .collect();
        if ids.iter().all(|d| s.others.contains(d)) {
            return false;
        }
        s.replica.vouch(list);
        s.others.extend(ids);
        s.lists.push(text.to_owned());
        let value = serde_json::to_vec(&s.lists).unwrap_or_default();
        let _ = self.ports.storage.apply(&[StorageOp::SetKv {
            key: KV_LISTS.into(),
            value,
        }]);
        true
    }

    /// Another device said how far it has each log: send what it lacks, and ask for what we lack.
    fn answer_hello(&mut self, theirs: &Summary, now: i64) {
        let Some(s) = self.sync.as_ref() else { return };
        if now - s.last_answer < ANSWER_GAP_MS {
            return;
        }
        let missing = s.replica.missing_for(theirs, ANSWER_MAX);
        let ours = s.replica.summary();
        let behind = theirs
            .iter()
            .any(|(k, v)| ours.get(k).copied().unwrap_or(0) < *v);
        if !missing.is_empty() && self.post_entries(missing) {
            if let Some(s) = self.sync.as_mut() {
                s.last_answer = now;
            }
        }
        if behind {
            self.post_hello();
        }
    }

    /// Entries from another device (or echoes of ours): through the merge rules, then into storage.
    fn take_entries(&mut self, entries: Vec<Entry>, now: i64) {
        let own = self.device_id.clone().unwrap_or_default();
        if let Some(s) = self.sync.as_mut() {
            for e in entries {
                // Held-back entries are applied when their gap fills; a refused one is simply dropped.
                let _ = s.replica.receive(e, now);
            }
        }
        // Everything the log now holds beyond what storage holds: keep it, and apply what other devices wrote.
        let stored: Summary = self.kv_json(KV_INDEX).unwrap_or_default();
        let Some(s) = self.sync.as_ref() else { return };
        let new_entries = s.replica.missing_for(&stored, usize::MAX);
        if new_entries.is_empty() {
            return;
        }
        let mut keep: Vec<StorageOp> = new_entries
            .iter()
            .map(|e| StorageOp::SetKv {
                key: entry_key(&e.device, e.series, e.seq),
                value: serde_json::to_vec(e).unwrap_or_default(),
            })
            .collect();
        keep.push(StorageOp::SetKv {
            key: KV_INDEX.into(),
            value: Self::index_value(&s.replica),
        });
        let _ = self.ports.storage.apply(&keep);
        let applied: Vec<Entry> = new_entries
            .into_iter()
            .filter(|e| e.device != own)
            .collect();
        self.apply_entries(&applied);
    }

    /// Writes other devices' entries into storage, without recording them again.
    fn apply_entries(&mut self, entries: &[Entry]) {
        if entries.is_empty() {
            return;
        }
        let Some(own) = self.uid.clone() else { return };
        let mut messages = Vec::new();
        let mut contacts = Vec::new();
        let mut touched: BTreeSet<String> = BTreeSet::new();
        let mut muted: Option<Value> = None;
        let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
        for e in entries {
            match e.kind.as_str() {
                kind::MESSAGE => {
                    if let Some(id) = e.body.get("id").and_then(Value::as_str) {
                        touched.insert(id.to_owned());
                    }
                    messages.push(e.body.clone());
                }
                kind::DELETE | kind::HIDE | kind::REACT => {
                    if let Some(id) = e.body.get("target").and_then(Value::as_str) {
                        touched.insert(id.to_owned());
                    }
                }
                KIND_CONTACT => contacts.push(e.body.clone()),
                KIND_GROUP => {
                    if let (Some(id), Some(events)) = (
                        e.body.get("id").and_then(Value::as_str),
                        e.body.get("events").and_then(Value::as_array),
                    ) {
                        groups.push((id.to_owned(), events.clone()));
                    }
                }
                kind::SEEN => {
                    if let Some(id) = e.body.get("target").and_then(Value::as_str) {
                        touched.insert(id.to_owned());
                    }
                }
                kind::SETTING
                    if e.body.get("key").and_then(Value::as_str) == Some(SETTING_MUTED) =>
                {
                    muted = self
                        .sync
                        .as_ref()
                        .and_then(|s| s.replica.state().setting(SETTING_MUTED).cloned());
                }
                _ => {}
            }
        }
        self.recorder.quiet(true);
        let now = self.now();
        if !messages.is_empty() || !contacts.is_empty() {
            let data = json!({ "v": 1, "uid": own, "contacts": contacts, "messages": messages });
            if let Some((_, bundle)) = read_bundle(&data) {
                let _ = import(
                    &bundle,
                    Source::Backup,
                    &NoFiles,
                    &own,
                    &*self.ports.storage,
                    now,
                );
            }
        }
        // Groups: each event is checked again and added to what this install has (never replacing it).
        if !groups.is_empty() {
            let mut saved: BTreeMap<String, Vec<Value>> =
                self.kv_json(super::KV_GROUPS).unwrap_or_default();
            for (id, events) in groups {
                let mut log = privcord_crypto::group::GroupLog::new(&id);
                for e in saved.get(&id).into_iter().flatten().chain(events.iter()) {
                    let _ = log.add(e);
                }
                let all: Vec<Value> = log
                    .all()
                    .iter()
                    .map(privcord_crypto::group::GroupEvent::to_value)
                    .collect();
                if !all.is_empty() {
                    if let Some(s) = self.sync.as_mut() {
                        s.group_counts.insert(id.clone(), all.len());
                    }
                    saved.insert(id, all);
                }
            }
            if let Ok(value) = serde_json::to_vec(&saved) {
                let _ = self.ports.storage.apply(&[StorageOp::SetKv {
                    key: super::KV_GROUPS.into(),
                    value,
                }]);
            }
        }
        // Deletes and reactions, as the merged state has them, for every message these entries touched (in any
        // order: a reaction that came before its message is applied now that the message is here).
        let mut ops: Vec<StorageOp> = Vec::new();
        // Unread messages as storage has them now (just imported ones included), read once.
        let unread: std::collections::HashMap<MessageId, privcord_domain::message::DeliveryState> =
            self.ports
                .storage
                .messages()
                .unwrap_or_default()
                .into_iter()
                .filter(|m| {
                    m.message.read_at.is_none() && touched.contains(m.message.message_id.as_str())
                })
                .map(|m| (m.message.message_id, m.message.delivery_state))
                .collect();
        if let Some(s) = self.sync.as_ref() {
            let state = s.replica.state();
            for id in &touched {
                let Ok(mid) = MessageId::new(id.as_str()) else {
                    continue;
                };
                if state.is_deleted(id) {
                    ops.push(StorageOp::Tombstone(mid));
                    continue;
                }
                if state.is_hidden(id) {
                    ops.push(StorageOp::DeleteMessage(mid));
                    continue;
                }
                if state.is_seen(id) {
                    if let Some(delivery) = unread.get(&mid) {
                        ops.push(StorageOp::SetDelivery {
                            id: mid.clone(),
                            state: *delivery,
                            read_at: Some(now),
                        });
                    }
                }
                for (by, emoji) in state.reactions_raw(id) {
                    if let Ok(uid) = UserId::new(by.as_str()) {
                        ops.push(StorageOp::SetReaction {
                            message_id: mid.clone(),
                            uid,
                            emoji,
                        });
                    }
                }
            }
        }
        if let Some(list) = muted {
            ops.push(StorageOp::SetKv {
                key: super::social::KV_MUTED.into(),
                value: serde_json::to_vec(&list).unwrap_or_default(),
            });
        }
        // One at a time: a reaction to a message this device never got must not stop the rest.
        for op in ops {
            let _ = self.ports.storage.apply(std::slice::from_ref(&op));
        }
        self.recorder.quiet(false);
        if self.reload_from_storage().is_ok() {
            self.hub.publish(EngineEvent::Restored);
        }
    }
}
