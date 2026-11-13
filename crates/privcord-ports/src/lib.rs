//! Ports: what the engine needs from the outside world, as traits.
//!
//! Every method is synchronous and returns promptly (a database call, a queue push); anything that waits on a radio or
//! the network is the adapter's own business, and its results come back to the engine as inputs (`EngineHandle`).
//! That keeps the engine deterministic and testable, and lets each platform implement a port its own way:
//! Android Keystore, Windows Credential Manager, Linux Secret Service, macOS Keychain for [`SecureStore`];
//! SQLite for [`Storage`]; WebRTC or Bluetooth for [`Transport`].
//!
//! Adapters map their platform errors to the error types here and never let one panic across the boundary.

use privcord_domain::{
    message::{ChatMessage, DeliveryState},
    privacy::ContactTrust,
    signaling::PutKind,
    state::ConnectionPath,
    ConversationId, MessageId, UserId,
};
use thiserror::Error;
use zeroize::Zeroizing;

#[cfg(feature = "testing")]
pub mod testing;

/// Wall-clock time. Monotonic time is not needed by the engine yet.
pub trait Clock: Send + Sync {
    /// Milliseconds since 1970.
    fn now_ms(&self) -> i64;
}

/// Why a storage call failed. Details stay in the adapter's logs; nothing here carries content.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum StorageError {
    #[error("storage is unavailable")]
    Unavailable,
    #[error("stored data failed an integrity check")]
    Corrupt,
    #[error("the database was written by a newer version")]
    NewerVersion,
    #[error("storage rejected the operation")]
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredContact {
    pub uid: UserId,
    /// The `DUOID1:` text of their card, kept so it can be re-shared and re-verified.
    pub card: String,
    pub name: Option<String>,
    pub trust: ContactTrust,
    /// Safety numbers were compared out of band.
    pub checked: bool,
    pub introduced_by: Option<UserId>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredMessage {
    pub conversation: ConversationId,
    pub message: ChatMessage,
}

/// The bytes of a file message, kept apart from the message row so lists stay cheap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredFile {
    pub message_id: MessageId,
    pub name: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// What the chat list needs to know about a stored file without reading its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileInfo {
    pub mime: String,
    pub size: u64,
}

/// A message waiting to reach one recipient.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxEntry {
    pub message_id: MessageId,
    pub recipient: UserId,
    pub attempts: u32,
    pub next_try_ms: i64,
}

/// One person's reaction to one message (one emoji each).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredReaction {
    pub message_id: MessageId,
    pub uid: UserId,
    pub emoji: String,
}

/// What an erase removes (emergency deletion and "delete this chat").
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EraseScope {
    /// One conversation's messages, with their files and outbox entries.
    Conversation(ConversationId),
    /// Every message (and so every file and outbox entry).
    Messages,
    Contacts,
    Files,
    Outbox,
    /// Everything this storage holds, settings included.
    All,
}

/// One change. A batch of these is applied all together or not at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageOp {
    PutContact(StoredContact),
    DeleteContact(UserId),
    /// Stores a message unless one with the same id exists (so receiving twice is harmless).
    InsertMessage(StoredMessage),
    SetDelivery {
        id: MessageId,
        state: DeliveryState,
        read_at: Option<i64>,
    },
    DeleteMessage(MessageId),
    PutOutbox(OutboxEntry),
    RemoveOutbox {
        message_id: MessageId,
        recipient: UserId,
    },
    SetKv {
        key: String,
        value: Vec<u8>,
    },
    /// Keeps a file's bytes with its (already stored, or same-batch) message.
    PutFile(StoredFile),
    /// Set (`Some`) or remove (`None`) someone's reaction. The message must exist.
    SetReaction {
        message_id: MessageId,
        uid: UserId,
        emoji: Option<String>,
    },
    /// Deleted for everyone: keep only a tombstone (no text, file, reply, reactions or unsent copies).
    Tombstone(MessageId),
    Erase(EraseScope),
    /// Someone's id changed (protocol v2 derives it from both public keys): everything stored under `from` moves to
    /// `to`. If a contact already exists under `to`, the old one is dropped.
    RenameUser {
        from: UserId,
        to: UserId,
    },
    /// Every message of one conversation moves to another (an old group's history into the group made again).
    MoveConversation {
        from: ConversationId,
        to: ConversationId,
    },
}

