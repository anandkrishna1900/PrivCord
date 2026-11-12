//! Sealed messages between contacts over the signaling services, and over mutual contacts when there is no internet
//! (`engine.ts` "signaling" and "store-and-forward").
//!
//! A sealed message is encrypted to one contact and signed by us (`crypto::seal`). Three kinds of payload travel this way:
//! connection setup (`ready`, `offer`, `answer`: handed to the platform's WebRTC code through events), messages for a
//! friend who is offline (`msg`, kept on the relay only when the person turned store-and-forward on), and their receipts
//! (`ack`). Without any service, a sealed blob can be handed to up to two connected contacts, who pass it on to its
//! addressee (`relay_blob`, at most two hops).

use super::{Core, StorageOp};
use crate::{
    api::{EngineEvent, SignalMessage},
    error::ErrorCode,
};
use privcord_crypto::{group_coordinator::GroupFrame, seal::mailbox_for};
use privcord_domain::{
    blob::SealedBlob,
    link_policy::is_initiator,
    message::{DeliveryState, MessageKind},
    signaling::{PutKind, SeenSet},
    ConversationId, MessageId, UserId,
};
use serde_json::{json, Value};
use std::collections::HashSet;

const RELAY_TTL_SEC: u32 = 7 * 24 * 3600;
const LIVE_TTL_SEC: u32 = 120;
/// How often a group message for a member we have no link to is handed again to the members we do have links to.
const MESH_RETRY_MS: i64 = 15_000;
/// A direct link gets this long to come up (the dial starts the moment the message is sent) before the message is also
/// handed to other members to pass on.
const MESH_AFTER_MS: i64 = 10_000;
/// Rounds of passing a message on before giving up on that route (direct delivery keeps retrying as always): about five
/// minutes for text, three tries for a file (each is the whole file again, through other people's links).
const MESH_MAX_ROUNDS_TEXT: u32 = 20;
const MESH_MAX_ROUNDS_FILE: u32 = 3;

#[derive(Default)]
pub(super) struct SealedState {
    subscribed: bool,
    /// (message, recipient) pairs already handed to a signaling service.
    relayed: HashSet<(MessageId, UserId)>,
    /// (message, member) pairs handed to other members to pass on, and when.
    /// (message, member) pairs handed to other members to pass on: when last, and how many rounds so far.
    meshed: std::collections::HashMap<(MessageId, UserId), (i64, u32)>,
    seen: SeenSet,
}

impl Core {
    pub(super) fn inbound_transport(&self) -> privcord_domain::message::TransportKind {
        if self.relay_inbound {
            privcord_domain::message::TransportKind::Relay
        } else {
            privcord_domain::message::TransportKind::P2p
        }
    }

    /// Acknowledge a delivered message: over the link if it came over the link, sealed through the service if not.
    pub(super) fn send_ack(&mut self, peer: &UserId, id: &MessageId, at: i64) {
        if self.relay_inbound {
            let _ = self.put_sealed(
                peer,
                &json!({ "t": "ack", "id": id }),
                PutKind::Msg,
                RELAY_TTL_SEC,
            );
        } else {
            self.send_secure(
                peer,
                &json!({ "v": privcord_domain::limits::PROTOCOL_VERSION, "kind": "ack", "messageId": id, "state": "DELIVERED", "at": at }),
            );
        }
    }

    pub(super) fn seal_to(
        &mut self,
        peer: &UserId,
        payload: &Value,
    ) -> Result<SealedBlob, ErrorCode> {
        let dh = self
            .contacts
            .get(peer)
            .ok_or(ErrorCode::UnknownContact)?
            .contact
            .card
            .dh
            .clone();
        // v2 to one of their keys once we have them; v1 only before the first link (see core::keys).
        self.seal_for(peer, payload, &dh)
    }

