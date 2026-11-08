//! The engine's state machine. Synchronous and deterministic: every input is a method call, every effect goes out
//! through a port. The async runtime in `runtime.rs` is only a thin shell around this, which is what makes the rules
//! testable without threads, sockets or sleeps.
//!
//! Responsibilities (the PRD's services, kept as separate sections rather than one giant type):
//! identity, contacts and trust, peer lifecycle and authentication, messaging, delivery (outbox and retries),
//! state snapshots and events.

use crate::{
    api::{ContactView, EngineEvent, GroupView, Snapshot},
    error::ErrorCode,
    events::{EventHub, EventStream},
};
use privcord_crypto::{
    card::{Contact, ContactCard},
    channel::{derive_channel, open_channel_message, seal_channel_message, ChannelKeys},
    group::Role,
    group_coordinator::{
        GroupCoordinator, GroupError, GroupFrame, GroupMessage, GroupResult, MessageVerdict, Who,
    },
    identity::{Identity, StoredSecrets},
    peer_auth::{Expected, PeerAuth},
    rng::Entropy,
    safety::derive_safety_number,
    secure_channel::{Data, Hello, SecureChannel},
    CryptoError,
};
use privcord_domain::{
    channel::normalize_channel_name,
    files::{file_chunks, AssembleResult, BeginOutcome, FileAssembler, FileChunk, FileOffer},
    limits::PROTOCOL_VERSION,
    link_policy::{
        due_links, is_initiator, LinkInfo, LivenessMonitor, LivenessTick, PendingGroupBuffer,
        MAX_CONNECTING, MAX_LINKS, PING_INTERVAL_MS,
    },
    mesh::{MeshNode, Outgoing as MeshOutgoing},
    message::{
        declined_frame, parse_declined_frame, ChatMessage, DeclineReason, DeliveryState,
        MessageKind, ReplyRef, TransportKind,
    },
    ordering::sort_messages,
    privacy::{accepts_direct, can_start_direct, ContactTrust},
    state::{ConnectionEvent, ConnectionFailure, ConnectionPath, ConnectionState},
    ConversationId, GroupId, MessageId, UserId,
};
use privcord_ports::{
    Clock, Notification, Notifier, OutboxEntry, SecureStore, Storage, StorageOp, StoredContact,
    StoredFile, StoredMessage, Transport,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Arc,
};
use zeroize::Zeroizing;

mod backup;
mod invites;
mod privacy;
mod signaling;
mod social;

pub use backup::RestoreSummary;
pub use social::SearchHit;

pub use invites::InvitePreview;

/// A frame larger than this is dropped before it is parsed (SEC-04, SEC-09).
pub const MAX_FRAME_BYTES: usize = 128 * 1024;
/// How long to wait for a delivery receipt before sending a message again.
pub const RETRY_AFTER_MS: i64 = 20_000;
/// How long a hello that arrived early stays valid.
const EARLY_HELLO_MS: i64 = 10_000;
/// A dial request counts as in progress for this long unless the link comes up or fails sooner.
const DIAL_GRACE_MS: i64 = 8_000;
const KV_DEVICE_ID: &str = "device_id";
const KV_GROUP_ONLY: &str = "settings.group_only";
const KV_GROUPS: &str = "groups.v1";
const KV_CHANNELS: &str = "channels.v1";

/// Everything the engine reaches the outside world through.
pub struct Ports {
    pub storage: Arc<dyn Storage>,
    pub secure: Arc<dyn SecureStore>,
    pub transport: Arc<dyn Transport>,
    pub clock: Arc<dyn Clock>,
    pub notifier: Arc<dyn Notifier>,
    pub entropy: Box<dyn Entropy + Send>,
}

impl std::fmt::Debug for Ports {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Ports(..)")
    }
}

/// How the link to a person is protected and authenticated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkSecurity {
    /// The adapter's link is not encrypted (Bluetooth): the engine authenticates with the secure-channel handshake and
    /// encrypts every frame itself.
    EngineEncrypted,
    /// The link is already encrypted (a WebRTC data channel): the engine uses the legacy peer handshake the existing apps
    /// speak and sends plain frames afterwards, so it can talk to them.
    TransportEncrypted,
    /// What the existing apps do over Bluetooth: the secure-channel handshake first, then the legacy peer handshake
    /// inside the encrypted channel, then encrypted frames.
    Layered,
}

/// A secure channel with the legacy peer handshake running inside it.
struct Layered {
    channel: SecureChannel,
    auth: PeerAuth,
    auth_sent: bool,
}

enum Session {
    Secure(Box<SecureChannel>),
    Legacy(Box<PeerAuth>),
    Layered(Box<Layered>),
}

struct Peer {
    state: ConnectionState,
    session: Option<Session>,
    path: ConnectionPath,
    /// Their "stay group-only" choice, once they have told us.
    group_only: Option<bool>,
    /// Their hello, if it arrived a moment before the adapter told us the link was up (and when).
    early_hello: Option<(Value, i64)>,
    /// Files arriving from them right now.
    files: FileAssembler,
    /// When anything last arrived on this link.
    liveness: LivenessMonitor,
    last_ping_at: i64,
    /// Dial bookkeeping for the reconnect backoff.
    attempts: u32,
    last_attempt_at: i64,
}

impl Peer {
    fn offline() -> Self {
        Self {
            state: ConnectionState::Offline,
            session: None,
            path: ConnectionPath::Unknown,
            group_only: None,
            early_hello: None,
            files: FileAssembler::new(),
            liveness: LivenessMonitor::new(0),
            last_ping_at: 0,
            attempts: 0,
            last_attempt_at: 0,
        }
    }
    fn ready(&self) -> bool {
        match &self.session {
            Some(Session::Secure(c)) => c.ready(),
            Some(Session::Legacy(a)) => a.authenticated(),
            Some(Session::Layered(l)) => l.channel.ready() && l.auth.authenticated(),
            None => false,
        }
    }
}

pub struct Core {
    ports: Ports,
    identity: Option<Identity>,
    uid: Option<UserId>,
    contacts: BTreeMap<UserId, StoredContactState>,
    messages: HashMap<MessageId, StoredMessage>,
    outbox: Vec<OutboxEntry>,
    peers: HashMap<UserId, Peer>,
    group_only: bool,
    hub: EventHub,
    shut_down: bool,
    /// Names the conversation in the legacy handshake challenge. Must equal the other app's setting ("duo" by default).
    context: String,
    /// Group logs and their rules; built once there is an identity.
    groups: Option<GroupCoordinator>,
    /// Public channels we have joined, with their derived keys.
    channels: BTreeMap<String, ChannelKeys>,
    /// Our place in the Bluetooth mesh (neighbours are anonymous radio links, not contacts).
    mesh: MeshNode,
    invites: invites::InviteState,
    sealed: signaling::SealedState,
    /// Group messages that arrived before we knew the group: held for a minute, then dropped.
    pending_group: PendingGroupBuffer<Value>,
    /// Everyone's reactions, per message.
    reactions: HashMap<MessageId, BTreeMap<UserId, String>>,
    /// Messages deleted for everyone (only a tombstone is kept).
    deleted: std::collections::HashSet<MessageId>,
    /// People whose channel messages we hide.
    muted: BTreeSet<UserId>,
    /// True only while a message that came through the signaling service is being handled.
    relay_inbound: bool,
    /// The name on our invite cards.
    display_name: Option<String>,
}

struct StoredContactState {
    stored: StoredContact,
    contact: Contact,
}

impl std::fmt::Debug for Core {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Core")
            .field("uid", &self.uid)
            .field("contacts", &self.contacts.len())
            .finish_non_exhaustive()
    }
}

impl Core {
    /// Load everything persisted. Corrupt or unverifiable contact records are skipped, never trusted.
    pub fn new(ports: Ports) -> Result<Self, ErrorCode> {
        Self::new_with_context(ports, "duo")
    }

    /// Like `new`, with the conversation context used by the legacy handshake (the apps' `conversationId` setting).
    pub fn new_with_context(ports: Ports, context: &str) -> Result<Self, ErrorCode> {
        let mut core = Self {
            ports,
            identity: None,
            uid: None,
            contacts: BTreeMap::new(),
            messages: HashMap::new(),
            outbox: Vec::new(),
            peers: HashMap::new(),
            group_only: false,
            hub: EventHub::default(),
            shut_down: false,
            context: context.to_owned(),
            groups: None,
            channels: BTreeMap::new(),
            mesh: MeshNode::default(),
            invites: invites::InviteState::default(),
            sealed: signaling::SealedState::default(),
            pending_group: PendingGroupBuffer::default(),
            reactions: HashMap::new(),
            deleted: std::collections::HashSet::new(),
            muted: BTreeSet::new(),
            relay_inbound: false,
            display_name: None,
        };
        if let Some(secrets) = core.ports.secure.load_identity()? {
            let mut stored = StoredSecrets {
                sign: [0u8; 32],
                dh: [0u8; 32],
            };
            for (dst, src) in stored
                .sign
                .iter_mut()
                .chain(stored.dh.iter_mut())
                .zip(secrets.iter())
            {
                *dst = *src;
            }
            let identity = Identity::from_stored(&stored)?;
            core.uid = Some(identity.uid()?);
            core.identity = Some(identity);
        }
        core.reload_from_storage()?;
        core.hub.publish(EngineEvent::Ready);
        Ok(core)
    }

