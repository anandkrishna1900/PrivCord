//! The engine's state machine. Synchronous and deterministic: every input is a method call, every effect goes out
//! through a port. The async runtime in `runtime.rs` is only a thin shell around this, which is what makes the rules
//! testable without threads, sockets or sleeps.
//!
//! Responsibilities (the PRD's services, kept as separate sections rather than one giant type):
//! identity, contacts and trust, peer lifecycle and authentication, messaging, delivery (outbox and retries),
//! state snapshots and events.

use crate::{
    api::{ContactView, EngineEvent, Snapshot},
    error::ErrorCode,
    events::{EventHub, EventStream},
};
use privcord_crypto::{
    card::{Contact, ContactCard},
    identity::{Identity, StoredSecrets},
    rng::Entropy,
    safety::derive_safety_number,
    secure_channel::{Data, Hello, SecureChannel},
    CryptoError,
};
use privcord_domain::{
    limits::PROTOCOL_VERSION,
    message::{
        declined_frame, parse_declined_frame, ChatMessage, DeclineReason, DeliveryState, ReplyRef,
    },
    ordering::sort_messages,
    privacy::{accepts_direct, can_start_direct, ContactTrust},
    state::{ConnectionEvent, ConnectionFailure, ConnectionPath, ConnectionState},
    ConversationId, MessageId, UserId,
};
use privcord_ports::{
    Clock, Notification, Notifier, OutboxEntry, SecureStore, Storage, StorageOp, StoredContact,
    StoredMessage, Transport,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};
use zeroize::Zeroizing;

/// A frame larger than this is dropped before it is parsed (SEC-04, SEC-09).
pub const MAX_FRAME_BYTES: usize = 128 * 1024;
/// How long to wait for a delivery receipt before sending a message again.
pub const RETRY_AFTER_MS: i64 = 20_000;
/// How long a hello that arrived early stays valid.
const EARLY_HELLO_MS: i64 = 10_000;
const KV_GROUP_ONLY: &str = "settings.group_only";

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

struct Peer {
    state: ConnectionState,
    channel: Option<SecureChannel>,
    path: ConnectionPath,
    /// Their "stay group-only" choice, once they have told us.
    group_only: Option<bool>,
    /// Their hello, if it arrived a moment before the adapter told us the link was up (and when).
    early_hello: Option<(Hello, i64)>,
}

