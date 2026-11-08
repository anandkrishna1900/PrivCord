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
    /// What to show: their name, or "Friend" and the start of their id.
    pub display_name: String,
    /// Who introduced them (an introduced contact), if known.
    pub introduced_by: Option<UserId>,
    pub trust: ContactTrust,
    pub checked: bool,
    pub safety_number: String,
    pub connection: ConnectionState,
    /// Whether a direct chat is allowed with this person right now (the group-only rules).
    pub can_message: bool,
}

/// A group you are in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupView {
    pub group_id: String,
    pub name: String,
    pub created_by: String,
    /// Each member and whether they are an admin.
    pub members: Vec<(String, bool)>,
    /// You are an admin (you may remove others).
    pub am_admin: bool,
    /// The group has reached its member limit.
    pub full: bool,
    pub max_members: usize,
    /// How many of the other members are connected right now.
    pub connected: usize,
}

/// The newest message of a conversation, as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastMessage {
    /// The text, or "Message deleted", or a paperclip and the file's name.
    pub text: String,
    pub at: i64,
    pub own: bool,
    pub sender: UserId,
}

/// One conversation as a chat list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationSummary {
    pub conversation: ConversationId,
    pub last: Option<LastMessage>,
    /// Messages from others you have not read.
    pub unread: usize,
}

/// How far a message of yours has got with each person it is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryDetail {
    pub message_id: MessageId,
    /// People it has still to reach.
    pub pending: usize,
    /// People it is for (the others in the chat).
    pub total: usize,
}

/// Connection setup carried in sealed messages. The platform's WebRTC code produces and consumes the descriptions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignalMessage {
    /// "I am online and waiting": the other side (if it dials) should offer now.
    Ready,
    Offer(String),
    Answer(String),
}

/// Our open six-word invite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteView {
    pub words: String,
    pub expires_at: i64,
}

/// Someone who used our words and waits for us to accept them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestView {
    pub uid: UserId,
    pub name: String,
    pub safety_number: String,
}

/// Did our own card reach the friend whose words we typed?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnswerStatus {
    Sent,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnswerView {
    pub uid: UserId,
    pub status: AnswerStatus,
}

/// Everything a recreated UI needs, so it never depends on having seen every historical event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// Number of the last event this snapshot includes. Events after it have a higher number.
    pub seq: u64,
    pub own_uid: Option<UserId>,
    pub contacts: Vec<ContactView>,
    pub groups: Vec<GroupView>,
    /// Last message and unread count per conversation (only conversations with messages).
    pub summaries: Vec<ConversationSummary>,
    /// Delivery detail for your own messages that still have people to reach.
    pub deliveries: Vec<DeliveryDetail>,
    /// Names of the public channels joined.
    pub channels: Vec<String>,
    /// Reactions per message: who reacted with what.
    pub reactions: Vec<(MessageId, Vec<(UserId, String)>)>,
    /// Messages deleted for everyone (they show as removed).
    pub deleted: Vec<MessageId>,
    /// People whose channel messages are hidden.
    pub muted: Vec<UserId>,
    pub invite: Option<InviteView>,
    pub requests: Vec<RequestView>,
    pub answer: Option<AnswerView>,
    /// We are looking for the card behind words we typed.
    pub lookup_pending: bool,
    pub messages: Vec<(ConversationId, Vec<ChatMessage>)>,
    pub queued: usize,
    /// The name each person gave in a public channel (they are not contacts).
    pub channel_people: Vec<(UserId, String)>,
    /// Type and size of every file message that is stored.
    pub files: Vec<(MessageId, privcord_ports::FileInfo)>,
}

/// Something that happened. Each has a number; numbers rise by one, so a gap means events were missed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineEvent {
    Ready,
    IdentityCreated,
    ContactAdded {
        uid: UserId,
    },
    MessageAdded {
        conversation: ConversationId,
        message_id: MessageId,
        own: bool,
    },
    MessageStatusChanged {
        message_id: MessageId,
        status: DeliveryState,
    },
    /// A group's membership, name or history changed (or you joined or left it).
    GroupChanged {
        group_id: String,
    },
    /// Our open invite appeared, changed or closed, or the list of requests changed.
    InviteChanged,
    InviteRequest {
        uid: UserId,
    },
    InviteFound {
        uid: UserId,
        name: String,
        safety_number: String,
        already: bool,
    },
    InviteLookupFailed,
    AnswerChanged,
    ContactRemoved {
        uid: UserId,
    },
    /// Time to dial this person: their link is down and the backoff has passed. `initiator` is true when we are the
    /// side that sends the offer (the lower uid).
    DialRequested {
        peer: UserId,
        initiator: bool,
    },
    /// An emergency deletion ran (the report says how far it got).
    Wiped,
    /// A contact sent connection setup. Hand `Offer` and `Answer` to the WebRTC code; on `Ready`, dial if you are the
    /// side that offers.
    SignalReceived {
        peer: UserId,
        message: SignalMessage,
    },
    /// A message's reactions or its deleted mark changed.
    MessageChanged {
        message_id: MessageId,
    },
    /// A message was removed from this device ("delete for me").
    MessageRemoved {
        message_id: MessageId,
    },
    /// A backup was restored: ask for a snapshot.
    Restored,
    /// A setting the snapshot shows changed (the muted list).
    SettingsChanged,
    /// A file is arriving: how much of it is here, in percent.
    FileProgress {
        message_id: MessageId,
        percent: u8,
    },
    /// A file from `conversation` has started to arrive (so the chat can show it before it is whole).
    FileIncoming {
        conversation: ConversationId,
        message_id: MessageId,
        name: String,
        size: usize,
    },
    /// A file has been handed to the link for `peer`: `frames` frames, the first of which is the offer.
    FileQueued {
        peer: UserId,
        message_id: MessageId,
        frames: u32,
    },
    MessageRefused {
        message_id: MessageId,
    },
    PeerStateChanged {
        peer: UserId,
        state: ConnectionState,
    },
    /// This subscriber fell behind and `missed` events were dropped. Ask for a snapshot.
    Lagged {
        missed: u64,
    },
    ShutDown,
}