    /// (Re)read everything the engine keeps from storage: after start, and after a backup was restored into it.
    fn reload_from_storage(&mut self) -> Result<(), ErrorCode> {
        self.contacts.clear();
        self.messages.clear();
        self.reactions.clear();
        self.channels.clear();
        self.groups = None;
        for stored in self.ports.storage.contacts()? {
            if let Some(contact) = ContactCard::decode(&stored.card).filter(|c| c.uid == stored.uid)
            {
                self.contacts
                    .insert(stored.uid.clone(), StoredContactState { stored, contact });
            }
        }
        for m in self.ports.storage.messages()? {
            self.messages.insert(m.message.message_id.clone(), m);
        }
        self.outbox = self.ports.storage.outbox()?;
        for r in self.ports.storage.reactions()? {
            self.reactions
                .entry(r.message_id)
                .or_default()
                .insert(r.uid, r.emoji);
        }
        self.deleted = self.ports.storage.deleted()?.into_iter().collect();
        if let Some(bytes) = self.ports.storage.kv(social::KV_MUTED)? {
            if let Ok(list) = serde_json::from_slice::<Vec<String>>(&bytes) {
                self.muted = list
                    .iter()
                    .filter_map(|u| UserId::new(u.as_str()).ok())
                    .collect();
            }
        }
        self.group_only = self
            .ports
            .storage
            .kv(KV_GROUP_ONLY)?
            .is_some_and(|v| v == b"1");
        self.ensure_groups()?;
        if let Some(bytes) = self.ports.storage.kv(KV_CHANNELS)? {
            if let Ok(names) = serde_json::from_slice::<Vec<String>>(&bytes) {
                for n in names {
                    if let Some(name) = normalize_channel_name(&n) {
                        self.channels.insert(name.clone(), derive_channel(&name)?);
                    }
                }
            }
        }
        self.display_name = self
            .ports
            .storage
            .kv(invites::KV_NAME)?
            .and_then(|b| String::from_utf8(b).ok())
            .filter(|n| !n.is_empty());
        Ok(())
    }

    pub fn subscribe(&mut self) -> EventStream {
        self.hub.subscribe()
    }

    fn now(&self) -> i64 {
        self.ports.clock.now_ms()
    }

    fn require_live(&self) -> Result<(), ErrorCode> {
        if self.shut_down {
            Err(ErrorCode::ShuttingDown)
        } else {
            Ok(())
        }
    }

    /* ---------------------------------------------------------------- identity */

    pub fn own_uid(&self) -> Option<&UserId> {
        self.uid.as_ref()
    }

    fn adopt(&mut self, identity: Identity) -> Result<(), ErrorCode> {
        let s = identity.export_for_storage();
        let mut both = Zeroizing::new([0u8; 64]);
        for (dst, src) in both.iter_mut().zip(s.sign.iter().chain(s.dh.iter())) {
            *dst = *src;
        }
        self.ports.secure.save_identity(&both)?;
        self.uid = Some(identity.uid()?);
        self.identity = Some(identity);
        self.groups = None;
        self.ensure_groups()?;
        self.hub.publish(EngineEvent::IdentityCreated);
        Ok(())
    }

    /// A new identity from a fresh 12-word phrase. The phrase is returned once; the engine does not keep it.
    pub fn create_identity(&mut self) -> Result<Zeroizing<String>, ErrorCode> {
        self.require_live()?;
        if self.identity.is_some() {
            return Err(ErrorCode::IdentityExists);
        }
        let phrase = privcord_crypto::identity::generate_recovery_phrase(&mut *self.ports.entropy)?;
        let identity = Identity::from_phrase(&phrase, "")?;
        self.adopt(identity)?;
        Ok(phrase)
    }

    /// Restore the identity a phrase always produces.
    pub fn recover_identity(&mut self, phrase: &str, passphrase: &str) -> Result<(), ErrorCode> {
        self.require_live()?;
        if self.identity.is_some() {
            return Err(ErrorCode::IdentityExists);
        }
        let identity = Identity::from_phrase(phrase, passphrase).map_err(|e| match e {
            CryptoError::InvalidPhrase => ErrorCode::InvalidPhrase,
            other => other.into(),
        })?;
        self.adopt(identity)
    }

    fn identity(&self) -> Result<&Identity, ErrorCode> {
        self.identity.as_ref().ok_or(ErrorCode::NoIdentity)
    }

    /// The `DUOID1:` text to hand to a friend.
    pub fn own_card(&self, name: Option<&str>) -> Result<String, ErrorCode> {
        Ok(ContactCard::of(self.identity()?, name)?.encode()?)
    }

    /* ---------------------------------------------------------------- contacts */

    pub fn add_contact(
        &mut self,
        card_text: &str,
        trust: ContactTrust,
    ) -> Result<UserId, ErrorCode> {
        self.add_contact_from(card_text, trust, None)
    }

    fn add_contact_from(
        &mut self,
        card_text: &str,
        trust: ContactTrust,
        introduced_by: Option<UserId>,
    ) -> Result<UserId, ErrorCode> {
        self.require_live()?;
        let own = self.uid.clone().ok_or(ErrorCode::NoIdentity)?;
        let contact = ContactCard::decode(card_text).ok_or(ErrorCode::InvalidCard)?;
        if contact.uid == own {
            return Err(ErrorCode::OwnCard);
        }
        // Meeting someone again never lowers trust.
        let trust = match self.contacts.get(&contact.uid) {
            Some(existing) if existing.stored.trust == ContactTrust::Verified => {
                ContactTrust::Verified
            }
            _ => trust,
        };
        let stored = StoredContact {
            uid: contact.uid.clone(),
            card: card_text.trim().to_owned(),
            name: contact.card.name.clone(),
            trust,
            checked: self
                .contacts
                .get(&contact.uid)
                .is_some_and(|c| c.stored.checked),
            introduced_by,
            created_at: self.now(),
        };
        self.ports
            .storage
            .apply(&[StorageOp::PutContact(stored.clone())])?;
        let uid = contact.uid.clone();
        let new = !self.contacts.contains_key(&uid);
        self.contacts
            .insert(uid.clone(), StoredContactState { stored, contact });
        if new {
            self.hub
                .publish(EngineEvent::ContactAdded { uid: uid.clone() });
        }
        Ok(uid)
    }

    /// Mark that safety numbers were compared. Does not change trust.
    pub fn set_checked(&mut self, uid: &UserId, checked: bool) -> Result<(), ErrorCode> {
        self.require_live()?;
        let c = self
            .contacts
            .get_mut(uid)
            .ok_or(ErrorCode::UnknownContact)?;
        let mut stored = c.stored.clone();
        stored.checked = checked;
        self.ports
            .storage
            .apply(&[StorageOp::PutContact(stored.clone())])?;
        c.stored = stored;
        Ok(())
    }

    pub fn safety_number(&self, uid: &UserId) -> Result<String, ErrorCode> {
        let c = self.contacts.get(uid).ok_or(ErrorCode::UnknownContact)?;
        Ok(derive_safety_number(
            &self.identity()?.sign_public(),
            &c.contact.card.sign,
        )?)
    }

    pub fn set_group_only(&mut self, value: bool) -> Result<(), ErrorCode> {
        self.require_live()?;
        self.ports.storage.apply(&[StorageOp::SetKv {
            key: KV_GROUP_ONLY.into(),
            value: vec![u8::from(value) + b'0'],
        }])?;
        self.group_only = value;
        let peers: Vec<UserId> = self
            .peers
            .iter()
            .filter(|(_, p)| p.ready())
            .map(|(u, _)| u.clone())
            .collect();
        for p in peers {
            self.send_privacy(&p);
        }
        Ok(())
    }

    fn may_start_direct(&self, uid: &UserId) -> bool {
        self.contacts.get(uid).is_some_and(|c| {
            can_start_direct(
                c.stored.trust,
                self.group_only,
                self.peers.get(uid).and_then(|p| p.group_only),
            )
        })
    }

    /* ---------------------------------------------------------------- peers */

    fn set_state(&mut self, peer: &UserId, state: ConnectionState) {
        let p = self.peers.entry(peer.clone()).or_insert_with(Peer::offline);
        if p.state != state {
            p.state = state;
            self.hub.publish(EngineEvent::PeerStateChanged {
                peer: peer.clone(),
                state,
            });
        }
    }

    fn step(&mut self, peer: &UserId, event: ConnectionEvent) {
        let current = self
            .peers
            .get(peer)
            .map_or(ConnectionState::Offline, |p| p.state);
        if let Some(next) = current.on(event) {
            self.set_state(peer, next);
        }
    }

    /// A link to a known contact is up (the adapter reports it), protected by the engine's own channel.
    pub fn link_up(&mut self, peer: &UserId, path: ConnectionPath) -> Result<(), ErrorCode> {
        self.link_up_with(peer, path, LinkSecurity::EngineEncrypted)
    }

