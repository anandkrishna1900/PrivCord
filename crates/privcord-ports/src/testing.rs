//! In-memory implementations of the ports, for tests and throwaway engines.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use crate::{
    Clock, EraseScope, IdentitySecrets, Notification, Notifier, OutboxEntry, SecureStore,
    SecureStoreError, Storage, StorageError, StorageOp, StoredContact, StoredFile, StoredMessage,
    StoredReaction, Transport, TransportError,
};
use privcord_domain::{signaling::PutKind, ConversationId, MessageId, UserId};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicI64, AtomicUsize, Ordering},
        Arc, Mutex, MutexGuard,
    },
};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A clock the test moves by hand.
#[derive(Debug, Default)]
pub struct FakeClock(AtomicI64);

impl FakeClock {
    pub fn at(ms: i64) -> Arc<Self> {
        Arc::new(Self(AtomicI64::new(ms)))
    }
    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Default, Clone)]
struct Data {
    contacts: HashMap<UserId, StoredContact>,
    messages: Vec<StoredMessage>,
    outbox: Vec<OutboxEntry>,
    kv: HashMap<String, Vec<u8>>,
    files: HashMap<MessageId, StoredFile>,
    reactions: Vec<StoredReaction>,
    deleted: Vec<MessageId>,
}

/// Atomic in-memory storage: a batch is applied to a copy and swapped in only if every op succeeds.
#[derive(Debug, Default)]
pub struct MemoryStorage {
    data: Mutex<Data>,
    fail_next: AtomicUsize,
    fail_at: AtomicUsize,
    applied: AtomicUsize,
}

impl MemoryStorage {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The next `n` calls to `apply` fail (as a crash or a full disk would), leaving nothing written.
    /// Make only the `n`th next `apply` fail (1 is the very next one); the others succeed.
    pub fn fail_apply_at(&self, n: usize) {
        self.fail_at.store(n, Ordering::SeqCst);
    }

    pub fn fail_next_applies(&self, n: usize) {
        self.fail_next.store(n, Ordering::SeqCst);
    }

    pub fn applied_batches(&self) -> usize {
        self.applied.load(Ordering::SeqCst)
    }
}

