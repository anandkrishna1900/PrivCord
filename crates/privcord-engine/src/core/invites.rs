//! Six-word invites, the people who answer them, and removing a friend (`engine.ts` "six-word invites").
//!
//! The engine never opens a socket. It tells the transport which mailbox to listen on and what to publish
//! (`Transport::signal_*`); blobs that arrive come back through `signal_blob`. Time passes through `tick`.

use super::{Core, StorageOp};
use crate::{
    api::{AnswerStatus, EngineEvent},
    error::ErrorCode,
};
use privcord_crypto::{
    card::{Contact, ContactCard},
    invite::{
        derive_invite, new_invite_words, open_invite, parse_invite_words, seal_invite, InviteKind,
        Rendezvous, INVITE_TTL_SEC,
    },
    safety::derive_safety_number,
};
use privcord_domain::{
    blob::SealedBlob,
    privacy::ContactTrust,
    signaling::{PutKind, SeenSet},
    ConversationId, UserId,
};
use privcord_ports::EraseScope;
use std::collections::BTreeMap;

pub(super) const KV_STORE_FORWARD: &str = "settings.store_forward";
pub(super) const KV_NAME: &str = "profile.name";
/// The invite card is published again this often while the invite is open: relays differ in what they keep.
const REPUBLISH_MS: i64 = 4_000;
const LOOKUP_MS: i64 = 40_000;
const ANSWER_LINGER_MS: i64 = 1_500;
const LIVE_TTL_SEC: u32 = 120;
/// After adding someone from their card (a QR code), we ask them to add us back this often until we are connected...
const HELLO_EVERY_MS: i64 = 60_000;
/// ...for at most this long (they may be offline; on their side it waits as a request).
const HELLO_FOR_MS: i64 = 30 * 60_000;
/// Requests kept at once: someone who saw our QR code cannot fill the screen with them.
const MAX_REQUESTS: usize = 20;

struct Hello {
    next_at: i64,
    until: i64,
}

struct ActiveInvite {
    words: String,
    rv: Rendezvous,
    expires_at: i64,
    next_publish_at: i64,
}

struct Lookup {
    words: String,
    rv: Rendezvous,
    deadline: i64,
}

struct Redeemed {
    words: String,
    rv: Rendezvous,
    contact: Contact,
}

struct Answer {
    uid: UserId,
    rv: Rendezvous,
    status: AnswerStatus,
    /// Stop listening on the mailbox at this time.
    unsubscribe_at: Option<i64>,
}

pub(super) struct Request {
    pub contact: Contact,
    pub safety_number: String,
}

#[derive(Default)]
pub(super) struct InviteState {
    active: Option<ActiveInvite>,
    lookup: Option<Lookup>,
    redeemed: Option<Redeemed>,
    answer: Option<Answer>,
    pub(super) requests: BTreeMap<UserId, Request>,
    hellos: BTreeMap<UserId, Hello>,
    seen: SeenSet,
}

/// What a person sees before saving a friend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvitePreview {
    pub uid: UserId,
    pub name: String,
    pub safety_number: String,
    /// They are already a verified friend.
    pub already: bool,
}

fn short(uid: &UserId) -> String {
    uid.as_str().chars().take(8).collect()
}

impl Core {
    pub(super) fn store_forward(&self) -> bool {
        matches!(self.ports.storage.kv(KV_STORE_FORWARD), Ok(Some(v)) if v == b"1")
    }

    /// With this on, invites are also kept on the relay for 15 minutes; with it off nothing may be stored there.
    pub fn set_store_forward(&mut self, value: bool) -> Result<(), ErrorCode> {
        self.require_live()?;
        self.ports.storage.apply(&[StorageOp::SetKv {
            key: KV_STORE_FORWARD.into(),
            value: vec![u8::from(value) + b'0'],
        }])?;
        Ok(())
    }

    /// The name put on invite cards.
    pub fn set_display_name(&mut self, name: &str) -> Result<(), ErrorCode> {
        self.require_live()?;
        let name: String = privcord_domain::text::js_trim(name)
            .chars()
            .take(40)
            .collect();
        self.ports.storage.apply(&[StorageOp::SetKv {
            key: KV_NAME.into(),
            value: name.clone().into_bytes(),
        }])?;
        self.display_name = Some(name).filter(|n| !n.is_empty());
        Ok(())
    }