    /// A link is up. The engine authenticates it before trusting it, in the way `security` says.
    pub fn link_up_with(
        &mut self,
        peer: &UserId,
        path: ConnectionPath,
        security: LinkSecurity,
    ) -> Result<(), ErrorCode> {
        self.require_live()?;
        let own = self.uid.clone().ok_or(ErrorCode::NoIdentity)?;
        let card = self
            .contacts
            .get(peer)
            .ok_or(ErrorCode::UnknownContact)?
            .contact
            .card
            .clone();
        // A new link replaces any older state for this person.
        if self
            .peers
            .get(peer)
            .is_some_and(|p| p.state != ConnectionState::Offline)
        {
            self.link_down(peer);
        }
        let (session, hello) = match security {
            LinkSecurity::Layered => {
                let channel = SecureChannel::new(
                    own.as_str(),
                    peer.as_str(),
                    card.sign.clone(),
                    &mut *self.ports.entropy,
                )?;
                let hello = channel.hello(self.identity()?)?.to_value();
                let device = self.device_id()?;
                let expected = Expected {
                    uid: peer.to_string(),
                    sign: card.sign,
                    dh: card.dh,
                };
                let id = self.identity.as_ref().ok_or(ErrorCode::NoIdentity)?;
                let auth = PeerAuth::new(
                    &self.context,
                    id,
                    &device,
                    expected,
                    &mut *self.ports.entropy,
                )?;
                (
                    Session::Layered(Box::new(Layered {
                        channel,
                        auth,
                        auth_sent: false,
                    })),
                    hello,
                )
            }
            LinkSecurity::EngineEncrypted => {
                let channel = SecureChannel::new(
                    own.as_str(),
                    peer.as_str(),
                    card.sign,
                    &mut *self.ports.entropy,
                )?;
                let hello = channel.hello(self.identity()?)?.to_value();
                (Session::Secure(Box::new(channel)), hello)
            }
            LinkSecurity::TransportEncrypted => {
                let device = self.device_id()?;
                let expected = Expected {
                    uid: peer.to_string(),
                    sign: card.sign,
                    dh: card.dh,
                };
                let id = self.identity.as_ref().ok_or(ErrorCode::NoIdentity)?;
                let auth = PeerAuth::new(
                    &self.context,
                    id,
                    &device,
                    expected,
                    &mut *self.ports.entropy,
                )?;
                let hello = auth.hello(id)?;
                (Session::Legacy(Box::new(auth)), hello)
            }
        };
        {
            let p = self.peers.entry(peer.clone()).or_insert_with(Peer::offline);
            p.session = Some(session);
            p.path = path;
        }
        self.step(peer, ConnectionEvent::Dial);
        // The handshake travels in the clear by design: it is signed, and carries only keys and a nonce.
        if self.ports.transport.send(peer, &hello.to_string()).is_err() {
            self.fail(peer, ConnectionFailure::TransportClosed);
            return Ok(());
        }
        let now = self.now();
        let early = self
            .peers
            .get_mut(peer)
            .and_then(|p| p.early_hello.take())
            .filter(|(_, at)| now - at <= EARLY_HELLO_MS);
        if let Some((hello, _)) = early {
            self.handshake_frame(peer, &hello);
        }
        Ok(())
    }

    /// A stable random id for this installation, made on first use (the legacy handshake carries one).
    fn device_id(&mut self) -> Result<String, ErrorCode> {
        if let Some(existing) = self.ports.storage.kv(KV_DEVICE_ID)? {
            if let Ok(text) = String::from_utf8(existing) {
                return Ok(text);
            }
        }
        let bytes: [u8; 16] = privcord_crypto::rng::random_array(&mut *self.ports.entropy)?;
        let id = privcord_domain::codec::hex(&bytes);
        self.ports.storage.apply(&[StorageOp::SetKv {
            key: KV_DEVICE_ID.into(),
            value: id.clone().into_bytes(),
        }])?;
        Ok(id)
    }

    /// The adapter lost the link. Identity and message state are untouched; only the session ends.
    pub fn link_down(&mut self, peer: &UserId) {
        if let Some(p) = self.peers.get_mut(peer) {
            p.session = None;
            p.early_hello = None;
            p.files.clear();
        }
        self.step(peer, ConnectionEvent::Closed);
        if self
            .peers
            .get(peer)
            .is_some_and(|p| matches!(p.state, ConnectionState::Connecting))
        {
            self.set_state(peer, ConnectionState::Offline);
        }
    }

    fn fail(&mut self, peer: &UserId, reason: ConnectionFailure) {
        if let Some(p) = self.peers.get_mut(peer) {
            p.session = None;
            p.files.clear();
        }
        self.step(peer, ConnectionEvent::Failed(reason));
        if !matches!(
            self.peers.get(peer).map(|p| p.state),
            Some(ConnectionState::Failed { .. })
        ) {
            self.set_state(peer, ConnectionState::Failed { reason });
        }
    }

    /// One frame arrived from a peer. Anything malformed, too big, unauthenticated or replayed is dropped.
    pub fn frame_received(&mut self, peer: &UserId, text: &str) {
        if self.shut_down || text.len() > MAX_FRAME_BYTES || !self.contacts.contains_key(peer) {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            return;
        };
        // A hello can overtake the adapter's own "link is up" report. Keep one for a few seconds instead of losing it.
        if self.peers.get(peer).is_none_or(|p| p.session.is_none()) {
            if matches!(
                value.get("kind").and_then(Value::as_str),
                Some("sc_hello" | "hello")
            ) {
                let now = self.now();
                self.peers
                    .entry(peer.clone())
                    .or_insert_with(Peer::offline)
                    .early_hello = Some((value, now));
            }
            return;
        }
        let ready = self.peers.get(peer).is_some_and(Peer::ready);
        if !ready {
            self.heard_from(peer);
            self.handshake_frame(peer, &value);
            return;
        }
        let inner = match self.peers.get_mut(peer).and_then(|p| p.session.as_mut()) {
            // Engine-encrypted: decrypt and check the counter.
            Some(Session::Secure(c)) => {
                let Some(data) = Data::from_value(&value) else {
                    return;
                };
                match c.decrypt(&data) {
                    Ok(v) => v,
                    Err(_) => return,
                }
            }
            Some(Session::Layered(l)) => {
                let Some(data) = Data::from_value(&value) else {
                    return;
                };
                match l.channel.decrypt(&data) {
                    Ok(v) => v,
                    Err(_) => return,
                }
            }
            // Transport-encrypted: the frame is already plain JSON.
            Some(Session::Legacy(_)) => value,
            None => return,
        };
        // Anything that decrypted and passed the counter check is proof the other side is alive.
        self.heard_from(peer);
        self.dispatch(peer, &inner);
    }

    fn heard_from(&mut self, peer: &UserId) {
        let now = self.now();
        if let Some(p) = self.peers.get_mut(peer) {
            p.liveness.on_inbound(now);
        }
    }

    /// One handshake frame on a layered link: the channel's hello first, then the peer handshake, encrypted. Returns the
    /// frames to send (already encrypted), or `Err` when the other side failed to prove itself.
    fn layered_step(
        l: &mut Layered,
        own: &privcord_crypto::identity::Identity,
        value: &Value,
    ) -> Option<Result<Vec<Value>, ()>> {
        if !l.channel.ready() {
            let hello = Hello::from_value(value)?;
            if l.channel.accept(&hello).is_err() {
                return Some(Err(()));
            }
            // The channel is up: our peer-handshake hello goes inside it.
            let first = l.auth.hello(own).ok()?;
            l.auth_sent = true;
            let data = l.channel.encrypt(&first).ok()?;
            return Some(Ok(vec![data.to_value()]));
        }
        let inner = match Data::from_value(value).map(|d| l.channel.decrypt(&d)) {
            Some(Ok(v)) => v,
            _ => return Some(Err(())),
        };
        match l.auth.on_frame(own, &inner) {
            Ok(Some(out)) => {
                let mut sealed = Vec::with_capacity(out.len());
                for f in out {
                    match l.channel.encrypt(&f) {
                        Ok(d) => sealed.push(d.to_value()),
                        Err(_) => return Some(Err(())),
                    }
                }
                Some(Ok(sealed))
            }
            Ok(None) => None,
            Err(_) => Some(Err(())),
        }
    }

    fn handshake_frame(&mut self, peer: &UserId, value: &Value) {
        let Some(mut session) = self.peers.get_mut(peer).and_then(|p| p.session.take()) else {
            return;
        };
        let outcome = match &mut session {
            Session::Secure(channel) => Hello::from_value(value)
                .map(|hello| channel.accept(&hello).map(|()| Vec::new()).map_err(|_| ())),
            Session::Legacy(auth) => {
                let Some(own) = self.identity.as_ref() else {
                    return;
                };
                match auth.on_frame(own, value) {
                    Ok(Some(out)) => Some(Ok(out)),
                    Ok(None) => None,
                    Err(_) => Some(Err(())),
                }
            }
            Session::Layered(l) => {
                let Some(own) = self.identity.as_ref() else {
                    return;
                };
                Self::layered_step(l, own, value)
            }
        };
        let ready = match &session {
            Session::Secure(c) => c.ready(),
            Session::Legacy(a) => a.authenticated(),
            Session::Layered(l) => l.channel.ready() && l.auth.authenticated(),
        };
        if let Some(p) = self.peers.get_mut(peer) {
            p.session = Some(session);
        }
        match outcome {
            Some(Ok(out)) => {
                for frame in out {
                    if self.ports.transport.send(peer, &frame.to_string()).is_err() {
                        self.link_down(peer);
                        return;
                    }
                }
                if ready {
                    let path = self
                        .peers
                        .get(peer)
                        .map_or(ConnectionPath::Unknown, |p| p.path);
                    let now = self.now();
                    if let Some(p) = self.peers.get_mut(peer) {
                        p.liveness = LivenessMonitor::new(now);
                        p.last_ping_at = now;
                        p.attempts = 0;
                    }
                    self.step(peer, ConnectionEvent::Established(path));
                    self.send_privacy(peer);
                    self.send_group_hello(peer);
                    self.sync_social(peer);
                    self.flush(peer);
                }
            }
            Some(Err(())) => self.fail(peer, ConnectionFailure::AuthenticationFailed),
            None => {}
        }
    }

