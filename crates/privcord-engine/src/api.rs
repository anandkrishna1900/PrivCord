//! What a UI sees: typed commands in, typed events and snapshots out. UIs hold no business state of their own.

use privcord_domain::{
    message::{ChatMessage, DeliveryState},
    privacy::ContactTrust,
    state::ConnectionState,
    ConversationId, MessageId, UserId,
};

/// A contact as shown to the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContactView {
    pub uid: UserId,
    pub name: Option<String>,
    pub trust: ContactTrust,
    pub checked: bool,
    pub safety_number: String,
    pub connection: ConnectionState,
    /// Whether a direct chat is allowed with this person right now (the group-only rules).
    pub can_message: bool,
}

/// Everything a recreated UI needs, so it never depends on having seen every historical event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// Number of the last event this snapshot includes. Events after it have a higher number.
    pub seq: u64,
    pub own_uid: Option<UserId>,
    pub contacts: Vec<ContactView>,
    pub messages: Vec<(ConversationId, Vec<ChatMessage>)>,
    pub queued: usize,
}

/// Something that happened. Each has a number; numbers rise by one, so a gap means events were missed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineEvent {
    Ready,
    IdentityCreated,
    ContactAdded { uid: UserId },
    MessageAdded { conversation: ConversationId, message_id: MessageId, own: bool },
    MessageStatusChanged { message_id: MessageId, status: DeliveryState },
    MessageRefused { message_id: MessageId },
    PeerStateChanged { peer: UserId, state: ConnectionState },
    /// This subscriber fell behind and `missed` events were dropped. Ask for a snapshot.
    Lagged { missed: u64 },
    ShutDown,
}
