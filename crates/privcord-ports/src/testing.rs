//! In-memory implementations of the ports, for tests and throwaway engines.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use crate::{
    Clock, IdentitySecrets, Notification, Notifier, OutboxEntry, SecureStore, SecureStoreError, Storage, StorageError, StorageOp,
    StoredContact, StoredMessage, Transport, TransportError,
};
use privcord_domain::UserId;
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
}

/// Atomic in-memory storage: a batch is applied to a copy and swapped in only if every op succeeds.
#[derive(Debug, Default)]
pub struct MemoryStorage {
    data: Mutex<Data>,
    fail_next: AtomicUsize,
    applied: AtomicUsize,
}

impl MemoryStorage {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The next `n` calls to `apply` fail (as a crash or a full disk would), leaving nothing written.
    pub fn fail_next_applies(&self, n: usize) {
        self.fail_next.store(n, Ordering::SeqCst);
    }

    pub fn applied_batches(&self) -> usize {
        self.applied.load(Ordering::SeqCst)
    }
}

impl Storage for MemoryStorage {
    fn apply(&self, batch: &[StorageOp]) -> Result<(), StorageError> {
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
                    if !next.messages.iter().any(|x| x.message.message_id == m.message.message_id) {
                        next.messages.push(m.clone());
                    }
                }
                StorageOp::SetDelivery { id, state, read_at } => {
                    let m = next.messages.iter_mut().find(|x| &x.message.message_id == id).ok_or(StorageError::Rejected)?;
                    m.message.delivery_state = *state;
                    m.message.read_at = read_at.or(m.message.read_at);
                }
                StorageOp::DeleteMessage(id) => {
                    next.messages.retain(|x| &x.message.message_id != id);
                    next.outbox.retain(|o| &o.message_id != id);
                }
                StorageOp::PutOutbox(e) => {
                    if !next.messages.iter().any(|x| x.message.message_id == e.message_id) {
                        return Err(StorageError::Rejected);
                    }
                    next.outbox.retain(|o| !(o.message_id == e.message_id && o.recipient == e.recipient));
                    next.outbox.push(e.clone());
                }
                StorageOp::RemoveOutbox { message_id, recipient } => {
                    next.outbox.retain(|o| !(&o.message_id == message_id && &o.recipient == recipient));
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