    /// Send one inner frame: encrypted by the engine on a link that is not encrypted, plain on one that is. A transport
    /// that refuses ends the session (it will be re-established).
    fn send_secure(&mut self, peer: &UserId, frame: &Value) -> bool {
        let text = match self.peers.get_mut(peer).and_then(|p| p.session.as_mut()) {
            Some(Session::Secure(c)) if c.ready() => match c.encrypt(frame) {
                Ok(data) => data.to_value().to_string(),
                Err(_) => return false,
            },
            Some(Session::Legacy(a)) if a.authenticated() => frame.to_string(),
            Some(Session::Layered(l)) if l.channel.ready() && l.auth.authenticated() => {
                match l.channel.encrypt(frame) {
                    Ok(data) => data.to_value().to_string(),
                    Err(_) => return false,
                }
            }
            _ => return false,
        };
        if self.ports.transport.send(peer, &text).is_err() {
            self.link_down(peer);
            return false;
        }
        true
    }

    fn send_privacy(&mut self, peer: &UserId) {
        let frame =
            json!({ "v": PROTOCOL_VERSION, "kind": "privacy", "groupOnly": self.group_only });
        self.send_secure(peer, &frame);
    }

    /* ---------------------------------------------------------------- inbound frames */

    fn dispatch(&mut self, peer: &UserId, frame: &Value) {
        match frame.get("kind").and_then(Value::as_str) {
            Some("message") => self.on_message(peer, frame),
            Some("ack") => self.on_ack(peer, frame),
            Some("declined") => self.on_declined(peer, frame),
            Some("group_push" | "group_events" | "group_have") => self.on_group_frame(peer, frame),
            Some("gmsg") => self.on_group_message(peer, frame),
            Some("relay_blob") => self.on_relay_blob(peer, frame),
            Some("delete") => self.on_delete_frame(peer, frame),
            Some("react") => self.on_react_frame(peer, frame),
            Some("file_offer") => self.on_file_offer(peer, frame),
            Some("file_chunk") => self.on_file_chunk(peer, frame),
            Some("privacy") => {
                if let Some(g) = frame.get("groupOnly").and_then(Value::as_bool) {
                    if let Some(p) = self.peers.get_mut(peer) {
                        p.group_only = Some(g);
                    }
                }
            }
            Some("ping") => {
                let at = frame.get("at").cloned().unwrap_or(Value::Null);
                self.send_secure(
                    peer,
                    &json!({ "v": PROTOCOL_VERSION, "kind": "pong", "at": at }),
                );
            }
            _ => {}
        }
    }

    fn on_message(&mut self, peer: &UserId, frame: &Value) {
        let Some(mut message) = ChatMessage::from_peer_frame(frame) else {
            return;
        };
        // The link is authenticated as `peer`; a message that claims another sender is forged.
        if &message.sender_id != peer {
            return;
        }
        let trust = self
            .contacts
            .get(peer)
            .map_or(ContactTrust::Introduced, |c| c.stored.trust);
        if !accepts_direct(trust, self.group_only) {
            self.send_secure(
                peer,
                &declined_frame(&message.message_id, DeclineReason::DirectNotAccepted),
            );
            return;
        }
        let ack = |core: &mut Self, id: &MessageId| {
            let at = core.now();
            core.send_ack(peer, id, at);
        };
        // Receiving twice is harmless: acknowledge again, store nothing.
        if self.messages.contains_key(&message.message_id) {
            let id = message.message_id.clone();
            ack(self, &id);
            return;
        }
        message.delivery_state = DeliveryState::Delivered;
        message.transport = self.inbound_transport();
        let conversation = ConversationId::Direct(peer.clone());
        let row = StoredMessage {
            conversation: conversation.clone(),
            message: message.clone(),
        };
        if self
            .ports
            .storage
            .apply(&[StorageOp::InsertMessage(row.clone())])
            .is_err()
        {
            // Not stored, so not acknowledged: the sender will send it again.
            return;
        }
        self.messages.insert(message.message_id.clone(), row);
        self.hub.publish(EngineEvent::MessageAdded {
            conversation: conversation.clone(),
            message_id: message.message_id.clone(),
            own: false,
        });
        self.ports.notifier.notify(Notification::MessageReceived {
            conversation,
            sender: peer.clone(),
            preview: message.text.chars().take(80).collect(),
        });
        let id = message.message_id;
        ack(self, &id);
    }

    /// Is this a message we sent to `peer` (directly, or as one member of a group)?
    fn is_ours_to(&self, id: &MessageId, peer: &UserId) -> bool {
        self.messages.get(id).is_some_and(|m| {
            Some(&m.message.sender_id) == self.uid.as_ref()
                && match &m.conversation {
                    ConversationId::Direct(p) => p == peer,
                    // A group message went to each member separately: that member (and only they) may answer for it.
                    ConversationId::Group(_) => self
                        .outbox
                        .iter()
                        .any(|o| &o.message_id == id && &o.recipient == peer),
                    ConversationId::Channel(_) => false,
                }
        })
    }

    fn on_ack(&mut self, peer: &UserId, frame: &Value) {
        let Some(id) = frame
            .get("messageId")
            .and_then(Value::as_str)
            .and_then(|s| MessageId::new(s).ok())
        else {
            return;
        };
        let state = match frame.get("state").and_then(Value::as_str) {
            Some("DELIVERED") => DeliveryState::Delivered,
            Some("READ") => DeliveryState::Read,
            _ => return,
        };
        // Only the person we sent it to may acknowledge it.
        let ours = self.is_ours_to(&id, peer);
        if !ours {
            return;
        }
        let Some(current) = self.messages.get(&id).map(|m| m.message.delivery_state) else {
            return;
        };
        let mut next = DeliveryState::highest(current, state);
        // A group message counts as delivered when everyone has it, not when the first person does.
        let others_pending = matches!(
            self.messages.get(&id).map(|m| &m.conversation),
            Some(ConversationId::Group(_))
        ) && self
            .outbox
            .iter()
            .any(|o| o.message_id == id && &o.recipient != peer);
        if others_pending && matches!(next, DeliveryState::Delivered | DeliveryState::Read) {
            next = current;
        }
        let read_at = (next == DeliveryState::Read).then(|| self.now());
        let ops = [
            StorageOp::SetDelivery {
                id: id.clone(),
                state: next,
                read_at,
            },
            StorageOp::RemoveOutbox {
                message_id: id.clone(),
                recipient: peer.clone(),
            },
        ];
        if self.ports.storage.apply(&ops).is_err() {
            return;
        }
        self.outbox
            .retain(|o| !(o.message_id == id && &o.recipient == peer));
        if let Some(m) = self.messages.get_mut(&id) {
            m.message.delivery_state = next;
            m.message.read_at = read_at.or(m.message.read_at);
        }
        if next != current {
            self.hub.publish(EngineEvent::MessageStatusChanged {
                message_id: id,
                status: next,
            });
        }
    }

    fn on_declined(&mut self, peer: &UserId, frame: &Value) {
        let Some((id, _reason)) = parse_declined_frame(frame) else {
            return;
        };
        let ours = self.is_ours_to(&id, peer);
        if !ours {
            return;
        }
        let ops = [
            StorageOp::SetDelivery {
                id: id.clone(),
                state: DeliveryState::Failed,
                read_at: None,
            },
            StorageOp::RemoveOutbox {
                message_id: id.clone(),
                recipient: peer.clone(),
            },
        ];
        if self.ports.storage.apply(&ops).is_err() {
            return;
        }
        self.outbox
            .retain(|o| !(o.message_id == id && &o.recipient == peer));
        if let Some(m) = self.messages.get_mut(&id) {
            m.message.delivery_state = DeliveryState::Failed;
        }
        self.hub
            .publish(EngineEvent::MessageRefused { message_id: id });
    }

    /* ---------------------------------------------------------------- messaging and delivery */

    fn new_message_id(&mut self) -> Result<MessageId, ErrorCode> {
        let mut b = [0u8; 16];
        self.ports.entropy.fill(&mut b).map_err(ErrorCode::from)?;
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        let [b0, b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12, b13, b14, b15] = b;
        let id = format!(
            "{b0:02x}{b1:02x}{b2:02x}{b3:02x}-{b4:02x}{b5:02x}-{b6:02x}{b7:02x}-{b8:02x}{b9:02x}-{b10:02x}{b11:02x}{b12:02x}{b13:02x}{b14:02x}{b15:02x}"
        );
        MessageId::new(id).map_err(|_| ErrorCode::Crypto)
    }