    /// Seal `payload` to a contact and send it: through signaling if it is up, else (for live signaling only) through
    /// mutual contacts.
    fn put_sealed(
        &mut self,
        peer: &UserId,
        payload: &Value,
        kind: PutKind,
        ttl_sec: u32,
    ) -> Result<(), ErrorCode> {
        let blob = self.seal_to(peer, payload)?;
        let mailbox = mailbox_for(peer.as_str());
        let sent = self.ports.transport.signal_available()
            && self
                .ports
                .transport
                .signal_put(&mailbox, &blob.encode(), kind, ttl_sec)
                .is_ok();
        // Connection setup and receipts can also go through mutual contacts; messages do that only on purpose
        // (`tick_group_mesh`), never as a side effect of the service being down.
        let small =
            matches!(kind, PutKind::Sig) || payload.get("t").and_then(Value::as_str) == Some("ack");
        if sent || (small && self.forward_via(peer, &blob)) {
            Ok(())
        } else {
            Err(ErrorCode::NoRoute)
        }
    }

    /// Ask up to two connected contacts to hand a sealed blob to `to` (signaling without the internet).
    fn forward_via(&mut self, to: &UserId, blob: &SealedBlob) -> bool {
        let candidates: Vec<UserId> = self
            .peers
            .iter()
            .filter(|(u, p)| *u != to && p.ready())
            .map(|(u, _)| u.clone())
            .collect();
        let frame = GroupFrame::RelayBlob {
            blob: Box::new(blob.clone()),
            hops: 1,
        }
        .to_value();
        let mut n = 0;
        for c in candidates {
            if self.send_secure(&c, &frame) {
                n += 1;
            }
            if n >= 2 {
                break;
            }
        }
        n > 0
    }

    /// Tell a contact how to reach us (`ready`), or hand over a connection offer or answer. The platform makes the
    /// session description; the engine seals it and finds a way to deliver it.
    pub fn send_signal(&mut self, peer: &UserId, message: &SignalMessage) -> Result<(), ErrorCode> {
        self.require_live()?;
        let now = self.now();
        let payload = match message {
            SignalMessage::Ready => json!({ "t": "ready" }),
            SignalMessage::Offer(sdp) => {
                // Each offer gets an id; the answer echoes it, so an answer to an older offer (replayed by a relay, or
                // crossing a newer one) is never applied to the connection we are opening now.
                let mut raw = [0u8; 8];
                self.ports.entropy.fill(&mut raw)?;
                let id: String = raw.iter().map(|b| format!("{b:02x}")).collect();
                self.peers
                    .entry(peer.clone())
                    .or_insert_with(super::Peer::offline)
                    .offer_out = Some(id.clone());
                json!({ "t": "offer", "sdp": sdp, "o": id, "at": now })
            }
            SignalMessage::Answer(sdp) => {
                match self.peers.get(peer).and_then(|p| p.offer_in.clone()) {
                    Some(id) => json!({ "t": "answer", "sdp": sdp, "o": id }),
                    None => json!({ "t": "answer", "sdp": sdp }),
                }
            }
        };
        self.put_sealed(peer, &payload, PutKind::Sig, LIVE_TTL_SEC)
    }

    pub(super) fn on_relay_blob(&mut self, from: &UserId, frame: &Value) {
        let Some(GroupFrame::RelayBlob { blob, hops }) = GroupFrame::parse(frame) else {
            return;
        };
        if Some(blob.to.as_str()) == self.uid.as_ref().map(UserId::as_str) {
            self.handle_own_blob(*blob);
            return;
        }
        let Ok(target) = UserId::new(blob.to.as_str()) else {
            return;
        };
        if hops < 2 && &target != from && self.peers.get(&target).is_some_and(super::Peer::ready) {
            let next = GroupFrame::RelayBlob {
                blob,
                hops: hops + 1,
            }
            .to_value();
            self.send_secure(&target, &next);
        }
    }