    fn preview_of(&self, contact: &Contact) -> Result<InvitePreview, ErrorCode> {
        if Some(&contact.uid) == self.uid.as_ref() {
            return Err(ErrorCode::OwnInvite);
        }
        let own = self.identity()?;
        Ok(InvitePreview {
            uid: contact.uid.clone(),
            name: contact
                .card
                .name
                .clone()
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| format!("Friend {}", short(&contact.uid))),
            safety_number: derive_safety_number(&own.sign_public(), &contact.card.sign)?,
            already: self
                .contacts
                .get(&contact.uid)
                .is_some_and(|c| c.stored.trust == ContactTrust::Verified),
        })
    }

    /* ---------------------------------------------------------------- show your words */

    /// Publish our card under fresh words and listen for people who answer. Returns the words and when they expire.
    pub fn create_invite(&mut self) -> Result<(String, i64), ErrorCode> {
        self.require_live()?;
        self.identity()?;
        let now = self.now();
        if let Some(a) = &self.invites.active {
            if a.expires_at > now + 30_000 {
                return Ok((a.words.clone(), a.expires_at));
            }
        }
        self.stop_invite();
        if !self.ports.transport.signal_available() {
            return Err(ErrorCode::NoSignaling);
        }
        let words = new_invite_words(&mut *self.ports.entropy)?;
        let rv = derive_invite(&words)?;
        self.ports
            .transport
            .signal_subscribe(&rv.mailbox)
            .map_err(|_| ErrorCode::NoSignaling)?;
        let text = words.join(" ");
        let expires_at = now + i64::try_from(INVITE_TTL_SEC).unwrap_or(900) * 1000;
        self.invites.active = Some(ActiveInvite {
            words: text.clone(),
            rv,
            expires_at,
            next_publish_at: now + REPUBLISH_MS,
        });
        if self.publish_invite().is_err() {
            self.stop_invite();
            return Err(ErrorCode::NoSignaling);
        }
        self.hub.publish(EngineEvent::InviteChanged);
        Ok((text, expires_at))
    }

    fn put_everywhere(&self, mailbox: &str, blob: &SealedBlob) -> Result<(), ErrorCode> {
        let text = blob.encode();
        let live = self
            .ports
            .transport
            .signal_put(mailbox, &text, PutKind::Sig, LIVE_TTL_SEC);
        let stored = if self.store_forward() {
            Some(self.ports.transport.signal_put(
                mailbox,
                &text,
                PutKind::Msg,
                u32::try_from(INVITE_TTL_SEC).unwrap_or(900),
            ))
        } else {
            None
        };
        if live.is_ok() || stored.is_some_and(|s| s.is_ok()) {
            Ok(())
        } else {
            Err(ErrorCode::NoSignaling)
        }
    }

    fn publish_invite(&mut self) -> Result<(), ErrorCode> {
        let Some(a) = &self.invites.active else {
            return Ok(());
        };
        let blob = seal_invite(
            &a.rv,
            InviteKind::Card,
            self.identity.as_ref().ok_or(ErrorCode::NoIdentity)?,
            self.display_name.as_deref(),
            &mut *self.ports.entropy,
        )?;
        self.put_everywhere(&a.rv.mailbox, &blob)
    }

    pub fn stop_invite(&mut self) {
        if let Some(a) = self.invites.active.take() {
            self.ports.transport.signal_unsubscribe(&a.rv.mailbox);
            self.hub.publish(EngineEvent::InviteChanged);
        }
    }

    /* ---------------------------------------------------------------- enter their words (or paste a card) */

    /// Look at an invite without saving anything. A full card answers at once; six words start a search that ends with
    /// `InviteFound` or `InviteLookupFailed` (15 seconds at most).
    pub fn preview_invite(&mut self, text: &str) -> Result<Option<InvitePreview>, ErrorCode> {
        self.require_live()?;
        self.identity()?;
        let Some(words) = parse_invite_words(text) else {
            let contact = ContactCard::decode(text).ok_or(ErrorCode::InvalidInvite)?;
            return self.preview_of(&contact).map(Some);
        };
        let key = words.join(" ");
        if let Some(r) = self.invites.redeemed.as_ref().filter(|r| r.words == key) {
            return self.preview_of(&r.contact).map(Some);
        }
        if !self.ports.transport.signal_available() {
            return Err(ErrorCode::NoSignaling);
        }
        self.cancel_lookup();
        let rv = derive_invite(&words)?;
        self.ports
            .transport
            .signal_subscribe(&rv.mailbox)
            .map_err(|_| ErrorCode::NoSignaling)?;
        let deadline = self.now() + LOOKUP_MS;
        self.invites.lookup = Some(Lookup {
            words: key,
            rv,
            deadline,
        });
        Ok(None)
    }

    fn cancel_lookup(&mut self) {
        if let Some(l) = self.invites.lookup.take() {
            self.ports.transport.signal_unsubscribe(&l.rv.mailbox);
        }
    }

    /// Save a friend from their invite and return who they are. After typing their words we also answer with our own
    /// card, so they can accept us on their side.
    pub fn accept_invite(&mut self, text: &str) -> Result<UserId, ErrorCode> {
        self.require_live()?;
        self.identity()?;
        let (contact, answer_with) = match parse_invite_words(text) {
            Some(words) => {
                let key = words.join(" ");
                match self.invites.redeemed.take() {
                    Some(r) if r.words == key => (r.contact, Some(r.rv)),
                    other => {
                        self.invites.redeemed = other;
                        return Err(ErrorCode::InviteNotFound);
                    }
                }
            }
            None => (
                ContactCard::decode(text).ok_or(ErrorCode::InvalidInvite)?,
                None,
            ),
        };
        if Some(&contact.uid) == self.uid.as_ref() {
            return Err(ErrorCode::OwnInvite);
        }
        let text = contact.card.encode()?;
        let uid = self.add_contact_from(&text, ContactTrust::Verified, None)?;
        self.invites.requests.remove(&uid);
        if let Some(rv) = answer_with {
            self.run_answer(uid.clone(), rv);
        } else {
            // From their card (a QR code): they do not know us yet. Ask them to add us back, so they only have to accept.
            let now = self.now();
            self.invites.hellos.insert(
                uid.clone(),
                Hello {
                    next_at: now,
                    until: now + HELLO_FOR_MS,
                },
            );
            self.send_hellos();
        }
        Ok(uid)
    }

    /// Sends the "please add me back" requests that are due, until the link is up or the time runs out.
    fn send_hellos(&mut self) {
        let now = self.now();
        let due: Vec<UserId> = self
            .invites
            .hellos
            .iter()
            .filter(|(_, h)| h.next_at <= now)
            .map(|(u, _)| u.clone())
            .collect();
        for uid in due {
            let linked = self.peers.get(&uid).is_some_and(super::Peer::ready);
            let expired = self.invites.hellos.get(&uid).is_none_or(|h| h.until <= now);
            if linked || expired || !self.contacts.contains_key(&uid) {
                self.invites.hellos.remove(&uid);
                continue;
            }
            if let Some(h) = self.invites.hellos.get_mut(&uid) {
                h.next_at = now + HELLO_EVERY_MS;
            }
            let Ok(card) = self.own_card(self.display_name.clone().as_deref()) else {
                continue;
            };
            let payload = serde_json::json!({ "t": "hello", "card": card });
            if let Ok(blob) = self.seal_to(&uid, &payload) {
                // A failed send is tried again on the next round.
                let _ =
                    self.put_everywhere(&privcord_crypto::seal::mailbox_for(uid.as_str()), &blob);
            }
        }
    }

    /// Someone added us from our card and asks to be added back: it waits as a request, like someone who used our
    /// six words. Only a blob signed by the identity on the card inside it gets this far (`open_from_stranger`).
    pub(super) fn on_friend_request(&mut self, blob: &SealedBlob) {
        let (Some(own_uid), Some(identity)) = (self.uid.clone(), self.identity.as_ref()) else {
            return;
        };
        let Some((contact, payload)) =
            privcord_crypto::seal::open_from_stranger(blob, &own_uid, identity)
        else {
            return;
        };
        if payload.get("t").and_then(serde_json::Value::as_str) != Some("hello")
            || contact.uid == own_uid
        {
            return;
        }
        if self.invites.requests.len() >= MAX_REQUESTS
            && !self.invites.requests.contains_key(&contact.uid)
        {
            return;
        }
        let Ok(safety_number) = derive_safety_number(&identity.sign_public(), &contact.card.sign)
        else {
            return;
        };
        let uid = contact.uid.clone();
        let new = !self.invites.requests.contains_key(&uid);
        self.invites.requests.insert(
            uid.clone(),
            Request {
                contact,
                safety_number,
            },
        );
        if new {
            self.hub.publish(EngineEvent::InviteRequest { uid });
        }
    }

    fn run_answer(&mut self, uid: UserId, rv: Rendezvous) {
        let _ = self.ports.transport.signal_subscribe(&rv.mailbox);
        let status = match self.send_reply(&rv) {
            Ok(()) => AnswerStatus::Sent,
            Err(_) => AnswerStatus::Failed,
        };
        let unsubscribe_at = Some(self.now() + ANSWER_LINGER_MS);
        self.invites.answer = Some(Answer {
            uid,
            rv,
            status,
            unsubscribe_at,
        });
        self.hub.publish(EngineEvent::AnswerChanged);
    }

    fn send_reply(&mut self, rv: &Rendezvous) -> Result<(), ErrorCode> {
        let blob = seal_invite(
            rv,
            InviteKind::Reply,
            self.identity.as_ref().ok_or(ErrorCode::NoIdentity)?,
            self.display_name.as_deref(),
            &mut *self.ports.entropy,
        )?;
        self.put_everywhere(&rv.mailbox, &blob)
    }

    /// Send our answer again after it failed.
    pub fn retry_answer(&mut self) -> Result<(), ErrorCode> {
        self.require_live()?;
        let Some(a) = self.invites.answer.take() else {
            return Ok(());
        };
        self.run_answer(a.uid, a.rv);
        Ok(())
    }

    pub fn clear_answer(&mut self) {
        if let Some(a) = self.invites.answer.take() {
            self.ports.transport.signal_unsubscribe(&a.rv.mailbox);
            self.hub.publish(EngineEvent::AnswerChanged);
        }
    }

    /* ---------------------------------------------------------------- people who used our words */

    /// Accept somebody who used our words.
    pub fn accept_request(&mut self, uid: &UserId) -> Result<UserId, ErrorCode> {
        self.require_live()?;
        let r = self
            .invites
            .requests
            .remove(uid)
            .ok_or(ErrorCode::InviteNotFound)?;
        let text = r.contact.card.encode()?;
        self.add_contact_from(&text, ContactTrust::Verified, None)
    }

    pub fn dismiss_request(&mut self, uid: &UserId) {
        if self.invites.requests.remove(uid).is_some() {
            self.hub.publish(EngineEvent::InviteChanged);
        }
    }

    /* ---------------------------------------------------------------- blobs from the signaling service */

    /// A blob arrived on a mailbox we listen on. The first copy wins when several services deliver it.
    pub fn signal_blob(&mut self, mailbox: &str, encoded: &str) {
        if self.shut_down {
            return;
        }
        let Some(blob) = SealedBlob::decode(encoded) else {
            return;
        };
        if !self.invites.seen.first_time(&blob.sig) {
            return;
        }
        let Ok(value) = serde_json::to_value(&blob) else {
            return;
        };
        let Some(own) = self.identity.as_ref().map(|i| i.sign_public()) else {
            return;
        };
        // A message in a public channel we joined, carried by the signaling service.
        if self.channels.values().any(|k| k.mailbox == mailbox) {
            self.accept_channel_blob(&blob);
            return;
        }
        // Someone answered our words.
        if let Some(a) = self
            .invites
            .active
            .as_ref()
            .filter(|a| a.rv.mailbox == mailbox)
        {
            let Some(m) = open_invite(&a.rv, &value).filter(|m| m.kind == InviteKind::Reply) else {
                return;
            };
            let contact = m.contact;
            let already_friend = self
                .contacts
                .get(&contact.uid)
                .is_some_and(|c| c.stored.trust == ContactTrust::Verified);
            if Some(&contact.uid) == self.uid.as_ref() || already_friend {
                return;
            }
            let Ok(safety_number) = derive_safety_number(&own, &contact.card.sign) else {
                return;
            };
            let uid = contact.uid.clone();
            self.invites.requests.insert(
                uid.clone(),
                Request {
                    contact,
                    safety_number,
                },
            );
            self.hub.publish(EngineEvent::InviteRequest { uid });
            return;
        }
        // Something sealed for us, on our own mailbox.
        if self
            .uid
            .as_ref()
            .is_some_and(|u| privcord_crypto::seal::mailbox_for(u.as_str()) == mailbox)
        {
            self.handle_own_blob(blob);
            return;
        }
        // The card behind words we typed.
        let found = self
            .invites
            .lookup
            .as_ref()
            .filter(|l| l.rv.mailbox == mailbox)
            .and_then(|l| open_invite(&l.rv, &value))
            .filter(|m| m.kind == InviteKind::Card);
        if let Some(m) = found {
            if let Some(l) = self.invites.lookup.take() {
                self.ports.transport.signal_unsubscribe(&l.rv.mailbox);
                let preview = self.preview_of(&m.contact);
                self.invites.redeemed = Some(Redeemed {
                    words: l.words,
                    rv: l.rv,
                    contact: m.contact,
                });
                match preview {
                    Ok(p) => self.hub.publish(EngineEvent::InviteFound {
                        uid: p.uid,
                        name: p.name,
                        safety_number: p.safety_number,
                        already: p.already,
                    }),
                    // Their own card (words typed by the person who made them).
                    Err(_) => {
                        self.invites.redeemed = None;
                        self.hub.publish(EngineEvent::InviteLookupFailed);
                    }
                }
            }
        }
    }

    /// Time passes: republish the open invite, expire it, give up on a search, stop listening after an answer.
    pub(super) fn tick_invites(&mut self) {
        self.send_hellos();
        let now = self.now();
        let (expired, due) = self.invites.active.as_ref().map_or((false, false), |a| {
            (a.expires_at <= now, a.next_publish_at <= now)
        });
        if expired {
            self.stop_invite();
        } else if due {
            if let Some(a) = self.invites.active.as_mut() {
                a.next_publish_at = now + REPUBLISH_MS;
            }
            let _ = self.publish_invite(); // a failed republish is retried on the next round
        }
        if self
            .invites
            .lookup
            .as_ref()
            .is_some_and(|l| l.deadline <= now)
        {
            self.cancel_lookup();
            self.hub.publish(EngineEvent::InviteLookupFailed);
        }
        if let Some(a) = self.invites.answer.as_mut() {
            if a.unsubscribe_at.is_some_and(|t| t <= now) {
                a.unsubscribe_at = None;
                let mailbox = a.rv.mailbox.clone();
                self.ports.transport.signal_unsubscribe(&mailbox);
            }
        }
    }

    pub(super) fn invite_views(
        &self,
    ) -> (
        Option<crate::api::InviteView>,
        Vec<crate::api::RequestView>,
        Option<crate::api::AnswerView>,
        bool,
    ) {
        let invite = self
            .invites
            .active
            .as_ref()
            .map(|a| crate::api::InviteView {
                words: a.words.clone(),
                expires_at: a.expires_at,
            });
        let requests = self
            .invites
            .requests
            .iter()
            .map(|(uid, r)| crate::api::RequestView {
                uid: uid.clone(),
                name: r
                    .contact
                    .card
                    .name
                    .clone()
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| format!("Friend {}", short(uid))),
                safety_number: r.safety_number.clone(),
            })
            .collect();
        let answer = self
            .invites
            .answer
            .as_ref()
            .map(|a| crate::api::AnswerView {
                uid: a.uid.clone(),
                status: a.status,
            });
        (invite, requests, answer, self.invites.lookup.is_some())
    }

    /* ---------------------------------------------------------------- forgetting a friend */

    /// Forget a friend and their chat. Refused while they share a group with us, because the group would bring them
    /// straight back.
    pub fn remove_contact(&mut self, uid: &UserId) -> Result<(), ErrorCode> {
        self.require_live()?;
        if !self.contacts.contains_key(uid) {
            return Err(ErrorCode::UnknownContact);
        }
        if self.groups.as_ref().is_some_and(|g| {
            g.my_groups()
                .iter()
                .any(|s| s.members.contains_key(uid.as_str()))
        }) {
            return Err(ErrorCode::StillInGroup);
        }
        self.ports.storage.apply(&[
            StorageOp::Erase(EraseScope::Conversation(ConversationId::Direct(
                uid.clone(),
            ))),
            StorageOp::DeleteContact(uid.clone()),
        ])?;
        self.link_down(uid);
        self.ports.transport.close(uid);
        self.peers.remove(uid);
        self.contacts.remove(uid);
        self.messages
            .retain(|_, m| m.conversation != ConversationId::Direct(uid.clone()));
        self.outbox
            .retain(|o| self.messages.contains_key(&o.message_id));
        self.invites.requests.remove(uid);
        self.hub
            .publish(EngineEvent::ContactRemoved { uid: uid.clone() });
        Ok(())
    }
}
