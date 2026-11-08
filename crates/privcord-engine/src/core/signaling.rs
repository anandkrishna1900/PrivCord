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
use privcord_crypto::{
    group_coordinator::GroupFrame,
    seal::{mailbox_for, open, seal},
};
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

#[derive(Default)]
pub(super) struct SealedState {
    subscribed: bool,
    /// (message, recipient) pairs already handed to a signaling service.
    relayed: HashSet<(MessageId, UserId)>,
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

    fn seal_to(&mut self, peer: &UserId, payload: &Value) -> Result<SealedBlob, ErrorCode> {
        let dh = self
            .contacts
            .get(peer)
            .ok_or(ErrorCode::UnknownContact)?
            .contact
            .card
            .dh
            .clone();
        let identity = self.identity.as_ref().ok_or(ErrorCode::NoIdentity)?;
        Ok(seal(
            identity,
            peer,
            &dh,
            payload,
            &mut *self.ports.entropy,
        )?)
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
        if sent || (kind == PutKind::Sig && self.forward_via(peer, &blob)) {
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
        let payload = match message {
            SignalMessage::Ready => json!({ "t": "ready" }),
            SignalMessage::Offer(sdp) => json!({ "t": "offer", "sdp": sdp }),
            SignalMessage::Answer(sdp) => json!({ "t": "answer", "sdp": sdp }),
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
        if !self.sealed.seen.first_time(&blob.sig) {
            return;
        }
        let (Ok(from), Some(own), Some(identity)) = (
            UserId::new(blob.from.as_str()),
            self.uid.clone(),
            self.identity.as_ref(),
        ) else {
            return;
        };
        let Some(sign) = self
            .contacts
            .get(&from)
            .map(|c| c.contact.card.sign.clone())
        else {
            return;
        };
        let Some(Value::Object(payload)) = open(&blob, &own, identity, &sign, &from) else {
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
                let initiator = is_initiator(own.as_str(), from.as_str());
                let ready = self.peers.get(&from).is_some_and(super::Peer::ready);
                if let (false, false, Some(sdp)) = (initiator, ready, text("sdp")) {
                    self.hub.publish(EngineEvent::SignalReceived {
                        peer: from,
                        message: SignalMessage::Offer(sdp.to_owned()),
                    });
                }
            }
            Some("answer") => {
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
            Some("ack") => {
                if let Some(id) = text("id") {
                    self.on_ack(&from, &json!({ "messageId": id, "state": "DELIVERED" }));
                }
            }
            _ => {}
        }
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