    /// A blob on our own mailbox (from the service, or handed over by a contact).
    pub(super) fn handle_own_blob(&mut self, blob: SealedBlob) {
        if !self
            .sealed
            .seen
            .first_time(&privcord_crypto::seal::replay_id(&blob))
        {
            return;
        }
        let (Ok(from), Some(own), true) = (
            UserId::new(blob.from.as_str()),
            self.uid.clone(),
            self.identity.is_some(),
        ) else {
            return;
        };
        let Some(sign) = self
            .contacts
            .get(&from)
            .map(|c| c.contact.card.sign.clone())
        else {
            // Not a contact: the only thing a stranger may send is a friend request after adding us from our card.
            self.on_friend_request(&blob);
            return;
        };
        let Some(Value::Object(payload)) = self.open_from_contact(&blob, &from, &sign) else {
            return;
        };
        let text = |k: &str| payload.get(k).and_then(Value::as_str);
        match text("t") {
            Some("ready") => {
                // They are online and waiting: if we dial, do it now.
                if let Some(p) = self.peers.get_mut(&from) {
                    p.attempts = 0;
                    p.last_attempt_at = 0;
                }
                self.hub.publish(EngineEvent::SignalReceived {
                    peer: from,
                    message: SignalMessage::Ready,
                });
            }
            Some("offer") => {
                let Some(sdp) = text("sdp") else { return };
                if is_initiator(own.as_str(), from.as_str()) {
                    return;
                }
                let now = self.now();
                // Their own clock, compared only with their own earlier offers: a relay replaying the last minutes after
                // a reconnect must not make us answer an offer they have already given up on.
                let at = payload.get("at").and_then(Value::as_i64);
                let peer = self
                    .peers
                    .entry(from.clone())
                    .or_insert_with(super::Peer::offline);
                if let Some(at) = at {
                    if at < peer.offer_in_at {
                        return;
                    }
                    peer.offer_in_at = at;
                }
                if peer.ready() {
                    // We think the link is up. If it is still talking, this offer is stale; if it went quiet, they lost
                    // it before we noticed: drop it now and take the new one instead of waiting for our own timeout.
                    if peer.liveness.quiet_for(now)
                        < privcord_domain::link_policy::OFFER_REPLACES_QUIET_LINK_MS
                    {
                        return;
                    }
                    self.ports.transport.close(&from);
                    self.link_down(&from);
                }
                if let Some(p) = self.peers.get_mut(&from) {
                    p.offer_in = text("o").map(str::to_owned);
                }
                self.hub.publish(EngineEvent::SignalReceived {
                    peer: from,
                    message: SignalMessage::Offer(sdp.to_owned()),
                });
            }
            Some("answer") => {
                // An answer naming another offer than the one we are waiting on belongs to an attempt we replaced.
                if let (Some(said), Some(Some(waiting))) = (
                    text("o"),
                    self.peers.get(&from).map(|p| p.offer_out.as_deref()),
                ) {
                    if said != waiting {
                        return;
                    }
                }
                if let (true, Some(sdp)) = (is_initiator(own.as_str(), from.as_str()), text("sdp"))
                {
                    self.hub.publish(EngineEvent::SignalReceived {
                        peer: from,
                        message: SignalMessage::Answer(sdp.to_owned()),
                    });
                }
            }
            Some("msg") => {
                let (Some(id), Some(body), Some(at)) = (
                    text("id"),
                    text("text"),
                    payload.get("at").and_then(Value::as_i64),
                ) else {
                    return;
                };
                let frame = match text("g") {
                    Some(g) => {
                        json!({ "v": 1, "kind": "gmsg", "groupId": g, "messageId": id, "text": body, "clientCreatedAt": at })
                    }
                    None => {
                        json!({ "v": 1, "kind": "message", "messageId": id, "clientMessageId": id, "senderId": from.as_str(), "text": body, "clientCreatedAt": at })
                    }
                };
                self.relay_inbound = true;
                if text("g").is_some() {
                    self.on_group_message(&from, &frame);
                } else {
                    self.on_message(&from, &frame);
                }
                self.relay_inbound = false;
            }
            Some("frame") => {
                // A group file passed on by other members: handled exactly as if it came over a link from the sender.
                // Only group file frames are accepted this way.
                let Some(f) = payload.get("f") else { return };
                match f.get("kind").and_then(Value::as_str) {
                    Some("file_offer") if f.get("groupId").is_some_and(|g| !g.is_null()) => {
                        // A retry while the first copy is still arriving: keep the transfer we have.
                        let arriving = privcord_domain::files::FileOffer::from_frame(f)
                            .is_some_and(|o| {
                                self.peers
                                    .get(&from)
                                    .is_some_and(|p| p.files.next_index(&o.message_id).is_some())
                            });
                        if arriving {
                            return;
                        }
                        self.peers
                            .entry(from.clone())
                            .or_insert_with(super::Peer::offline);
                        self.relay_inbound = true;
                        self.on_file_offer(&from, f);
                        self.relay_inbound = false;
                    }
                    Some("file_chunk") => {
                        let Some(chunk) = privcord_domain::files::FileChunk::from_frame(f) else {
                            return;
                        };
                        // Only the chunk the transfer needs next goes in: the second helper's copy of one we have, or one
                        // from an earlier attempt that overtook, is skipped rather than spoiling the transfer.
                        let next = self
                            .peers
                            .get(&from)
                            .and_then(|p| p.files.next_index(&chunk.message_id));
                        if next != Some(chunk.index) {
                            return;
                        }
                        self.relay_inbound = true;
                        self.on_file_chunk(&from, f);
                        self.relay_inbound = false;
                    }
                    _ => {}
                }
            }
            Some("ack") => {
                if let Some(id) = text("id") {
                    self.on_ack(&from, &json!({ "messageId": id, "state": "DELIVERED" }));
                }
            }
            _ => {}
        }
    }