/// Persistent state. `apply` is the only way to change it, and it is atomic: a crash or an error part-way leaves
/// nothing half-written (a message never exists without its outbox entry, or the other way round).
pub trait Storage: Send + Sync {
    fn apply(&self, batch: &[StorageOp]) -> Result<(), StorageError>;
    fn contacts(&self) -> Result<Vec<StoredContact>, StorageError>;
    fn messages(&self) -> Result<Vec<StoredMessage>, StorageError>;
    fn outbox(&self) -> Result<Vec<OutboxEntry>, StorageError>;
    fn kv(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError>;
    fn file(&self, id: &MessageId) -> Result<Option<StoredFile>, StorageError>;
    /// Type and size of a stored file. The default reads the file; a database can answer without reading the bytes.
    fn file_info(&self, id: &MessageId) -> Result<Option<FileInfo>, StorageError> {
        Ok(self.file(id)?.map(|f| FileInfo {
            size: u64::try_from(f.bytes.len()).unwrap_or(u64::MAX),
            mime: f.mime,
        }))
    }
    fn reactions(&self) -> Result<Vec<StoredReaction>, StorageError>;
    /// Messages that were deleted for everyone.
    fn deleted(&self) -> Result<Vec<MessageId>, StorageError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SecureStoreError {
    #[error("secure storage is unavailable")]
    Unavailable,
    #[error("secure storage refused access")]
    Denied,
}

/// The two private scalars of an identity (sign, then agree), as the OS-backed store keeps them. Wiped when dropped.
pub type IdentitySecrets = Zeroizing<[u8; 64]>;

/// OS-backed secret storage (Keystore, Credential Manager, Secret Service, Keychain).
pub trait SecureStore: Send + Sync {
    fn load_identity(&self) -> Result<Option<IdentitySecrets>, SecureStoreError>;
    fn save_identity(&self, secrets: &IdentitySecrets) -> Result<(), SecureStoreError>;
    fn delete_identity(&self) -> Result<(), SecureStoreError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TransportError {
    #[error("not connected to that person")]
    NotConnected,
    #[error("the link refused the frame")]
    Refused,
}

/// Sends text frames to a peer over whatever link is up (WebRTC data channel, Bluetooth, ...). The engine decides
/// which peers to talk to; the adapter owns the radio. Incoming frames and link changes are reported to the engine.
pub trait Transport: Send + Sync {
    /// Queue one frame. Must not block on the network.
    fn send(&self, peer: &UserId, frame: &str) -> Result<(), TransportError>;

    /// Queue one frame on a radio link that is not a known contact (a Bluetooth mesh neighbour). Links are named by
    /// whatever the adapter uses. A transport with no mesh radio keeps this default and the mesh simply has no links.
    fn send_raw(&self, _link: &str, _frame: &str) -> Result<(), TransportError> {
        Err(TransportError::NotConnected)
    }

    /// The engine decided a link is dead (nothing heard for too long): drop it so the adapter can dial again.
    fn close(&self, _peer: &UserId) {}

    /// Is a signaling service (relay or Nostr) configured? Six-word invites need one.
    fn signal_available(&self) -> bool {
        false
    }
    /// Start listening on a mailbox. Blobs that arrive are handed to the engine with `signal_blob`.
    fn signal_subscribe(&self, _mailbox: &str) -> Result<(), TransportError> {
        Err(TransportError::NotConnected)
    }
    fn signal_unsubscribe(&self, _mailbox: &str) {}
    /// Publish an encoded sealed blob. Ok if at least one service took it.
    fn signal_put(
        &self,
        _mailbox: &str,
        _blob: &str,
        _kind: PutKind,
        _ttl_sec: u32,
    ) -> Result<(), TransportError> {
        Err(TransportError::NotConnected)
    }
}

/// Something worth telling the person about while the app may be in the background.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notification {
    MessageReceived {
        conversation: ConversationId,
        sender: UserId,
        preview: String,
    },
}

pub trait Notifier: Send + Sync {
    fn notify(&self, notification: Notification);
}

/// What an adapter reports when a link comes up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkInfo {
    pub path: ConnectionPath,
}
