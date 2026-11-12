//! Protocol v2 keys for sealed blobs (see `privcord_crypto::prekeys`): our own (with private halves) and each
//! contact's (public), kept in the encrypted database and refreshed over every post-quantum link.
//!
//! * One-time keys: each link hands the contact 10 new ones. A text message for someone who is offline is sealed to one
//!   of theirs, which the sender then forgets; the recipient erases its private half once the message is open. So an
//!   offline message has forward secrecy and is post-quantum.
//! * A standing key, replaced every 7 days (the previous ones are kept 30 days for late blobs): for signals, receipts,
//!   file pieces and when the one-time keys have run out.
//! * Sealing classically (protocol v1) is only for someone we have never had a link with (first contact). Once keys
//!   have been exchanged, a v1 blob from that person is refused, so nobody can force the old protocol.

use super::{Core, StorageOp};
use crate::error::ErrorCode;
use privcord_crypto::prekeys::{open_v2, seal_v2, OwnKey, PeerKey};
use privcord_domain::{
    blob::{PublicJwk, SealedBlob},
    UserId,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

const KV_KEYS: &str = "pq.keys";
const ONETIME_PER_LINK: usize = 10;
/// One-time keys we keep for one contact at most (the oldest go first).
const MAX_ISSUED_PER_PEER: usize = 60;
/// Their one-time keys we keep at most.
const MAX_THEIRS: usize = 50;
const STANDING_ROTATE_MS: i64 = 7 * 24 * 3600 * 1000;
/// Any of our keys older than this is erased (relays keep a stored blob for 7 days at most).
const KEY_LIFETIME_MS: i64 = 30 * 24 * 3600 * 1000;

pub(super) struct TheirKeys {
    standing: PeerKey,
    onetime: Vec<PeerKey>,
}

#[derive(Default)]
pub(super) struct KeyState {
    /// Our standing keys, newest first.
    standing: Vec<OwnKey>,
    /// One-time keys we gave each contact.
    issued: BTreeMap<UserId, Vec<OwnKey>>,
    /// Each contact's keys, as they last gave them to us.
    theirs: BTreeMap<UserId, TheirKeys>,
}

impl KeyState {
    fn to_value(&self) -> Value {
        let issued: Map<String, Value> = self
            .issued
            .iter()
            .map(|(u, ks)| {
                (
                    u.to_string(),
                    Value::Array(ks.iter().map(OwnKey::to_private_value).collect()),
                )
            })
            .collect();
        let theirs: Map<String, Value> = self
            .theirs
            .iter()
            .map(|(u, t)| {
                (
                    u.to_string(),
                    json!({ "standing": t.standing.to_value(), "onetime": t.onetime.iter().map(PeerKey::to_value).collect::<Vec<_>>() }),
                )
            })
            .collect();
        json!({
            "standing": self.standing.iter().map(OwnKey::to_private_value).collect::<Vec<_>>(),
            "issued": issued,
            "theirs": theirs,
        })
    }

    fn from_value(v: &Value) -> Self {
        let own = |a: Option<&Value>| -> Vec<OwnKey> {
            a.and_then(Value::as_array)
                .map(|a| a.iter().filter_map(OwnKey::from_private_value).collect())
                .unwrap_or_default()
        };
        let mut state = Self {
            standing: own(v.get("standing")),
            ..Self::default()
        };
        if let Some(m) = v.get("issued").and_then(Value::as_object) {
            for (u, ks) in m {
                if let Ok(uid) = UserId::new(u) {
                    state.issued.insert(uid, own(Some(ks)));
                }
            }
        }
        if let Some(m) = v.get("theirs").and_then(Value::as_object) {
            for (u, t) in m {
                let (Ok(uid), Some(standing)) = (
                    UserId::new(u),
                    t.get("standing").and_then(PeerKey::from_value),
                ) else {
                    continue;
                };
                let onetime = t
                    .get("onetime")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(PeerKey::from_value).collect())
                    .unwrap_or_default();
                state.theirs.insert(uid, TheirKeys { standing, onetime });
            }
        }
        state
    }
}

impl Core {
    pub(super) fn load_keys(&mut self) {
        self.keys = self
            .ports
            .storage
            .kv(KV_KEYS)
            .ok()
            .flatten()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .map(|v| KeyState::from_value(&v))
            .unwrap_or_default();
    }

    fn save_keys(&mut self) {
        let value = serde_json::to_vec(&self.keys.to_value()).unwrap_or_default();
        let _ = self.ports.storage.apply(&[StorageOp::SetKv {
            key: KV_KEYS.into(),
            value,
        }]);
    }