impl Storage for MemoryStorage {
    fn apply(&self, batch: &[StorageOp]) -> Result<(), StorageError> {
        if self.fail_at.load(Ordering::SeqCst) > 0
            && self.fail_at.fetch_sub(1, Ordering::SeqCst) == 1
        {
            return Err(StorageError::Unavailable);
        }
        if self.fail_next.load(Ordering::SeqCst) > 0 {
            self.fail_next.fetch_sub(1, Ordering::SeqCst);
            return Err(StorageError::Unavailable);
        }
        let mut guard = lock(&self.data);
        let mut next = guard.clone();
        for op in batch {
            match op {
                StorageOp::PutContact(c) => {
                    next.contacts.insert(c.uid.clone(), c.clone());
                }
                StorageOp::DeleteContact(u) => {
                    next.contacts.remove(u);
                }
                StorageOp::InsertMessage(m) => {
                    if !next
                        .messages
                        .iter()
                        .any(|x| x.message.message_id == m.message.message_id)
                    {
                        next.messages.push(m.clone());
                    }
                }
                StorageOp::SetDelivery { id, state, read_at } => {
                    let m = next
                        .messages
                        .iter_mut()
                        .find(|x| &x.message.message_id == id)
                        .ok_or(StorageError::Rejected)?;
                    m.message.delivery_state = *state;
                    m.message.read_at = read_at.or(m.message.read_at);
                }
                StorageOp::DeleteMessage(id) => {
                    next.messages.retain(|x| &x.message.message_id != id);
                    next.outbox.retain(|o| &o.message_id != id);
                    next.files.remove(id);
                    next.reactions.retain(|r| &r.message_id != id);
                    next.deleted.retain(|d| d != id);
                }
                StorageOp::PutOutbox(e) => {
                    if !next
                        .messages
                        .iter()
                        .any(|x| x.message.message_id == e.message_id)
                    {
                        return Err(StorageError::Rejected);
                    }
                    next.outbox
                        .retain(|o| !(o.message_id == e.message_id && o.recipient == e.recipient));
                    next.outbox.push(e.clone());
                }
                StorageOp::RemoveOutbox {
                    message_id,
                    recipient,
                } => {
                    next.outbox
                        .retain(|o| !(&o.message_id == message_id && &o.recipient == recipient));
                }
                StorageOp::SetReaction {
                    message_id,
                    uid,
                    emoji,
                } => {
                    if !next
                        .messages
                        .iter()
                        .any(|x| &x.message.message_id == message_id)
                    {
                        return Err(StorageError::Rejected);
                    }
                    next.reactions
                        .retain(|r| !(&r.message_id == message_id && &r.uid == uid));
                    if let Some(e) = emoji {
                        next.reactions.push(StoredReaction {
                            message_id: message_id.clone(),
                            uid: uid.clone(),
                            emoji: e.clone(),
                        });
                    }
                }
                StorageOp::RenameUser { from, to } => {
                    if let Some(mut c) = next.contacts.remove(from) {
                        c.uid = to.clone();
                        next.contacts.entry(to.clone()).or_insert(c);
                    }
                    for c in next.contacts.values_mut() {
                        if c.introduced_by.as_ref() == Some(from) {
                            c.introduced_by = Some(to.clone());
                        }
                    }
                    for m in &mut next.messages {
                        if m.conversation == ConversationId::Direct(from.clone()) {
                            m.conversation = ConversationId::Direct(to.clone());
                        }
                        if &m.message.sender_id == from {
                            m.message.sender_id = to.clone();
                        }
                        if let Some(r) = m
                            .message
                            .reply_to
                            .as_mut()
                            .filter(|r| r.author == from.as_str())
                        {
                            r.author = to.to_string();
                        }
                    }
                    for o in &mut next.outbox {
                        if &o.recipient == from {
                            o.recipient = to.clone();
                        }
                    }
                    for r in &mut next.reactions {
                        if &r.uid == from {
                            r.uid = to.clone();
                        }
                    }
                }
                StorageOp::Tombstone(id) => {
                    let m = next
                        .messages
                        .iter_mut()
                        .find(|x| &x.message.message_id == id)
                        .ok_or(StorageError::Rejected)?;
                    m.message.text.clear();
                    m.message.kind = privcord_domain::message::MessageKind::Text;
                    m.message.reply_to = None;
                    next.files.remove(id);
                    next.reactions.retain(|r| &r.message_id != id);
                    next.outbox.retain(|o| &o.message_id != id);
                    if !next.deleted.contains(id) {
                        next.deleted.push(id.clone());
                    }
                }
                StorageOp::Erase(scope) => match scope {
                    EraseScope::Conversation(c) => {
                        let ids: Vec<MessageId> = next
                            .messages
                            .iter()
                            .filter(|m| &m.conversation == c)
                            .map(|m| m.message.message_id.clone())
                            .collect();
                        next.messages.retain(|m| &m.conversation != c);
                        next.outbox.retain(|o| !ids.contains(&o.message_id));
                        next.files.retain(|k, _| !ids.contains(k));
                        next.reactions.retain(|r| !ids.contains(&r.message_id));
                        next.deleted.retain(|d| !ids.contains(d));
                    }
                    EraseScope::Messages => {
                        next.messages.clear();
                        next.outbox.clear();
                        next.files.clear();
                        next.reactions.clear();
                        next.deleted.clear();
                    }
                    EraseScope::Contacts => next.contacts.clear(),
                    EraseScope::Files => next.files.clear(),
                    EraseScope::Outbox => next.outbox.clear(),
                    EraseScope::All => next = Data::default(),
                },
                StorageOp::PutFile(f) => {
                    if !next
                        .messages
                        .iter()
                        .any(|x| x.message.message_id == f.message_id)
                    {
                        return Err(StorageError::Rejected);
                    }
                    next.files.insert(f.message_id.clone(), f.clone());
                }
                StorageOp::SetKv { key, value } => {
                    next.kv.insert(key.clone(), value.clone());
                }
            }
        }
        *guard = next;
        self.applied.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn contacts(&self) -> Result<Vec<StoredContact>, StorageError> {
        let mut v: Vec<_> = lock(&self.data).contacts.values().cloned().collect();
        v.sort_by(|a, b| a.uid.cmp(&b.uid));
        Ok(v)
    }
    fn messages(&self) -> Result<Vec<StoredMessage>, StorageError> {
        Ok(lock(&self.data).messages.clone())
    }
    fn outbox(&self) -> Result<Vec<OutboxEntry>, StorageError> {
        Ok(lock(&self.data).outbox.clone())
    }
    fn file(&self, id: &MessageId) -> Result<Option<StoredFile>, StorageError> {
        Ok(lock(&self.data).files.get(id).cloned())
    }
    fn reactions(&self) -> Result<Vec<StoredReaction>, StorageError> {
        Ok(lock(&self.data).reactions.clone())
    }
    fn deleted(&self) -> Result<Vec<MessageId>, StorageError> {
        Ok(lock(&self.data).deleted.clone())
    }
    fn kv(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        Ok(lock(&self.data).kv.get(key).cloned())
    }
}

#[derive(Debug, Default)]
pub struct MemorySecureStore(Mutex<Option<[u8; 64]>>);

impl MemorySecureStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

impl SecureStore for MemorySecureStore {
    fn load_identity(&self) -> Result<Option<IdentitySecrets>, SecureStoreError> {
        Ok((*lock(&self.0)).map(zeroize::Zeroizing::new))
    }
    fn save_identity(&self, secrets: &IdentitySecrets) -> Result<(), SecureStoreError> {
        *lock(&self.0) = Some(**secrets);
        Ok(())
    }
    fn delete_identity(&self) -> Result<(), SecureStoreError> {
        *lock(&self.0) = None;
        Ok(())
    }
}

/// Collects what the engine sends, so a test can deliver it (or lose it) by hand.
#[derive(Debug, Default)]
pub struct RecordingTransport {
    sent: Mutex<Vec<(UserId, String)>>,
    connected: Mutex<Vec<UserId>>,
    raw: Mutex<Vec<(String, String)>>,
    closed: Mutex<Vec<UserId>>,
    signals: Mutex<Vec<SignalOp>>,
    signaling_up: std::sync::atomic::AtomicBool,
    signal_fails: std::sync::atomic::AtomicBool,
}

/// What the engine asked of the signaling service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignalOp {
    Subscribe(String),
    Unsubscribe(String),
    Put {
        mailbox: String,
        blob: String,
        kind: PutKind,
        ttl_sec: u32,
    },
}