    /// Write a message to someone. It is stored with its outbox entry in one atomic step, so a crash can never lose it
    /// or leave it half-recorded; it is then sent as soon as the link is up.
    pub fn send_message(
        &mut self,
        peer: &UserId,
        text: &str,
        reply_to: Option<&MessageId>,
    ) -> Result<MessageId, ErrorCode> {
        self.require_live()?;
        let own = self.uid.clone().ok_or(ErrorCode::NoIdentity)?;
        if !self.contacts.contains_key(peer) {
            return Err(ErrorCode::UnknownContact);
        }
        if !self.may_start_direct(peer) {
            return Err(ErrorCode::DirectNotAllowed);
        }
        let reply = match reply_to {
            None => None,
            Some(id) => {
                let m = self.messages.get(id).ok_or(ErrorCode::UnknownMessage)?;
                Some(ReplyRef::quoting(
                    &m.message.message_id,
                    &m.message.sender_id,
                    &m.message.text,
                ))
            }
        };
        let id = self.new_message_id()?;
        let now = self.now();
        let message =
            ChatMessage::outgoing(own, text, now, id.clone(), reply).map_err(|e| match e {
                privcord_domain::DomainError::EmptyMessage => ErrorCode::EmptyMessage,
                _ => ErrorCode::MessageTooLong,
            })?;
        let conversation = ConversationId::Direct(peer.clone());
        let row = StoredMessage {
            conversation: conversation.clone(),
            message,
        };
        let entry = OutboxEntry {
            message_id: id.clone(),
            recipient: peer.clone(),
            attempts: 0,
            next_try_ms: now,
        };
        self.ports.storage.apply(&[
            StorageOp::InsertMessage(row.clone()),
            StorageOp::PutOutbox(entry.clone()),
        ])?;
        self.messages.insert(id.clone(), row);
        self.outbox.push(entry);
        self.hub.publish(EngineEvent::MessageAdded {
            conversation,
            message_id: id.clone(),
            own: true,
        });
        self.flush(peer);
        Ok(id)
    }

    /// Send what is due for one person, if their link is up and authenticated.
    fn flush(&mut self, peer: &UserId) {
        if !self.peers.get(peer).is_some_and(Peer::ready) {
            return;
        }
        let now = self.now();
        let due: Vec<OutboxEntry> = self
            .outbox
            .iter()
            .filter(|o| &o.recipient == peer && o.next_try_ms <= now)
            .cloned()
            .collect();
        for entry in due {
            let Some(row) = self.messages.get(&entry.message_id) else {
                continue;
            };
            let frames: Vec<Value> = if row.message.kind == MessageKind::File {
                let Ok(Some(file)) = self.ports.storage.file(&entry.message_id) else {
                    continue;
                };
                let group = match &row.conversation {
                    ConversationId::Group(g) => Some(g.as_str().to_owned()),
                    _ => None,
                };
                let Ok(offer) = FileOffer::make(
                    entry.message_id.clone(),
                    group,
                    &file.name,
                    &file.mime,
                    &file.bytes,
                    row.message.client_created_at,
                    row.message.reply_to.clone(),
                ) else {
                    continue;
                };
                std::iter::once(offer.to_frame())
                    .chain(file_chunks(&entry.message_id, &file.bytes).map(|c| c.to_frame()))
                    .collect()
            } else {
                vec![match &row.conversation {
                    ConversationId::Group(g) => GroupFrame::Message(GroupMessage {
                        group_id: g.as_str().to_owned(),
                        message_id: row.message.message_id.clone(),
                        text: row.message.text.clone(),
                        client_created_at: row.message.client_created_at,
                        reply_to: row.message.reply_to.clone(),
                    })
                    .to_value(),
                    _ => row.message.to_peer_frame(),
                }]
            };
            let was_queued = row.message.delivery_state == DeliveryState::Queued;
            let all_sent = frames.iter().all(|f| self.send_secure(peer, f));
            if !all_sent {
                return;
            }
            let next = OutboxEntry {
                attempts: entry.attempts + 1,
                next_try_ms: now + RETRY_AFTER_MS,
                ..entry.clone()
            };
            let mut ops = vec![StorageOp::PutOutbox(next.clone())];
            if was_queued {
                ops.push(StorageOp::SetDelivery {
                    id: entry.message_id.clone(),
                    state: DeliveryState::Sent,
                    read_at: None,
                });
            }
            if self.ports.storage.apply(&ops).is_err() {
                continue;
            }
            if let Some(o) = self
                .outbox
                .iter_mut()
                .find(|o| o.message_id == next.message_id && o.recipient == next.recipient)
            {
                *o = next;
            }
            if was_queued {
                if let Some(m) = self.messages.get_mut(&entry.message_id) {
                    m.message.delivery_state = DeliveryState::Sent;
                }
                self.hub.publish(EngineEvent::MessageStatusChanged {
                    message_id: entry.message_id,
                    status: DeliveryState::Sent,
                });
            }
        }
    }

    /// Mark everything from a person as read and tell them.
    pub fn mark_read(&mut self, peer: &UserId) -> Result<(), ErrorCode> {
        self.require_live()?;
        let ids: Vec<MessageId> = self
            .messages
            .values()
            .filter(|m| {
                m.conversation == ConversationId::Direct(peer.clone())
                    && &m.message.sender_id == peer
                    && m.message.read_at.is_none()
            })
            .map(|m| m.message.message_id.clone())
            .collect();
        let now = self.now();
        for id in ids {
            self.ports.storage.apply(&[StorageOp::SetDelivery {
                id: id.clone(),
                state: DeliveryState::Read,
                read_at: Some(now),
            }])?;
            if let Some(m) = self.messages.get_mut(&id) {
                m.message.delivery_state = DeliveryState::Read;
                m.message.read_at = Some(now);
            }
            self.send_secure(peer, &json!({ "v": PROTOCOL_VERSION, "kind": "ack", "messageId": id, "state": "READ", "at": now }));
        }
        Ok(())
    }

    /// Time passes: ping live links, drop silent ones, ask adapters to dial what is due, resend what was never
    /// acknowledged, and keep invites moving.
    pub fn tick(&mut self) {
        if self.shut_down {
            return;
        }
        let now = self.now();
        let ready: Vec<UserId> = self
            .peers
            .iter()
            .filter(|(_, p)| p.ready())
            .map(|(u, _)| u.clone())
            .collect();
        for peer in ready {
            let Some(p) = self.peers.get_mut(&peer) else {
                continue;
            };
            if p.liveness.tick(now) == LivenessTick::Lost {
                // Nothing at all for too long: the link is dead even if the radio never said so.
                self.fail(&peer, ConnectionFailure::Timeout);
                self.ports.transport.close(&peer);
                continue;
            }
            if now - p.last_ping_at >= PING_INTERVAL_MS {
                p.last_ping_at = now;
                self.send_secure(
                    &peer,
                    &json!({ "v": PROTOCOL_VERSION, "kind": "ping", "at": now }),
                );
            }
            self.flush(&peer);
        }
        self.pending_group.expire(now);
        self.request_dials(now);
        self.tick_invites();
        self.tick_sealed();
    }

    /// Ask for a dial to each person whose link is down and whose backoff has passed (5 s doubling to 2 minutes, a few
    /// at a time, never past the open-link cap).
    fn request_dials(&mut self, now: i64) {
        let links: Vec<LinkInfo> = self
            .contacts
            .keys()
            .map(|uid| {
                let p = self.peers.get(uid);
                LinkInfo {
                    uid: uid.to_string(),
                    ready: p.is_some_and(Peer::ready),
                    // A dial the adapter has not reported yet still takes up a slot for a few seconds.
                    connecting: p.is_some_and(|p| {
                        p.state == ConnectionState::Connecting
                            || (!p.ready()
                                && p.attempts > 0
                                && now - p.last_attempt_at < DIAL_GRACE_MS)
                    }),
                    last_attempt_at: p.map_or(0, |p| p.last_attempt_at),
                    attempts: p.map_or(0, |p| p.attempts),
                    dialable: true,
                }
            })
            .collect();
        let Some(own) = self.uid.clone() else {
            return;
        };
        for uid in due_links(&links, now, MAX_CONNECTING, MAX_LINKS) {
            let Ok(peer) = UserId::new(uid.as_str()) else {
                continue;
            };
            let p = self.peers.entry(peer.clone()).or_insert_with(Peer::offline);
            p.last_attempt_at = now;
            p.attempts = p.attempts.saturating_add(1);
            self.hub.publish(EngineEvent::DialRequested {
                initiator: is_initiator(own.as_str(), uid.as_str()),
                peer,
            });
        }
    }

    /* ---------------------------------------------------------------- groups */

    /// Build the coordinator from the saved group logs (events that no longer verify are dropped).
    fn ensure_groups(&mut self) -> Result<(), ErrorCode> {
        if self.groups.is_some() {
            return Ok(());
        }
        let (Some(id), Some(uid)) = (self.identity.as_ref(), self.uid.as_ref()) else {
            return Ok(());
        };
        let mut coordinator = GroupCoordinator::new(uid.as_str(), ContactCard::of(id, None)?);
        if let Some(bytes) = self.ports.storage.kv(KV_GROUPS)? {
            if let Ok(saved) = serde_json::from_slice::<BTreeMap<String, Vec<Value>>>(&bytes) {
                coordinator.load(&saved);
            }
        }
        self.groups = Some(coordinator);
        Ok(())
    }

    fn persist_groups(&mut self) -> Result<(), ErrorCode> {
        let Some(g) = self.groups.as_ref() else {
            return Ok(());
        };
        let value = serde_json::to_vec(&g.export()).map_err(|_| ErrorCode::Storage)?;
        self.ports.storage.apply(&[StorageOp::SetKv {
            key: KV_GROUPS.into(),
            value,
        }])?;
        Ok(())
    }

    fn group_error(e: &GroupError) -> ErrorCode {
        match e {
            GroupError::NotMember => ErrorCode::NoSuchGroup,
            GroupError::NotAllowed | GroupError::AlreadyMember => ErrorCode::GroupRefused,
            GroupError::Full | GroupError::TooManyMembers => ErrorCode::GroupFull,
            GroupError::Crypto(_) => ErrorCode::Crypto,
        }
    }