impl Peer {
    fn offline() -> Self {
        Self {
            state: ConnectionState::Offline,
            channel: None,
            path: ConnectionPath::Unknown,
            group_only: None,
            early_hello: None,
        }
    }
    fn ready(&self) -> bool {
        self.channel.as_ref().is_some_and(SecureChannel::ready)
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
        for stored in core.ports.storage.contacts()? {
            if let Some(contact) = ContactCard::decode(&stored.card).filter(|c| c.uid == stored.uid)
            {
                core.contacts
                    .insert(stored.uid.clone(), StoredContactState { stored, contact });
            }
        }
        for m in core.ports.storage.messages()? {
            core.messages.insert(m.message.message_id.clone(), m);
        }
        core.outbox = core.ports.storage.outbox()?;
        core.group_only = core
            .ports
            .storage
            .kv(KV_GROUP_ONLY)?
            .is_some_and(|v| v == b"1");
        core.hub.publish(EngineEvent::Ready);
        Ok(core)
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
            introduced_by: None,
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

    /// A link to a known contact is up (the adapter reports it). The engine authenticates it before trusting it.
    pub fn link_up(&mut self, peer: &UserId, path: ConnectionPath) -> Result<(), ErrorCode> {
        self.require_live()?;
        let own = self.uid.clone().ok_or(ErrorCode::NoIdentity)?;
        let sign = self
            .contacts
            .get(peer)
            .ok_or(ErrorCode::UnknownContact)?
            .contact
            .card
            .sign
            .clone();
        // A new link replaces any older state for this person.
        if self
            .peers
            .get(peer)
            .is_some_and(|p| p.state != ConnectionState::Offline)
        {
            self.link_down(peer);
        }
        let channel =
            SecureChannel::new(own.as_str(), peer.as_str(), sign, &mut *self.ports.entropy)?;
        let hello = channel.hello(self.identity()?)?;
        {
            let p = self.peers.entry(peer.clone()).or_insert_with(Peer::offline);
            p.channel = Some(channel);
            p.path = path;
        }
        self.step(peer, ConnectionEvent::Dial);
        // The handshake travels in the clear by design: it is signed, and carries only a fresh key and a nonce.
        if self
            .ports
            .transport
            .send(peer, &hello.to_value().to_string())
            .is_err()
        {
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
            self.handshake_frame(peer, &hello.to_value());
        }
        Ok(())
    }

    /// The adapter lost the link. Identity and message state are untouched; only the session ends.
    pub fn link_down(&mut self, peer: &UserId) {
        if let Some(p) = self.peers.get_mut(peer) {
            p.channel = None;
            p.early_hello = None;
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
            p.channel = None;
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
        if self.peers.get(peer).is_none_or(|p| p.channel.is_none()) {
            if let Some(hello) = Hello::from_value(&value) {
                let now = self.now();
                self.peers
                    .entry(peer.clone())
                    .or_insert_with(Peer::offline)
                    .early_hello = Some((hello, now));
            }
            return;
        }
        let ready = self.peers.get(peer).is_some_and(Peer::ready);
        if !ready {
            self.handshake_frame(peer, &value);
            return;
        }
        let Some(data) = Data::from_value(&value) else {
            return;
        };
        let inner = match self
            .peers
            .get_mut(peer)
            .and_then(|p| p.channel.as_mut())
            .map(|c| c.decrypt(&data))
        {
            Some(Ok(v)) => v,
            _ => return,
        };
        self.dispatch(peer, &inner);
    }

    fn handshake_frame(&mut self, peer: &UserId, value: &Value) {
        let Some(hello) = Hello::from_value(value) else {
            return;
        };
        let accepted = self
            .peers
            .get_mut(peer)
            .and_then(|p| p.channel.as_mut())
            .map(|c| c.accept(&hello));
        match accepted {
            Some(Ok(())) => {
                let path = self
                    .peers
                    .get(peer)
                    .map_or(ConnectionPath::Unknown, |p| p.path);
                self.step(peer, ConnectionEvent::Established(path));
                self.send_privacy(peer);
                self.flush(peer);
            }
            Some(Err(_)) => self.fail(peer, ConnectionFailure::AuthenticationFailed),
            None => {}
        }
    }

    /// Encrypt and send one inner frame. A transport that refuses ends the session (it will be re-established).
    fn send_secure(&mut self, peer: &UserId, frame: &Value) -> bool {
        let Some(channel) = self
            .peers
            .get_mut(peer)
            .and_then(|p| p.channel.as_mut())
            .filter(|c| c.ready())
        else {
            return false;
        };
        let Ok(data) = channel.encrypt(frame) else {
            return false;
        };
        if self
            .ports
            .transport
            .send(peer, &data.to_value().to_string())
            .is_err()
        {
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
            core.send_secure(peer, &json!({ "v": PROTOCOL_VERSION, "kind": "ack", "messageId": id, "state": "DELIVERED", "at": at }));
        };
        // Receiving twice is harmless: acknowledge again, store nothing.
        if self.messages.contains_key(&message.message_id) {
            let id = message.message_id.clone();
            ack(self, &id);
            return;
        }
        message.delivery_state = DeliveryState::Delivered;
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
        let ours = self.messages.get(&id).is_some_and(|m| {
            m.conversation == ConversationId::Direct(peer.clone())
                && Some(&m.message.sender_id) == self.uid.as_ref()
        });
        if !ours {
            return;
        }
        let Some(current) = self.messages.get(&id).map(|m| m.message.delivery_state) else {
            return;
        };
        let next = DeliveryState::highest(current, state);
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
        let ours = self
            .messages
            .get(&id)
            .is_some_and(|m| m.conversation == ConversationId::Direct(peer.clone()));
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
            let frame = row.message.to_peer_frame();
            let was_queued = row.message.delivery_state == DeliveryState::Queued;
            if !self.send_secure(peer, &frame) {
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

    /// Time passes: resend what was never acknowledged.
    pub fn tick(&mut self) {
        if self.shut_down {
            return;
        }
        let peers: Vec<UserId> = self
            .peers
            .iter()
            .filter(|(_, p)| p.ready())
            .map(|(u, _)| u.clone())
            .collect();
        for p in peers {
            self.flush(&p);
        }
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
        Snapshot {
            seq: self.hub.seq(),
            own_uid: self.uid.clone(),
            contacts,
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
            p.channel = None;
        }
        self.hub.publish(EngineEvent::ShutDown);
    }
}