    /// Group members who are not linked to each other (they never verified each other, or one cannot reach the other)
    /// still get each other's messages: a group message still waiting for a member we have no link to is sealed to that
    /// member and handed to up to two members we are linked to, who pass it on (`relay_blob`). Only the addressee can
    /// open it; their receipt comes back the same way (or through the service), and the message then counts as
    /// delivered to them like any other.
    pub(super) fn tick_group_mesh(&mut self) {
        let Some(uid) = self.uid.clone() else { return };
        let now = self.now();
        if !self.peers.values().any(super::Peer::ready) {
            return;
        }
        let due: Vec<_> = self
            .outbox
            .iter()
            .filter(|o| {
                !self.peers.get(&o.recipient).is_some_and(super::Peer::ready)
                    && self
                        .sealed
                        .meshed
                        .get(&(o.message_id.clone(), o.recipient.clone()))
                        .is_none_or(|(at, _)| now - at >= MESH_RETRY_MS)
            })
            .cloned()
            .collect();
        for entry in due {
            let Some(row) = self.messages.get(&entry.message_id) else {
                continue;
            };
            let ConversationId::Group(g) = &row.conversation else {
                continue;
            };
            if row.message.sender_id != uid || now - row.message.client_created_at < MESH_AFTER_MS {
                continue;
            }
            let key = (entry.message_id.clone(), entry.recipient.clone());
            let (last, rounds) = self.sealed.meshed.get(&key).copied().unwrap_or((0, 0));
            let is_text = row.message.kind == MessageKind::Text;
            let max = if is_text {
                MESH_MAX_ROUNDS_TEXT
            } else {
                MESH_MAX_ROUNDS_FILE
            };
            if rounds >= max || (!is_text && rounds > 0 && now - last < super::FILE_RETRY_AFTER_MS)
            {
                continue;
            }
            // Helpers: members of this same group we are linked to (the ones likely linked to the member too).
            let helpers: Vec<UserId> = self
                .groups
                .as_ref()
                .map(|c| c.recipients(g.as_str()))
                .unwrap_or_default()
                .iter()
                .filter_map(|u| UserId::new(u.as_str()).ok())
                .filter(|u| {
                    *u != entry.recipient && self.peers.get(u).is_some_and(super::Peer::ready)
                })
                .take(2)
                .collect();
            if helpers.is_empty() {
                continue;
            }
            let payloads: Vec<Value> = if is_text {
                vec![
                    json!({ "t": "msg", "id": row.message.message_id, "text": row.message.text,
                    "at": row.message.client_created_at, "g": g.as_str() }),
                ]
            } else {
                // A file (voice note, photo, anything): its offer and every chunk, each sealed to the member, in order.
                // Both helpers get the same sealed copies; the member keeps the first of each and skips repeats.
                let Some(frames) = self.outbox_frames(&entry.message_id) else {
                    continue;
                };
                frames
                    .into_iter()
                    .map(|f| json!({ "t": "frame", "f": f }))
                    .collect()
            };
            let mut sent = true;
            for payload in payloads {
                let Ok(blob) = self.seal_to(&entry.recipient, &payload) else {
                    sent = false;
                    break;
                };
                let frame = GroupFrame::RelayBlob {
                    blob: Box::new(blob),
                    hops: 1,
                }
                .to_value();
                let mut any = false;
                for h in &helpers {
                    any |= self.send_secure(h, &frame);
                }
                if !any {
                    sent = false;
                    break;
                }
            }
            if sent {
                self.sealed.meshed.insert(key, (now, rounds + 1));
            }
        }
        let outbox = &self.outbox;
        self.sealed.meshed.retain(|(m, r), _| {
            outbox
                .iter()
                .any(|o| &o.message_id == m && &o.recipient == r)
        });
    }