    fn card_of(&self, uid: &UserId) -> Result<ContactCard, ErrorCode> {
        Ok(self
            .contacts
            .get(uid)
            .ok_or(ErrorCode::UnknownContact)?
            .contact
            .card
            .clone())
    }

    /// Save what a group operation changed, tell members, add the people it introduced and publish the news.
    fn finish_group_result(&mut self, result: GroupResult) -> Result<(), ErrorCode> {
        // Write only when something changed: a plain "here is what I have" must not touch the disk.
        let changed =
            !(result.changed.is_empty() && result.joined.is_empty() && result.left.is_empty());
        let saved = if changed {
            self.persist_groups()
        } else {
            Ok(())
        };
        for nc in &result.new_contacts {
            let (Ok(text), Ok(introducer)) =
                (nc.card.encode(), UserId::new(nc.introduced_by.as_str()))
            else {
                continue;
            };
            // Introduced people are never trusted more than "introduced": only a safety-number check raises that.
            let _ = self.add_contact_from(&text, ContactTrust::Introduced, Some(introducer));
        }
        for out in &result.outgoing {
            if let Ok(to) = UserId::new(out.to.as_str()) {
                if self.peers.get(&to).is_some_and(Peer::ready) {
                    self.send_secure(&to, &out.frame.to_value());
                }
            }
        }
        for group_id in result.changed.iter().chain(result.joined.iter()) {
            self.hub.publish(EngineEvent::GroupChanged {
                group_id: group_id.clone(),
            });
        }
        self.release_pending_group();
        saved
    }

    /// Messages that waited for their group: handle them now that it is known (expired ones are dropped).
    fn release_pending_group(&mut self) {
        if self.pending_group.is_empty() {
            return;
        }
        let now = self.now();
        let mut buffer = std::mem::take(&mut self.pending_group);
        let ready = buffer.release(now, |group, from| {
            self.groups
                .as_ref()
                .is_some_and(|g| g.check_message(from, group) == MessageVerdict::Ok)
        });
        self.pending_group = buffer;
        for (_, from, frame) in ready {
            if let Ok(from) = UserId::new(from.as_str()) {
                self.on_group_message(&from, &frame);
            }
        }
    }

    /// Tell a newly authenticated peer which groups we share and what we hold, so both sides catch up.
    fn send_group_hello(&mut self, peer: &UserId) {
        let frames = self
            .groups
            .as_ref()
            .map(|g| g.on_link_open(peer.as_str()))
            .unwrap_or_default();
        for f in frames {
            self.send_secure(peer, &f.frame.to_value());
        }
    }

    fn on_group_frame(&mut self, peer: &UserId, value: &Value) {
        let Some(frame) = GroupFrame::parse(value) else {
            return;
        };
        let known: BTreeSet<String> = self.contacts.keys().map(ToString::to_string).collect();
        let Some(groups) = self.groups.as_mut() else {
            return;
        };
        let result = groups.handle(
            peer.as_str(),
            &frame,
            &Who {
                known: &known,
                trusted: None,
            },
        );
        let _ = self.finish_group_result(result);
    }

    pub fn create_group(&mut self, name: &str, members: &[UserId]) -> Result<String, ErrorCode> {
        self.require_live()?;
        let cards = members
            .iter()
            .map(|u| self.card_of(u))
            .collect::<Result<Vec<_>, _>>()?;
        let now = self.now();
        let (Some(groups), Some(id)) = (self.groups.as_mut(), self.identity.as_ref()) else {
            return Err(ErrorCode::NoIdentity);
        };
        let (group_id, result) = groups
            .create_group(id, name, &cards, now)
            .map_err(|e| Self::group_error(&e))?;
        self.finish_group_result(result)?;
        Ok(group_id)
    }

    pub fn add_group_member(&mut self, group_id: &str, uid: &UserId) -> Result<(), ErrorCode> {
        self.require_live()?;
        let card = self.card_of(uid)?;
        let now = self.now();
        let (Some(groups), Some(id)) = (self.groups.as_mut(), self.identity.as_ref()) else {
            return Err(ErrorCode::NoIdentity);
        };
        let result = groups
            .add_member(id, group_id, &card, now)
            .map_err(|e| Self::group_error(&e))?;
        self.finish_group_result(result)
    }

    pub fn remove_group_member(&mut self, group_id: &str, uid: &UserId) -> Result<(), ErrorCode> {
        self.require_live()?;
        let now = self.now();
        let (Some(groups), Some(id)) = (self.groups.as_mut(), self.identity.as_ref()) else {
            return Err(ErrorCode::NoIdentity);
        };
        let result = groups
            .remove_member(id, group_id, uid.as_str(), now)
            .map_err(|e| Self::group_error(&e))?;
        self.finish_group_result(result)
    }

    pub fn leave_group(&mut self, group_id: &str) -> Result<(), ErrorCode> {
        self.require_live()?;
        let now = self.now();
        let (Some(groups), Some(id)) = (self.groups.as_mut(), self.identity.as_ref()) else {
            return Err(ErrorCode::NoIdentity);
        };
        let result = groups
            .leave(id, group_id, now)
            .map_err(|e| Self::group_error(&e))?;
        self.finish_group_result(result)
    }

    pub fn rename_group(&mut self, group_id: &str, name: &str) -> Result<(), ErrorCode> {
        self.require_live()?;
        let now = self.now();
        let (Some(groups), Some(id)) = (self.groups.as_mut(), self.identity.as_ref()) else {
            return Err(ErrorCode::NoIdentity);
        };
        let result = groups
            .rename(id, group_id, name, now)
            .map_err(|e| Self::group_error(&e))?;
        self.finish_group_result(result)
    }

    /// Write to a group: stored once, with one outbox entry per other member, each sent when that member's link is up.
    pub fn send_group_message(
        &mut self,
        group_id: &str,
        text: &str,
        reply_to: Option<&MessageId>,
    ) -> Result<MessageId, ErrorCode> {
        self.require_live()?;
        let own = self.uid.clone().ok_or(ErrorCode::NoIdentity)?;
        let groups = self.groups.as_ref().ok_or(ErrorCode::NoIdentity)?;
        if !groups.is_member(group_id, own.as_str()) {
            return Err(ErrorCode::NoSuchGroup);
        }
        let recipients: Vec<UserId> = groups
            .recipients(group_id)
            .iter()
            .filter_map(|u| UserId::new(u.as_str()).ok())
            .collect();
        let gid = GroupId::new(group_id).map_err(|_| ErrorCode::NoSuchGroup)?;
        let reply = match reply_to {
            None => None,
            Some(id) => {
                let m = self.messages.get(id).ok_or(ErrorCode::UnknownMessage)?;
                Some(ReplyRef::quoting(
                    &m.message.message_id,
                    &m.message.sender_id,
                    &m.message.text,
                ))
            }
        };
        let id = self.new_message_id()?;
        let now = self.now();
        let message =
            ChatMessage::outgoing(own, text, now, id.clone(), reply).map_err(|e| match e {
                privcord_domain::DomainError::EmptyMessage => ErrorCode::EmptyMessage,
                _ => ErrorCode::MessageTooLong,
            })?;
        let conversation = ConversationId::Group(gid);
        let row = StoredMessage {
            conversation: conversation.clone(),
            message,
        };
        let entries: Vec<OutboxEntry> = recipients
            .iter()
            .map(|r| OutboxEntry {
                message_id: id.clone(),
                recipient: r.clone(),
                attempts: 0,
                next_try_ms: now,
            })
            .collect();
        let mut ops = vec![StorageOp::InsertMessage(row.clone())];
        ops.extend(entries.iter().cloned().map(StorageOp::PutOutbox));
        self.ports.storage.apply(&ops)?;
        self.messages.insert(id.clone(), row);
        self.outbox.extend(entries);
        self.hub.publish(EngineEvent::MessageAdded {
            conversation,
            message_id: id.clone(),
            own: true,
        });
        for r in &recipients {
            self.flush(r);
        }
        Ok(id)
    }

    fn on_group_message(&mut self, peer: &UserId, value: &Value) {
        let Some(GroupFrame::Message(m)) = GroupFrame::parse(value) else {
            return;
        };
        let Some(groups) = self.groups.as_ref() else {
            return;
        };
        match groups.check_message(peer.as_str(), &m.group_id) {
            MessageVerdict::Ok => {}
            MessageVerdict::UnknownGroup => {
                // The group's history may be a moment behind the message: hold it. A full buffer drops it, and with no
                // acknowledgement the sender sends it again.
                let now = self.now();
                self.pending_group
                    .hold(&m.group_id, peer.as_str(), value.clone(), now);
                return;
            }
            MessageVerdict::NotMember => return,
        }
        let Ok(gid) = GroupId::new(m.group_id.as_str()) else {
            return;
        };
        let ack = |core: &mut Self, id: &MessageId| {
            let at = core.now();
            core.send_ack(peer, id, at);
        };
        if self.messages.contains_key(&m.message_id) {
            ack(self, &m.message_id);
            return;
        }
        let message = ChatMessage {
            message_id: m.message_id.clone(),
            client_message_id: m.message_id.clone(),
            sender_id: peer.clone(),
            text: m.text,
            client_created_at: m.client_created_at,
            kind: privcord_domain::message::MessageKind::Text,
            transport: self.inbound_transport(),
            delivery_state: DeliveryState::Delivered,
            reply_to: m.reply_to,
            read_at: None,
        };
        let conversation = ConversationId::Group(gid);
        let row = StoredMessage {
            conversation: conversation.clone(),
            message: message.clone(),
        };
        if self
            .ports
            .storage
            .apply(&[StorageOp::InsertMessage(row.clone())])
            .is_err()
        {
            return;
        }
        self.messages.insert(message.message_id.clone(), row);
        self.hub.publish(EngineEvent::MessageAdded {
            conversation: conversation.clone(),
            message_id: message.message_id.clone(),
            own: false,
        });
        self.ports.notifier.notify(Notification::MessageReceived {
            conversation,
            sender: peer.clone(),
            preview: message.text.chars().take(80).collect(),
        });
        ack(self, &message.message_id);
    }