impl RecordingTransport {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn set_connected(&self, peer: &UserId, up: bool) {
        let mut c = lock(&self.connected);
        c.retain(|p| p != peer);
        if up {
            c.push(peer.clone());
        }
    }
    /// Pretend a signaling service is (not) configured.
    pub fn set_signaling(&self, up: bool) {
        self.signaling_up.store(up, Ordering::SeqCst);
    }
    /// Make publishing fail (the service is unreachable).
    pub fn set_signal_fails(&self, fails: bool) {
        self.signal_fails.store(fails, Ordering::SeqCst);
    }
    pub fn drain_signals(&self) -> Vec<SignalOp> {
        std::mem::take(&mut *lock(&self.signals))
    }
    /// Peers the engine asked to be closed since the last call.
    pub fn drain_closed(&self) -> Vec<UserId> {
        std::mem::take(&mut *lock(&self.closed))
    }
    /// Everything sent over raw (mesh) links since the last call.
    pub fn drain_raw(&self) -> Vec<(String, String)> {
        std::mem::take(&mut *lock(&self.raw))
    }
    /// Everything sent since the last call.
    pub fn drain(&self) -> Vec<(UserId, String)> {
        std::mem::take(&mut *lock(&self.sent))
    }
}

impl Transport for RecordingTransport {
    fn send(&self, peer: &UserId, frame: &str) -> Result<(), TransportError> {
        if !lock(&self.connected).contains(peer) {
            return Err(TransportError::NotConnected);
        }
        lock(&self.sent).push((peer.clone(), frame.to_owned()));
        Ok(())
    }
    fn send_raw(&self, link: &str, frame: &str) -> Result<(), TransportError> {
        lock(&self.raw).push((link.to_owned(), frame.to_owned()));
        Ok(())
    }
    fn close(&self, peer: &UserId) {
        lock(&self.closed).push(peer.clone());
    }
    fn signal_available(&self) -> bool {
        self.signaling_up.load(Ordering::SeqCst)
    }
    fn signal_subscribe(&self, mailbox: &str) -> Result<(), TransportError> {
        if !self.signal_available() {
            return Err(TransportError::NotConnected);
        }
        lock(&self.signals).push(SignalOp::Subscribe(mailbox.to_owned()));
        Ok(())
    }
    fn signal_unsubscribe(&self, mailbox: &str) {
        lock(&self.signals).push(SignalOp::Unsubscribe(mailbox.to_owned()));
    }
    fn signal_put(
        &self,
        mailbox: &str,
        blob: &str,
        kind: PutKind,
        ttl_sec: u32,
    ) -> Result<(), TransportError> {
        if !self.signal_available() || self.signal_fails.load(Ordering::SeqCst) {
            return Err(TransportError::NotConnected);
        }
        lock(&self.signals).push(SignalOp::Put {
            mailbox: mailbox.to_owned(),
            blob: blob.to_owned(),
            kind,
            ttl_sec,
        });
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct RecordingNotifier(Mutex<Vec<Notification>>);

impl RecordingNotifier {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn taken(&self) -> Vec<Notification> {
        std::mem::take(&mut *lock(&self.0))
    }
}

impl Notifier for RecordingNotifier {
    fn notify(&self, n: Notification) {
        lock(&self.0).push(n);
    }
}