    /// Forget every key (a new identity, or everything erased).
    pub(super) fn reset_keys(&mut self) {
        self.keys = KeyState::default();
        self.save_keys();
    }

    /// A post-quantum link to `peer` is up: refresh our standing key if due, drop expired keys, and hand them our
    /// standing key and fresh one-time keys.
    pub(super) fn keys_on_link(&mut self, peer: &UserId) {
        let now = self.now();
        let fresh = self
            .keys
            .standing
            .first()
            .is_some_and(|k| now - k.created_at < STANDING_ROTATE_MS);
        if !fresh {
            match OwnKey::generate(&mut *self.ports.entropy, now) {
                Ok(k) => self.keys.standing.insert(0, k),
                Err(_) => return,
            }
        }
        self.keys
            .standing
            .retain(|k| now - k.created_at < KEY_LIFETIME_MS);
        for list in self.keys.issued.values_mut() {
            list.retain(|k| now - k.created_at < KEY_LIFETIME_MS);
        }
        let mut new = Vec::with_capacity(ONETIME_PER_LINK);
        for _ in 0..ONETIME_PER_LINK {
            match OwnKey::generate(&mut *self.ports.entropy, now) {
                Ok(k) => new.push(k),
                Err(_) => return,
            }
        }
        let publics: Vec<Value> = new.iter().map(|k| k.public().to_value()).collect();
        let list = self.keys.issued.entry(peer.clone()).or_default();
        list.extend(new);
        let over = list.len().saturating_sub(MAX_ISSUED_PER_PEER);
        list.drain(..over);
        let Some(standing) = self.keys.standing.first().map(|k| k.public().to_value()) else {
            return;
        };
        self.save_keys();
        self.send_secure(
            peer,
            &json!({ "v": privcord_domain::limits::PROTOCOL_VERSION, "kind": "keys", "standing": standing, "onetime": publics }),
        );
    }

    /// Their keys arrived over the link: they replace what we had (unused old ones of theirs may already be gone).
    pub(super) fn on_keys_frame(&mut self, peer: &UserId, frame: &Value) {
        let Some(standing) = frame.get("standing").and_then(PeerKey::from_value) else {
            return;
        };
        let onetime: Vec<PeerKey> = frame
            .get("onetime")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .take(MAX_THEIRS)
                    .filter_map(PeerKey::from_value)
                    .collect()
            })
            .unwrap_or_default();
        self.keys
            .theirs
            .insert(peer.clone(), TheirKeys { standing, onetime });
        self.save_keys();
    }

    /// Seal for a contact: v2 to one of their keys when we have them (a one-time key for a text message), else v1
    /// (only before the first link with them).
    pub(super) fn seal_for(
        &mut self,
        peer: &UserId,
        payload: &Value,
        dh: &PublicJwk,
    ) -> Result<SealedBlob, ErrorCode> {
        let one_time = payload.get("t").and_then(Value::as_str) == Some("msg");
        let key = match self.keys.theirs.get_mut(peer) {
            Some(t) if one_time && !t.onetime.is_empty() => Some(t.onetime.remove(0)),
            Some(t) => Some(t.standing.clone()),
            None => None,
        };
        let identity = self.identity.as_ref().ok_or(ErrorCode::NoIdentity)?;
        let blob = match &key {
            Some(k) => seal_v2(identity, peer, k, payload, &mut *self.ports.entropy)?,
            None => {
                privcord_crypto::seal::seal(identity, peer, dh, payload, &mut *self.ports.entropy)?
            }
        };
        if one_time && key.is_some() {
            // The one-time key is used: never again.
            self.save_keys();
        }
        Ok(blob)
    }

    /// Open a blob from a contact: v2 with the key it names (a one-time key is erased once used); v1 only from someone
    /// we have never exchanged keys with.
    pub(super) fn open_from_contact(
        &mut self,
        blob: &SealedBlob,
        from: &UserId,
        sign: &PublicJwk,
    ) -> Option<Value> {
        let own_uid = self.uid.clone()?;
        if blob.v == 2 {
            let id = blob.key.as_deref()?;
            if let Some(k) = self.keys.standing.iter().find(|k| k.id == id) {
                return open_v2(blob, &own_uid, k, sign, from);
            }
            let list = self.keys.issued.get_mut(from)?;
            let at = list.iter().position(|k| k.id == id)?;
            let opened = open_v2(blob, &own_uid, list.get(at)?, sign, from)?;
            list.remove(at);
            self.save_keys();
            return Some(opened);
        }
        if self.keys.theirs.contains_key(from) {
            return None;
        }
        let identity = self.identity.as_ref()?;
        privcord_crypto::seal::open(blob, &own_uid, identity, sign, from)
    }
}