    /// Listen on our own mailbox once signaling is up, and (only with store-and-forward on) put messages for friends who
    /// are offline on the relay.
    pub(super) fn tick_sealed(&mut self) {
        let available = self.ports.transport.signal_available();
        if !available {
            self.sealed.subscribed = false;
            return;
        }
        let Some(uid) = self.uid.clone() else {
            return;
        };
        if !self.sealed.subscribed
            && self
                .ports
                .transport
                .signal_subscribe(&mailbox_for(uid.as_str()))
                .is_ok()
        {
            self.sealed.subscribed = true;
        }
        if !matches!(self.ports.storage.kv(super::invites::KV_STORE_FORWARD), Ok(Some(v)) if v == b"1")
        {
            return;
        }
        let due: Vec<_> = self
            .outbox
            .iter()
            .filter(|o| {
                !self.peers.get(&o.recipient).is_some_and(super::Peer::ready)
                    && !self
                        .sealed
                        .relayed
                        .contains(&(o.message_id.clone(), o.recipient.clone()))
            })
            .cloned()
            .collect();
        for entry in due {
            let Some(row) = self.messages.get(&entry.message_id) else {
                continue;
            };
            if row.message.kind != MessageKind::Text || row.message.sender_id != uid {
                continue;
            }
            let mut payload = json!({ "t": "msg", "id": row.message.message_id, "text": row.message.text, "at": row.message.client_created_at });
            if let (ConversationId::Group(g), Some(o)) =
                (&row.conversation, payload.as_object_mut())
            {
                o.insert("g".into(), json!(g.as_str()));
            }
            let was_queued = row.message.delivery_state == DeliveryState::Queued;
            let key = (entry.message_id.clone(), entry.recipient.clone());
            self.sealed.relayed.insert(key.clone());
            if self
                .put_sealed(&entry.recipient, &payload, PutKind::Msg, RELAY_TTL_SEC)
                .is_err()
            {
                self.sealed.relayed.remove(&key);
                continue;
            }
            if was_queued
                && self
                    .ports
                    .storage
                    .apply(&[StorageOp::SetDelivery {
                        id: entry.message_id.clone(),
                        state: DeliveryState::Sent,
                        read_at: None,
                    }])
                    .is_ok()
            {
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
}
