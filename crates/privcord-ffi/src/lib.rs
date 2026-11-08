//! The facade platform UIs call (Kotlin through UniFFI today; the same surface can back Tauri commands).
//!
//! Rules this crate keeps (PRD sections 6, 12 and 13):
//! * it is a narrow API of plain data: strings, numbers, records and enums, never engine internals, Tokio handles,
//!   mutexes, ratchet state or private keys;
//! * errors are stable, redacted codes ([`FfiError`]), never messages that carry content;
//! * it does not create a runtime per call: the engine owns its thread, calls here only wait for its answer;
//! * adapters (secure storage, transport, notifications) are implemented by the platform and passed in as callbacks.
//!
//! One thing does cross the boundary on purpose: the identity's private scalars go *into* the platform's
//! `SecureStoreCallbacks` (Android Keystore, Windows Credential Manager, ...) to be stored, and come back from it when
//! the identity is loaded. They never go to UI code, and the callback trait is the only place they appear.

use privcord_crypto::rng::OsEntropy;
use privcord_domain::{
    message::DeliveryState,
    privacy::ContactTrust,
    state::{ConnectionFailure, ConnectionPath, ConnectionState},
    ConversationId, MessageId, UserId,
};
use privcord_engine::{
    Answer, ChannelOp, EngineEvent, EngineHandle, ErrorCode, EventStream, FileTarget, GroupOp,
    LinkSecurity, Op, Ports,
};
use privcord_ports::{
    Clock, IdentitySecrets, Notification, Notifier, SecureStore, SecureStoreError, Transport,
    TransportError,
};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

uniffi::setup_scaffolding!();

/// Stable error codes. A new code may be added; existing ones never change meaning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum FfiError {
    #[error("no identity")]
    NoIdentity,
    #[error("identity exists")]
    IdentityExists,
    #[error("invalid recovery phrase")]
    InvalidPhrase,
    #[error("invalid contact card")]
    InvalidCard,
    #[error("own contact card")]
    OwnCard,
    #[error("unknown contact")]
    UnknownContact,
    #[error("empty message")]
    EmptyMessage,
    #[error("message too long")]
    MessageTooLong,
    #[error("direct messages not allowed")]
    DirectNotAllowed,
    #[error("unknown message")]
    UnknownMessage,
    #[error("storage failed")]
    Storage,
    #[error("secure storage failed")]
    SecureStorage,
    #[error("cryptography failed")]
    Crypto,
    #[error("shutting down")]
    ShuttingDown,
    #[error("busy")]
    Busy,
    #[error("invalid argument")]
    InvalidArgument,
    #[error("not in that group")]
    NoSuchGroup,
    #[error("group change not allowed")]
    GroupRefused,
    #[error("group is full")]
    GroupFull,
    #[error("bad file")]
    BadFile,
    #[error("invalid channel name")]
    BadChannel,
    #[error("channel not joined")]
    NotJoined,
    #[error("no signaling service")]
    NoSignaling,
    #[error("invalid invite")]
    InvalidInvite,
    #[error("invite not found")]
    InviteNotFound,
    #[error("own invite")]
    OwnInvite,
    #[error("still in a shared group")]
    StillInGroup,
}

impl From<ErrorCode> for FfiError {
    fn from(e: ErrorCode) -> Self {
        match e {
            ErrorCode::NoIdentity => Self::NoIdentity,
            ErrorCode::IdentityExists => Self::IdentityExists,
            ErrorCode::InvalidPhrase => Self::InvalidPhrase,
            ErrorCode::InvalidCard => Self::InvalidCard,
            ErrorCode::OwnCard => Self::OwnCard,
            ErrorCode::UnknownContact => Self::UnknownContact,
            ErrorCode::EmptyMessage => Self::EmptyMessage,
            ErrorCode::MessageTooLong => Self::MessageTooLong,
            ErrorCode::DirectNotAllowed => Self::DirectNotAllowed,
            ErrorCode::UnknownMessage => Self::UnknownMessage,
            ErrorCode::Storage => Self::Storage,
            ErrorCode::SecureStorage => Self::SecureStorage,
            ErrorCode::Crypto => Self::Crypto,
            ErrorCode::ShuttingDown => Self::ShuttingDown,
            ErrorCode::Busy => Self::Busy,
            ErrorCode::NoSuchGroup => Self::NoSuchGroup,
            ErrorCode::GroupRefused => Self::GroupRefused,
            ErrorCode::GroupFull => Self::GroupFull,
            ErrorCode::BadFile => Self::BadFile,
            ErrorCode::BadChannel => Self::BadChannel,
            ErrorCode::NotJoined => Self::NotJoined,
            ErrorCode::NoSignaling => Self::NoSignaling,
            ErrorCode::InvalidInvite => Self::InvalidInvite,
            ErrorCode::InviteNotFound => Self::InviteNotFound,
            ErrorCode::OwnInvite => Self::OwnInvite,
            ErrorCode::StillInGroup => Self::StillInGroup,
        }
    }
}