    /* ---------------------------------------------------------------- files */

    /// Keep a file message and its bytes together with one outbox entry per recipient, then try to send.
    fn queue_file(
        &mut self,
        conversation: ConversationId,
        recipients: Vec<UserId>,
        name: &str,
        mime: &str,
        bytes: Vec<u8>,
        reply_to: Option<&MessageId>,
    ) -> Result<MessageId, ErrorCode> {
        let own = self.uid.clone().ok_or(ErrorCode::NoIdentity)?;
        let reply = match reply_to {
            None => None,
            Some(id) => {
                let m = self.messages.get(id).ok_or(ErrorCode::UnknownMessage)?;
                Some(ReplyRef::quoting(
                    &m.message.message_id,
                    &m.message.sender_id,
                    &m.message.text,
                ))
            }
        };
        let id = self.new_message_id()?;
        let now = self.now();
        let offer = FileOffer::make(id.clone(), None, name, mime, &bytes, now, reply.clone())
            .map_err(|_| ErrorCode::BadFile)?;
        let message = ChatMessage {
            message_id: id.clone(),
            client_message_id: id.clone(),
            sender_id: own,
            // As in the apps, a file message's text is its (cleaned) name.
            text: offer.name.clone(),
            client_created_at: now,
            kind: MessageKind::File,
            transport: TransportKind::P2p,
            delivery_state: DeliveryState::Queued,
            reply_to: reply,
            read_at: None,
        };
        let row = StoredMessage {
            conversation: conversation.clone(),
            message,
        };
        let entries: Vec<OutboxEntry> = recipients
            .iter()
            .map(|r| OutboxEntry {
                message_id: id.clone(),
                recipient: r.clone(),
                attempts: 0,
                next_try_ms: now,
            })
            .collect();
        let mut ops = vec![
            StorageOp::InsertMessage(row.clone()),
            StorageOp::PutFile(StoredFile {
                message_id: id.clone(),
                name: offer.name,
                mime: offer.mime,
                bytes,
            }),
        ];
        ops.extend(entries.iter().cloned().map(StorageOp::PutOutbox));
        self.ports.storage.apply(&ops)?;
        self.messages.insert(id.clone(), row);
        self.outbox.extend(entries);
        self.hub.publish(EngineEvent::MessageAdded {
            conversation,
            message_id: id.clone(),
            own: true,
        });
        for r in &recipients {
            self.flush(r);
        }
        Ok(id)
    }

    /// Send a file (at most 8 MB) to one person.
    pub fn send_file(
        &mut self,
        peer: &UserId,
        name: &str,
        mime: &str,
        bytes: Vec<u8>,
        reply_to: Option<&MessageId>,
    ) -> Result<MessageId, ErrorCode> {
        self.require_live()?;
        if !self.contacts.contains_key(peer) {
            return Err(ErrorCode::UnknownContact);
        }
        if !self.may_start_direct(peer) {
            return Err(ErrorCode::DirectNotAllowed);
        }
        self.queue_file(
            ConversationId::Direct(peer.clone()),
            vec![peer.clone()],
            name,
            mime,
            bytes,
            reply_to,
        )
    }

    /// Send a file to every other member of a group.
    pub fn send_group_file(
        &mut self,
        group_id: &str,
        name: &str,
        mime: &str,
        bytes: Vec<u8>,
        reply_to: Option<&MessageId>,
    ) -> Result<MessageId, ErrorCode> {
        self.require_live()?;
        let own = self.uid.clone().ok_or(ErrorCode::NoIdentity)?;
        let groups = self.groups.as_ref().ok_or(ErrorCode::NoIdentity)?;
        if !groups.is_member(group_id, own.as_str()) {
            return Err(ErrorCode::NoSuchGroup);
        }
        let recipients = groups
            .recipients(group_id)
            .iter()
            .filter_map(|u| UserId::new(u.as_str()).ok())
            .collect();
        let gid = GroupId::new(group_id).map_err(|_| ErrorCode::NoSuchGroup)?;
        self.queue_file(
            ConversationId::Group(gid),
            recipients,
            name,
            mime,
            bytes,
            reply_to,
        )
    }

    /// The bytes of a stored file message.
    pub fn file(&self, id: &MessageId) -> Result<Option<StoredFile>, ErrorCode> {
        Ok(self.ports.storage.file(id)?)
    }

    fn decline(&mut self, peer: &UserId, id: &MessageId, reason: DeclineReason) {
        self.send_secure(peer, &declined_frame(id, reason));
    }

    fn on_file_offer(&mut self, peer: &UserId, frame: &Value) {
        let Some(offer) = FileOffer::from_frame(frame) else {
            return;
        };
        let id = offer.message_id.clone();
        match &offer.group_id {
            None => {
                let trust = self
                    .contacts
                    .get(peer)
                    .map_or(ContactTrust::Introduced, |c| c.stored.trust);
                if !accepts_direct(trust, self.group_only) {
                    self.decline(peer, &id, DeclineReason::DirectNotAccepted);
                    return;
                }
            }
            Some(g) => {
                let ok = self
                    .groups
                    .as_ref()
                    .is_some_and(|c| c.check_message(peer.as_str(), g) == MessageVerdict::Ok);
                if !ok {
                    return;
                }
            }
        }
        // Already have it (a retry): acknowledge again and store nothing.
        if self.messages.contains_key(&id) {
            let at = self.now();
            self.send_secure(peer, &json!({ "v": PROTOCOL_VERSION, "kind": "ack", "messageId": id, "state": "DELIVERED", "at": at }));
            return;
        }
        let outcome = self
            .peers
            .get_mut(peer)
            .map(|p| p.files.begin(offer))
            .unwrap_or(BeginOutcome::Busy);
        match outcome {
            BeginOutcome::Ok => {}
            BeginOutcome::TooLarge => self.decline(peer, &id, DeclineReason::TooLarge),
            BeginOutcome::Busy => self.decline(peer, &id, DeclineReason::Busy),
        }
    }

    fn on_file_chunk(&mut self, peer: &UserId, frame: &Value) {
        let Some(chunk) = FileChunk::from_frame(frame) else {
            return;
        };
        let id = chunk.message_id.clone();
        let result = match self.peers.get_mut(peer) {
            Some(p) => p.files.chunk(&chunk),
            None => return,
        };
        match result {
            AssembleResult::More => {}
            AssembleResult::Failed(reason) => self.decline(peer, &id, reason),
            AssembleResult::Done { offer, bytes } => self.store_received_file(peer, *offer, bytes),
        }
    }

    fn store_received_file(&mut self, peer: &UserId, offer: FileOffer, bytes: Vec<u8>) {
        let conversation = match &offer.group_id {
            None => ConversationId::Direct(peer.clone()),
            Some(g) => match GroupId::new(g.as_str()) {
                Ok(g) => ConversationId::Group(g),
                Err(_) => return,
            },
        };
        let message = ChatMessage {
            message_id: offer.message_id.clone(),
            client_message_id: offer.message_id.clone(),
            sender_id: peer.clone(),
            text: offer.name.clone(),
            client_created_at: offer.client_created_at,
            kind: MessageKind::File,
            transport: TransportKind::P2p,
            delivery_state: DeliveryState::Delivered,
            reply_to: offer.reply_to.clone(),
            read_at: None,
        };
        let row = StoredMessage {
            conversation: conversation.clone(),
            message: message.clone(),
        };
        let ops = [
            StorageOp::InsertMessage(row.clone()),
            StorageOp::PutFile(StoredFile {
                message_id: offer.message_id.clone(),
                name: offer.name.clone(),
                mime: offer.mime,
                bytes,
            }),
        ];
        // Not stored, so not acknowledged: the sender will send it again.
        if self.ports.storage.apply(&ops).is_err() {
            return;
        }
        self.messages.insert(message.message_id.clone(), row);
        self.hub.publish(EngineEvent::MessageAdded {
            conversation: conversation.clone(),
            message_id: message.message_id.clone(),
            own: false,
        });
        self.ports.notifier.notify(Notification::MessageReceived {
            conversation,
            sender: peer.clone(),
            preview: privcord_domain::files::file_preview_text(&offer.name),
        });
        let at = self.now();
        self.send_secure(peer, &json!({ "v": PROTOCOL_VERSION, "kind": "ack", "messageId": message.message_id, "state": "DELIVERED", "at": at }));
    }

    /* ---------------------------------------------------------------- channels and the mesh */

    fn persist_channels(&mut self) -> Result<(), ErrorCode> {
        let names: Vec<&String> = self.channels.keys().collect();
        let value = serde_json::to_vec(&names).map_err(|_| ErrorCode::Storage)?;
        self.ports.storage.apply(&[StorageOp::SetKv {
            key: KV_CHANNELS.into(),
            value,
        }])?;
        Ok(())
    }

    /// Join a public channel by name ("#General Chat" becomes "general-chat"). Returns the normalised name.
    pub fn join_channel(&mut self, raw: &str) -> Result<String, ErrorCode> {
        self.require_live()?;
        let name = normalize_channel_name(raw).ok_or(ErrorCode::BadChannel)?;
        if self.channels.contains_key(&name) {
            return Ok(name);
        }
        self.channels.insert(name.clone(), derive_channel(&name)?);
        if let Err(e) = self.persist_channels() {
            self.channels.remove(&name);
            return Err(e);
        }
        Ok(name)
    }

    /// Stop listening to a channel. Its saved messages stay.
    pub fn leave_channel(&mut self, raw: &str) -> Result<(), ErrorCode> {
        self.require_live()?;
        let name = normalize_channel_name(raw).ok_or(ErrorCode::BadChannel)?;
        if let Some(keys) = self.channels.remove(&name) {
            if let Err(e) = self.persist_channels() {
                self.channels.insert(name, keys);
                return Err(e);
            }
        }
        Ok(())
    }

    /// Write to a channel you joined: sealed, signed, stored and flooded over the mesh to every neighbour (and carried
    /// for neighbours that arrive later). Nobody is told it arrived: a channel is a broadcast.
    pub fn send_channel_message(&mut self, raw: &str, text: &str) -> Result<MessageId, ErrorCode> {
        self.require_live()?;
        let own = self.uid.clone().ok_or(ErrorCode::NoIdentity)?;
        let name = normalize_channel_name(raw).ok_or(ErrorCode::BadChannel)?;
        let now = self.now();
        let (Some(keys), Some(identity)) = (self.channels.get(&name), self.identity.as_ref())
        else {
            return Err(ErrorCode::NotJoined);
        };
        let blob = seal_channel_message(keys, identity, None, text, now, &mut *self.ports.entropy)
            .map_err(|e| match e {
                CryptoError::EmptyMessage => ErrorCode::EmptyMessage,
                other => ErrorCode::from(other),
            })?;
        let id = MessageId::new(privcord_domain::mesh::packet_id(&blob))
            .map_err(|_| ErrorCode::Crypto)?;
        let text: String = privcord_domain::text::js_trim(text)
            .chars()
            .take(privcord_domain::limits::MAX_CHANNEL_TEXT)
            .collect();
        let conversation = ConversationId::Channel(name);
        let row = StoredMessage {
            conversation: conversation.clone(),
            message: ChatMessage {
                message_id: id.clone(),
                client_message_id: id.clone(),
                sender_id: own,
                text,
                client_created_at: now,
                kind: MessageKind::Text,
                transport: TransportKind::P2p,
                delivery_state: DeliveryState::Sent,
                reply_to: None,
                read_at: None,
            },
        };
        self.ports
            .storage
            .apply(&[StorageOp::InsertMessage(row.clone())])?;
        self.messages.insert(id.clone(), row);
        self.hub.publish(EngineEvent::MessageAdded {
            conversation,
            message_id: id.clone(),
            own: true,
        });
        let out = self.mesh.inject(blob, u64::try_from(now).unwrap_or(0));
        self.mesh_send(out);
        Ok(id)
    }

    fn mesh_send(&mut self, outgoing: Vec<MeshOutgoing>) {
        for o in outgoing {
            let Ok(text) = serde_json::to_string(&o.packet) else {
                continue;
            };
            if self.ports.transport.send_raw(&o.link, &text).is_err() {
                // The radio refused: treat the link as gone so the next link-up hands everything over again.
                self.mesh.link_down(&o.link);
            }
        }
    }

    /// The radio found a mesh neighbour. It is handed everything we carry that it has not seen.
    pub fn mesh_link_up(&mut self, link: &str) -> Result<(), ErrorCode> {
        self.require_live()?;
        let now = u64::try_from(self.now()).unwrap_or(0);
        let out = self.mesh.link_up(link, now);
        self.mesh_send(out);
        Ok(())
    }

    pub fn mesh_link_down(&mut self, link: &str) {
        self.mesh.link_down(link);
    }

    /// A packet came from a mesh neighbour. Garbage, oversize, repeats and flooding are dropped; the rest is passed
    /// on, and kept here if it is for a channel we joined.
    pub fn mesh_frame(&mut self, link: &str, text: &str) {
        if self.shut_down || text.len() > MAX_FRAME_BYTES {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            return;
        };
        let now = u64::try_from(self.now()).unwrap_or(0);
        let result = self.mesh.handle(&value, link, now);
        self.mesh_send(result.forward);
        let Some(blob) = result.accepted else {
            return;
        };
        let Ok(blob_value) = serde_json::to_value(&blob) else {
            return;
        };
        let opened = self
            .channels
            .values()
            .find(|k| k.tag == blob.to)
            .and_then(|k| open_channel_message(k, &blob_value));
        let Some(m) = opened else {
            return;
        };
        let Ok(id) = MessageId::new(privcord_domain::mesh::packet_id(&blob)) else {
            return;
        };
        if self.messages.contains_key(&id) || Some(&m.contact.uid) == self.uid.as_ref() {
            return;
        }
        let conversation = ConversationId::Channel(m.channel.clone());
        let row = StoredMessage {
            conversation: conversation.clone(),
            message: ChatMessage {
                message_id: id.clone(),
                client_message_id: id.clone(),
                sender_id: m.contact.uid.clone(),
                text: m.text.clone(),
                client_created_at: m.at,
                kind: MessageKind::Text,
                transport: TransportKind::P2p,
                delivery_state: DeliveryState::Delivered,
                reply_to: None,
                read_at: None,
            },
        };
        if self
            .ports
            .storage
            .apply(&[StorageOp::InsertMessage(row.clone())])
            .is_err()
        {
            return;
        }
        self.messages.insert(id.clone(), row);
        self.hub.publish(EngineEvent::MessageAdded {
            conversation: conversation.clone(),
            message_id: id,
            own: false,
        });
        self.ports.notifier.notify(Notification::MessageReceived {
            conversation,
            sender: m.contact.uid,
            preview: m.text.chars().take(80).collect(),
        });
    }

    /* ---------------------------------------------------------------- state */

    pub fn snapshot(&self) -> Snapshot {
        let own = self.identity.as_ref();
        let contacts = self
            .contacts
            .values()
            .map(|c| ContactView {
                uid: c.stored.uid.clone(),
                name: c.stored.name.clone(),
                display_name: c
                    .stored
                    .name
                    .clone()
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| {
                        format!(
                            "Friend {}",
                            c.stored.uid.as_str().chars().take(8).collect::<String>()
                        )
                    }),
                introduced_by: c.stored.introduced_by.clone(),
                trust: c.stored.trust,
                checked: c.stored.checked,
                safety_number: own
                    .and_then(|i| derive_safety_number(&i.sign_public(), &c.contact.card.sign).ok())
                    .unwrap_or_default(),
                connection: self
                    .peers
                    .get(&c.stored.uid)
                    .map_or(ConnectionState::Offline, |p| p.state),
                can_message: self.may_start_direct(&c.stored.uid),
            })
            .collect();
        let mut by_conv: BTreeMap<ConversationId, Vec<ChatMessage>> = BTreeMap::new();
        for m in self.messages.values() {
            by_conv
                .entry(m.conversation.clone())
                .or_default()
                .push(m.message.clone());
        }
        let messages = by_conv
            .into_iter()
            .map(|(c, mut v)| {
                sort_messages(&mut v);
                (c, v)
            })
            .collect();
        let groups = self.groups.as_ref().map_or_else(Vec::new, |g| {
            g.my_groups()
                .into_iter()
                .map(|s| GroupView {
                    am_admin: self
                        .uid
                        .as_ref()
                        .and_then(|u| s.members.get(u.as_str()))
                        .is_some_and(|m| m.role == Role::Admin),
                    full: s.members.len() >= privcord_domain::limits::MAX_GROUP_MEMBERS,
                    max_members: privcord_domain::limits::MAX_GROUP_MEMBERS,
                    connected: s
                        .members
                        .keys()
                        .filter(|u| Some(u.as_str()) != self.uid.as_ref().map(UserId::as_str))
                        .filter(|u| {
                            UserId::new(u.as_str()).is_ok_and(|u| {
                                matches!(
                                    self.peers.get(&u).map(|p| p.state),
                                    Some(ConnectionState::Connected { .. })
                                )
                            })
                        })
                        .count(),
                    group_id: s.group_id.clone(),
                    name: s.name.clone(),
                    created_by: s.created_by.clone(),
                    members: s
                        .members
                        .values()
                        .map(|m| (m.uid.clone(), m.role == Role::Admin))
                        .collect(),
                })
                .collect()
        });
        let (invite, requests, answer, lookup_pending) = self.invite_views();
        let (summaries, deliveries) = self.summaries();
        Snapshot {
            seq: self.hub.seq(),
            own_uid: self.uid.clone(),
            contacts,
            groups,
            summaries,
            deliveries,
            channels: self.channels.keys().cloned().collect(),
            reactions: self.reaction_views(),
            deleted: self.deleted.iter().cloned().collect(),
            muted: self.muted.iter().cloned().collect(),
            invite,
            requests,
            answer,
            lookup_pending,
            messages,
            queued: self.outbox.len(),
        }
    }

    /// Stop accepting work and end every session. Durable state was written as it changed, so there is nothing to flush.
    pub fn shutdown(&mut self) {
        if self.shut_down {
            return;
        }
        self.shut_down = true;
        for p in self.peers.values_mut() {
            p.session = None;
        }
        self.hub.publish(EngineEvent::ShutDown);
    }
}