/* ------------------------------------------------------------------ callbacks the platform implements */

/// OS-backed secret storage. `load` returns 64 bytes (the two private scalars) or nothing.
#[uniffi::export(with_foreign)]
pub trait SecureStoreCallbacks: Send + Sync {
    fn load_identity(&self) -> Option<Vec<u8>>;
    fn save_identity(&self, secrets: Vec<u8>) -> bool;
    fn delete_identity(&self);
}

/// Sends a text frame to a peer over whatever link is up. Returns false if it cannot.
#[uniffi::export(with_foreign)]
pub trait TransportCallbacks: Send + Sync {
    fn send(&self, peer: String, frame: String) -> bool;
    /// Send a frame to a Bluetooth mesh neighbour (not a contact). Returns false if the link is gone.
    fn send_raw(&self, link: String, frame: String) -> bool;
    /// The engine decided this link is dead (nothing heard for 14 s): close it so it can be dialed again.
    fn close(&self, peer: String);
    /// Is a signaling service (relay or Nostr) configured?
    fn signal_available(&self) -> bool;
    /// Listen on a mailbox. Blobs that arrive go back through `signal_blob`.
    fn signal_subscribe(&self, mailbox: String) -> bool;
    fn signal_unsubscribe(&self, mailbox: String);
    /// Publish an encoded sealed blob. True if at least one service took it.
    fn signal_put(&self, mailbox: String, blob: String, kind: SignalKind, ttl_sec: u32) -> bool;
}

/// How long a published blob should live.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SignalKind {
    /// Short-lived live signaling.
    Live,
    /// Held for someone who is offline.
    Stored,
}

#[uniffi::export(with_foreign)]
pub trait NotifierCallbacks: Send + Sync {
    fn message_received(&self, conversation: String, sender: String, preview: String);
}

struct SecureAdapter(Arc<dyn SecureStoreCallbacks>);
impl SecureStore for SecureAdapter {
    fn load_identity(&self) -> Result<Option<IdentitySecrets>, SecureStoreError> {
        match self.0.load_identity() {
            None => Ok(None),
            Some(bytes) => {
                let mut out = Zeroizing::new([0u8; 64]);
                if bytes.len() != 64 {
                    return Err(SecureStoreError::Unavailable);
                }
                for (d, s) in out.iter_mut().zip(bytes.iter()) {
                    *d = *s;
                }
                Ok(Some(out))
            }
        }
    }
    fn save_identity(&self, secrets: &IdentitySecrets) -> Result<(), SecureStoreError> {
        if self.0.save_identity(secrets.to_vec()) {
            Ok(())
        } else {
            Err(SecureStoreError::Denied)
        }
    }
    fn delete_identity(&self) -> Result<(), SecureStoreError> {
        self.0.delete_identity();
        Ok(())
    }
}

struct TransportAdapter(Arc<dyn TransportCallbacks>);
impl Transport for TransportAdapter {
    fn send(&self, peer: &UserId, frame: &str) -> Result<(), TransportError> {
        if self.0.send(peer.to_string(), frame.to_owned()) {
            Ok(())
        } else {
            Err(TransportError::NotConnected)
        }
    }
    fn send_raw(&self, link: &str, frame: &str) -> Result<(), TransportError> {
        if self.0.send_raw(link.to_owned(), frame.to_owned()) {
            Ok(())
        } else {
            Err(TransportError::NotConnected)
        }
    }
    fn close(&self, peer: &UserId) {
        self.0.close(peer.to_string());
    }
    fn signal_available(&self) -> bool {
        self.0.signal_available()
    }
    fn signal_subscribe(&self, mailbox: &str) -> Result<(), TransportError> {
        if self.0.signal_subscribe(mailbox.to_owned()) {
            Ok(())
        } else {
            Err(TransportError::NotConnected)
        }
    }
    fn signal_unsubscribe(&self, mailbox: &str) {
        self.0.signal_unsubscribe(mailbox.to_owned());
    }
    fn signal_put(
        &self,
        mailbox: &str,
        blob: &str,
        kind: privcord_domain::signaling::PutKind,
        ttl_sec: u32,
    ) -> Result<(), TransportError> {
        let kind = match kind {
            privcord_domain::signaling::PutKind::Sig => SignalKind::Live,
            privcord_domain::signaling::PutKind::Msg => SignalKind::Stored,
        };
        if self
            .0
            .signal_put(mailbox.to_owned(), blob.to_owned(), kind, ttl_sec)
        {
            Ok(())
        } else {
            Err(TransportError::NotConnected)
        }
    }
}

struct NotifierAdapter(Arc<dyn NotifierCallbacks>);
impl Notifier for NotifierAdapter {
    fn notify(&self, n: Notification) {
        let Notification::MessageReceived {
            conversation,
            sender,
            preview,
        } = n;
        self.0
            .message_received(conversation.storage_key(), sender.to_string(), preview);
    }
}

struct SystemClock;
impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|d| i64::try_from(d.as_millis()).ok())
            .unwrap_or(0)
    }
}

/* ------------------------------------------------------------------ data the UI sees */

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum PathKind {
    DirectLan,
    DirectNat,
    Relayed,
    Bluetooth,
    Unknown,
}

impl From<PathKind> for ConnectionPath {
    fn from(p: PathKind) -> Self {
        match p {
            PathKind::DirectLan => Self::DirectLan,
            PathKind::DirectNat => Self::DirectNat,
            PathKind::Relayed => Self::Relayed,
            PathKind::Bluetooth => Self::Bluetooth,
            PathKind::Unknown => Self::Unknown,
        }
    }
}
impl From<ConnectionPath> for PathKind {
    fn from(p: ConnectionPath) -> Self {
        match p {
            ConnectionPath::DirectLan => Self::DirectLan,
            ConnectionPath::DirectNat => Self::DirectNat,
            ConnectionPath::Relayed => Self::Relayed,
            ConnectionPath::Bluetooth => Self::Bluetooth,
            ConnectionPath::Unknown => Self::Unknown,
        }
    }
}

/// How a link is protected. `Encrypted` is a WebRTC data channel (already encrypted by DTLS): the engine uses the
/// handshake the existing apps speak and plain frames. `Open` is a link that is not encrypted (Bluetooth): the engine
/// encrypts every frame itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LinkKind {
    Encrypted,
    Open,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum LinkState {
    Offline,
    Connecting,
    Connected { path: PathKind },
    Reconnecting { attempt: u32 },
    Failed { authentication: bool },
}

impl From<ConnectionState> for LinkState {
    fn from(s: ConnectionState) -> Self {
        match s {
            ConnectionState::Offline => Self::Offline,
            ConnectionState::Connecting => Self::Connecting,
            ConnectionState::Connected { path } => Self::Connected { path: path.into() },
            ConnectionState::Reconnecting { attempt } => Self::Reconnecting { attempt },
            ConnectionState::Failed { reason } => Self::Failed {
                authentication: reason == ConnectionFailure::AuthenticationFailed,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Delivery {
    Queued,
    Sent,
    Delivered,
    Read,
    Failed,
}

impl From<DeliveryState> for Delivery {
    fn from(s: DeliveryState) -> Self {
        match s {
            DeliveryState::Queued => Self::Queued,
            DeliveryState::Sent => Self::Sent,
            DeliveryState::Delivered => Self::Delivered,
            DeliveryState::Read => Self::Read,
            DeliveryState::Failed => Self::Failed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ContactDto {
    pub uid: String,
    pub name: Option<String>,
    pub verified: bool,
    pub checked: bool,
    pub safety_number: String,
    pub link: LinkState,
    pub can_message: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MessageDto {
    pub id: String,
    pub sender: String,
    pub text: String,
    pub created_at: i64,
    pub delivery: Delivery,
    pub reply_to: Option<String>,
    /// A file message: `text` is the file's name and `load_file` returns its bytes.
    pub is_file: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FileDto {
    pub name: String,
    pub mime: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ConversationDto {
    pub id: String,
    pub messages: Vec<MessageDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SnapshotDto {
    pub seq: u64,
    pub own_uid: Option<String>,
    pub contacts: Vec<ContactDto>,
    pub conversations: Vec<ConversationDto>,
    pub groups: Vec<GroupDto>,
    pub channels: Vec<String>,
    pub invite: Option<InviteDto>,
    pub requests: Vec<RequestDto>,
    pub answer: Option<AnswerDto>,
    pub lookup_pending: bool,
    pub queued: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InviteDto {
    pub words: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RequestDto {
    pub uid: String,
    pub name: String,
    pub safety_number: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum AnswerState {
    Sent,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AnswerDto {
    pub uid: String,
    pub status: AnswerState,
}

/// What a person sees before saving a friend.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PreviewDto {
    pub uid: String,
    pub name: String,
    pub safety_number: String,
    pub already: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum WipeStatus {
    Erased,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct WipeStepDto {
    pub step_id: String,
    pub status: WipeStatus,
    pub details: Option<String>,
}

/// The truthful result of an emergency deletion. Show exactly this, never a false "complete".
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct WipeReportDto {
    pub application: bool,
    pub steps: Vec<WipeStepDto>,
    pub complete: bool,
    pub partial: bool,
    pub failed_step_ids: Vec<String>,
    pub skipped_step_ids: Vec<String>,
    pub finished: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct GroupMemberDto {
    pub uid: String,
    pub admin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct GroupDto {
    pub id: String,
    pub name: String,
    pub created_by: String,
    pub members: Vec<GroupMemberDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum EventDto {
    Ready,
    IdentityCreated,
    ContactAdded {
        uid: String,
    },
    MessageAdded {
        conversation: String,
        message_id: String,
        own: bool,
    },
    MessageStatusChanged {
        message_id: String,
        delivery: Delivery,
    },
    MessageRefused {
        message_id: String,
    },
    PeerStateChanged {
        peer: String,
        link: LinkState,
    },
    /// This reader fell behind; ask for a snapshot.
    GroupChanged {
        group_id: String,
    },
    InviteChanged,
    InviteRequest {
        uid: String,
    },
    InviteFound {
        uid: String,
        name: String,
        safety_number: String,
        already: bool,
    },
    InviteLookupFailed,
    AnswerChanged,
    ContactRemoved {
        uid: String,
    },
    /// Time to dial this person (their link is down and the backoff has passed).
    DialRequested {
        peer: String,
        initiator: bool,
    },
    /// An emergency deletion ran; ask for its report.
    Wiped,
    Lagged {
        missed: u64,
    },
    ShutDown,
}

fn event_dto(e: EngineEvent) -> EventDto {
    match e {
        EngineEvent::Ready => EventDto::Ready,
        EngineEvent::IdentityCreated => EventDto::IdentityCreated,
        EngineEvent::ContactAdded { uid } => EventDto::ContactAdded {
            uid: uid.to_string(),
        },
        EngineEvent::MessageAdded {
            conversation,
            message_id,
            own,
        } => EventDto::MessageAdded {
            conversation: conversation.storage_key(),
            message_id: message_id.to_string(),
            own,
        },
        EngineEvent::MessageStatusChanged { message_id, status } => {
            EventDto::MessageStatusChanged {
                message_id: message_id.to_string(),
                delivery: status.into(),
            }
        }
        EngineEvent::MessageRefused { message_id } => EventDto::MessageRefused {
            message_id: message_id.to_string(),
        },
        EngineEvent::PeerStateChanged { peer, state } => EventDto::PeerStateChanged {
            peer: peer.to_string(),
            link: state.into(),
        },
        EngineEvent::GroupChanged { group_id } => EventDto::GroupChanged { group_id },
        EngineEvent::InviteChanged => EventDto::InviteChanged,
        EngineEvent::InviteRequest { uid } => EventDto::InviteRequest {
            uid: uid.to_string(),
        },
        EngineEvent::InviteFound {
            uid,
            name,
            safety_number,
            already,
        } => EventDto::InviteFound {
            uid: uid.to_string(),
            name,
            safety_number,
            already,
        },
        EngineEvent::InviteLookupFailed => EventDto::InviteLookupFailed,
        EngineEvent::AnswerChanged => EventDto::AnswerChanged,
        EngineEvent::ContactRemoved { uid } => EventDto::ContactRemoved {
            uid: uid.to_string(),
        },
        EngineEvent::DialRequested { peer, initiator } => EventDto::DialRequested {
            peer: peer.to_string(),
            initiator,
        },
        EngineEvent::Wiped => EventDto::Wiped,
        EngineEvent::Lagged { missed } => EventDto::Lagged { missed },
        EngineEvent::ShutDown => EventDto::ShutDown,
    }
}

fn user(s: &str) -> Result<UserId, FfiError> {
    UserId::new(s).map_err(|_| FfiError::InvalidArgument)
}

/* ------------------------------------------------------------------ the engine object */

/// A running PrivCord engine.
#[derive(uniffi::Object)]
pub struct PrivcordEngine {
    handle: EngineHandle,
    events: Mutex<EventStream>,
}

impl std::fmt::Debug for PrivcordEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PrivcordEngine(..)")
    }
}

#[uniffi::export]
impl PrivcordEngine {
    /// Start an engine on the database at `db_path` (the platform picks the folder; the schema is the same everywhere).
    /// `context` is the app's conversation id ("duo" unless the build sets another); it must match the other app's.
    #[uniffi::constructor]
    pub fn start(
        db_path: String,
        context: String,
        secure: Arc<dyn SecureStoreCallbacks>,
        transport: Arc<dyn TransportCallbacks>,
        notifier: Arc<dyn NotifierCallbacks>,
    ) -> Result<Arc<Self>, FfiError> {
        let storage = privcord_storage::SqliteStorage::open(std::path::Path::new(&db_path))
            .map_err(|_| FfiError::Storage)?;
        let ports = Ports {
            storage: Arc::new(storage),
            secure: Arc::new(SecureAdapter(secure)),
            transport: Arc::new(TransportAdapter(transport)),
            clock: Arc::new(SystemClock),
            notifier: Arc::new(NotifierAdapter(notifier)),
            entropy: Box::new(OsEntropy),
        };
        let (handle, events) = EngineHandle::start_with_context(ports, &context)?;
        Ok(Arc::new(Self {
            handle,
            events: Mutex::new(events),
        }))
    }

    /// Make a new identity. Returns the 12 recovery words, once. Show them, make the person save them, then drop them.
    pub fn create_identity(&self) -> Result<String, FfiError> {
        Ok(pollster::block_on(self.handle.create_identity())?.to_string())
    }

    pub fn recover_identity(&self, phrase: String, passphrase: String) -> Result<(), FfiError> {
        Ok(pollster::block_on(
            self.handle.recover_identity(&phrase, &passphrase),
        )?)
    }

    pub fn own_card(&self, name: Option<String>) -> Result<String, FfiError> {
        Ok(pollster::block_on(self.handle.own_card(name.as_deref()))?)
    }

    /// Add a contact from their card. `verified` is true when the cards were swapped directly.
    pub fn add_contact(&self, card: String, verified: bool) -> Result<String, FfiError> {
        let trust = if verified {
            ContactTrust::Verified
        } else {
            ContactTrust::Introduced
        };
        Ok(pollster::block_on(self.handle.add_contact(&card, trust))?.to_string())
    }

    pub fn set_group_only(&self, value: bool) -> Result<(), FfiError> {
        Ok(pollster::block_on(self.handle.set_group_only(value))?)
    }

    pub fn send_message(
        &self,
        peer: String,
        text: String,
        reply_to: Option<String>,
    ) -> Result<String, FfiError> {
        let reply = reply_to
            .map(|r| MessageId::new(r).map_err(|_| FfiError::InvalidArgument))
            .transpose()?;
        Ok(pollster::block_on(
            self.handle
                .send_message(&user(&peer)?, &text, reply.as_ref()),
        )?
        .to_string())
    }

    /// Make a group with these contacts. Returns the group's id.
    pub fn create_group(&self, name: String, members: Vec<String>) -> Result<String, FfiError> {
        let members = members
            .iter()
            .map(|m| user(m))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(pollster::block_on(
            self.handle.group(GroupOp::Create { name, members }),
        )?)
    }

    pub fn add_group_member(&self, group: String, uid: String) -> Result<(), FfiError> {
        let uid = user(&uid)?;
        pollster::block_on(self.handle.group(GroupOp::Add { group, uid }))?;
        Ok(())
    }

    pub fn remove_group_member(&self, group: String, uid: String) -> Result<(), FfiError> {
        let uid = user(&uid)?;
        pollster::block_on(self.handle.group(GroupOp::Remove { group, uid }))?;
        Ok(())
    }

    pub fn leave_group(&self, group: String) -> Result<(), FfiError> {
        pollster::block_on(self.handle.group(GroupOp::Leave { group }))?;
        Ok(())
    }

    pub fn rename_group(&self, group: String, name: String) -> Result<(), FfiError> {
        pollster::block_on(self.handle.group(GroupOp::Rename { group, name }))?;
        Ok(())
    }

    pub fn send_group_message(
        &self,
        group: String,
        text: String,
        reply_to: Option<String>,
    ) -> Result<String, FfiError> {
        let reply_to = reply_to
            .map(|r| MessageId::new(r).map_err(|_| FfiError::InvalidArgument))
            .transpose()?;
        Ok(pollster::block_on(self.handle.group(GroupOp::Message {
            group,
            text,
            reply_to,
        }))?)
    }

    /// Send a file (at most 8 MB) to a person.
    pub fn send_file(
        &self,
        peer: String,
        name: String,
        mime: String,
        data: Vec<u8>,
        reply_to: Option<String>,
    ) -> Result<String, FfiError> {
        self.send_file_to(
            FileTarget::Person(user(&peer)?),
            &name,
            &mime,
            data,
            reply_to,
        )
    }

    /// Send a file to every other member of a group.
    pub fn send_group_file(
        &self,
        group: String,
        name: String,
        mime: String,
        data: Vec<u8>,
        reply_to: Option<String>,
    ) -> Result<String, FfiError> {
        self.send_file_to(FileTarget::Group(group), &name, &mime, data, reply_to)
    }

    /// The bytes of a file message, if we have them.
    pub fn load_file(&self, message_id: String) -> Result<Option<FileDto>, FfiError> {
        let id = MessageId::new(message_id).map_err(|_| FfiError::InvalidArgument)?;
        Ok(
            pollster::block_on(self.handle.load_file(&id))?.map(|f| FileDto {
                name: f.name,
                mime: f.mime,
                data: f.bytes,
            }),
        )
    }

    /// Join a public channel; returns its normalised name.
    pub fn join_channel(&self, name: String) -> Result<String, FfiError> {
        Ok(pollster::block_on(
            self.handle.channel(ChannelOp::Join(name)),
        )?)
    }

    pub fn leave_channel(&self, name: String) -> Result<(), FfiError> {
        pollster::block_on(self.handle.channel(ChannelOp::Leave(name)))?;
        Ok(())
    }

    /// Write to a joined channel (flooded over the Bluetooth mesh). Returns the message id.
    pub fn send_channel_message(&self, name: String, text: String) -> Result<String, FfiError> {
        Ok(pollster::block_on(
            self.handle.channel(ChannelOp::Send { name, text }),
        )?)
    }

    /// A Bluetooth mesh neighbour appeared.
    pub fn mesh_link_up(&self, link: String) -> Result<(), FfiError> {
        Ok(self.handle.mesh_link(link, true)?)
    }

    pub fn mesh_link_down(&self, link: String) -> Result<(), FfiError> {
        Ok(self.handle.mesh_link(link, false)?)
    }

    /// A mesh packet arrived from a neighbour.
    pub fn mesh_frame(&self, link: String, frame: String) -> Result<(), FfiError> {
        Ok(self.handle.mesh_frame(link, frame)?)
    }

    /// Make a six-word invite and publish it. Returns the words and when they stop working (ms since 1970).
    pub fn create_invite(&self) -> Result<InviteDto, FfiError> {
        match pollster::block_on(self.handle.op(Op::CreateInvite))? {
            Answer::Invite { words, expires_at } => Ok(InviteDto { words, expires_at }),
            _ => Err(FfiError::InvalidArgument),
        }
    }

    pub fn stop_invite(&self) -> Result<(), FfiError> {
        self.misc(Op::StopInvite)
    }

    /// Look at an invite (six words or a full card) without saving it. A card answers at once; words start a search
    /// that ends with an `InviteFound` or `InviteLookupFailed` event.
    pub fn preview_invite(&self, text: String) -> Result<Option<PreviewDto>, FfiError> {
        match pollster::block_on(self.handle.op(Op::PreviewInvite(text)))? {
            Answer::Preview(p) => Ok(p.map(|p| PreviewDto {
                uid: p.uid.to_string(),
                name: p.name,
                safety_number: p.safety_number,
                already: p.already,
            })),
            _ => Err(FfiError::InvalidArgument),
        }
    }

    /// Save a friend from their invite. Returns their id.
    pub fn accept_invite(&self, text: String) -> Result<String, FfiError> {
        self.person(Op::AcceptInvite(text))
    }

    pub fn retry_answer(&self) -> Result<(), FfiError> {
        self.misc(Op::RetryAnswer)
    }

    pub fn clear_answer(&self) -> Result<(), FfiError> {
        self.misc(Op::ClearAnswer)
    }

    pub fn accept_request(&self, uid: String) -> Result<String, FfiError> {
        self.person(Op::AcceptRequest(user(&uid)?))
    }

    pub fn dismiss_request(&self, uid: String) -> Result<(), FfiError> {
        self.misc(Op::DismissRequest(user(&uid)?))
    }

    /// Forget a friend and their chat. Refused while they share a group with you.
    pub fn remove_contact(&self, uid: String) -> Result<(), FfiError> {
        self.misc(Op::RemoveContact(user(&uid)?))
    }

    /// Keep invites on the relay for 15 minutes as well as publishing them live.
    pub fn set_store_forward(&self, value: bool) -> Result<(), FfiError> {
        self.misc(Op::SetStoreForward(value))
    }

    /// The name put on invite cards.
    pub fn set_display_name(&self, name: String) -> Result<(), FfiError> {
        self.misc(Op::SetDisplayName(name))
    }

    /// The signaling service delivered a blob on a mailbox we listen on.
    pub fn signal_blob(&self, mailbox: String, blob: String) -> Result<(), FfiError> {
        Ok(self.handle.signal_blob(mailbox, blob)?)
    }

    /// Delete one chat here. `conversation` is a person's id, a group id or `chan:` plus a channel name.
    pub fn wipe_conversation(
        &self,
        conversation: String,
        erase_session: bool,
    ) -> Result<WipeReportDto, FfiError> {
        let conversation = self.conversation_id(&conversation)?;
        self.report(Op::KillSwitchConversation {
            conversation,
            erase_session,
        })?
        .ok_or(FfiError::InvalidArgument)
    }

    /// Emergency deletion of everything the engine holds. Returns the report; a crash part-way is continued on the
    /// next call.
    pub fn wipe_everything(&self) -> Result<WipeReportDto, FfiError> {
        self.report(Op::KillSwitchApp)?
            .ok_or(FfiError::InvalidArgument)
    }

    /// The report of the last deletion that was started, if any.
    pub fn last_wipe_report(&self) -> Result<Option<WipeReportDto>, FfiError> {
        self.report(Op::LastKillSwitchReport)
    }

    pub fn mark_read(&self, peer: String) -> Result<(), FfiError> {
        Ok(pollster::block_on(self.handle.mark_read(&user(&peer)?))?)
    }

    /// The platform's link to `peer` is up, protected the way `kind` says.
    pub fn link_up(&self, peer: String, path: PathKind, kind: LinkKind) -> Result<(), FfiError> {
        let security = match kind {
            LinkKind::Encrypted => LinkSecurity::TransportEncrypted,
            LinkKind::Open => LinkSecurity::EngineEncrypted,
        };
        Ok(pollster::block_on(self.handle.link_up_with(
            &user(&peer)?,
            path.into(),
            security,
        ))?)
    }

    pub fn link_down(&self, peer: String) -> Result<(), FfiError> {
        Ok(self.handle.link_down(&user(&peer)?)?)
    }

    /// A frame arrived from `peer`.
    pub fn frame_received(&self, peer: String, frame: String) -> Result<(), FfiError> {
        Ok(self.handle.frame_received(&user(&peer)?, frame)?)
    }

    /// Everything a recreated UI needs, so it never depends on having seen every event.
    pub fn snapshot(&self) -> Result<SnapshotDto, FfiError> {
        let s = pollster::block_on(self.handle.snapshot())?;
        Ok(SnapshotDto {
            seq: s.seq,
            own_uid: s.own_uid.map(|u| u.to_string()),
            contacts: s
                .contacts
                .into_iter()
                .map(|c| ContactDto {
                    uid: c.uid.to_string(),
                    name: c.name,
                    verified: c.trust == ContactTrust::Verified,
                    checked: c.checked,
                    safety_number: c.safety_number,
                    link: c.connection.into(),
                    can_message: c.can_message,
                })
                .collect(),
            channels: s.channels,
            invite: s.invite.map(|i| InviteDto {
                words: i.words,
                expires_at: i.expires_at,
            }),
            requests: s
                .requests
                .into_iter()
                .map(|r| RequestDto {
                    uid: r.uid.to_string(),
                    name: r.name,
                    safety_number: r.safety_number,
                })
                .collect(),
            answer: s.answer.map(|a| AnswerDto {
                uid: a.uid.to_string(),
                status: match a.status {
                    privcord_engine::AnswerStatus::Sent => AnswerState::Sent,
                    privcord_engine::AnswerStatus::Failed => AnswerState::Failed,
                },
            }),
            lookup_pending: s.lookup_pending,
            groups: s
                .groups
                .into_iter()
                .map(|g| GroupDto {
                    id: g.group_id,
                    name: g.name,
                    created_by: g.created_by,
                    members: g
                        .members
                        .into_iter()
                        .map(|(uid, admin)| GroupMemberDto { uid, admin })
                        .collect(),
                })
                .collect(),
            conversations: s
                .messages
                .into_iter()
                .map(|(conv, msgs): (ConversationId, _)| ConversationDto {
                    id: conv.storage_key(),
                    messages: msgs
                        .into_iter()
                        .map(|m| MessageDto {
                            id: m.message_id.to_string(),
                            sender: m.sender_id.to_string(),
                            text: m.text,
                            created_at: m.client_created_at,
                            delivery: m.delivery_state.into(),
                            reply_to: m.reply_to.map(|r| r.id),
                            is_file: m.kind == privcord_domain::message::MessageKind::File,
                        })
                        .collect(),
                })
                .collect(),
            queued: u64::try_from(s.queued).unwrap_or(u64::MAX),
        })
    }

    /// Wait up to `timeout_ms` for the next event. `None` means nothing happened. Call it from a background thread
    /// and turn it into a Flow; each call takes the next event in order.
    pub fn next_event(&self, timeout_ms: u32) -> Option<EventDto> {
        let mut events = self
            .events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        events
            .recv_timeout(Duration::from_millis(u64::from(timeout_ms)))
            .ok()
            .map(|(_, e)| event_dto(e))
    }

    /// Stop the engine and wait for it to finish. Safe to call more than once.
    pub fn shutdown(&self) -> Result<(), FfiError> {
        Ok(pollster::block_on(self.handle.shutdown())?)
    }
}

impl PrivcordEngine {
    fn send_file_to(
        &self,
        to: FileTarget,
        name: &str,
        mime: &str,
        data: Vec<u8>,
        reply_to: Option<String>,
    ) -> Result<String, FfiError> {
        let reply = reply_to
            .map(|r| MessageId::new(r).map_err(|_| FfiError::InvalidArgument))
            .transpose()?;
        Ok(
            pollster::block_on(self.handle.send_file(to, name, mime, data, reply.as_ref()))?
                .to_string(),
        )
    }
}

impl PrivcordEngine {
    fn misc(&self, op: Op) -> Result<(), FfiError> {
        pollster::block_on(self.handle.op(op))?;
        Ok(())
    }

    fn person(&self, op: Op) -> Result<String, FfiError> {
        match pollster::block_on(self.handle.op(op))? {
            Answer::Person(u) => Ok(u.to_string()),
            _ => Err(FfiError::InvalidArgument),
        }
    }

    fn report(&self, op: Op) -> Result<Option<WipeReportDto>, FfiError> {
        match pollster::block_on(self.handle.op(op))? {
            Answer::Report(r) => Ok(r.map(wipe_dto)),
            _ => Err(FfiError::InvalidArgument),
        }
    }

    /// A person (known contact), a group, or a channel, from the string the apps use.
    fn conversation_id(&self, key: &str) -> Result<ConversationId, FfiError> {
        if let Some(name) = key.strip_prefix("chan:") {
            return Ok(ConversationId::Channel(name.to_owned()));
        }
        let snap = pollster::block_on(self.handle.snapshot())?;
        if snap.groups.iter().any(|g| g.group_id == key) {
            return Ok(ConversationId::Group(
                privcord_domain::GroupId::new(key).map_err(|_| FfiError::InvalidArgument)?,
            ));
        }
        Ok(ConversationId::Direct(user(key)?))
    }
}

fn wipe_dto(r: privcord_domain::killswitch::KillSwitchReport) -> WipeReportDto {
    use privcord_domain::killswitch::{KillSwitchScope, StepStatus};
    let summary = r.summarize();
    WipeReportDto {
        application: r.scope == KillSwitchScope::Application,
        finished: r.finished_at.is_some(),
        steps: r
            .steps
            .into_iter()
            .map(|s| WipeStepDto {
                step_id: s.step_id,
                status: match s.status {
                    StepStatus::Erased => WipeStatus::Erased,
                    StepStatus::Skipped => WipeStatus::Skipped,
                    StepStatus::Failed => WipeStatus::Failed,
                },
                details: s.details,
            })
            .collect(),
        complete: summary.complete,
        partial: summary.partial,
        failed_step_ids: summary.failed_step_ids,
        skipped_step_ids: summary.skipped_step_ids,
    }
}
