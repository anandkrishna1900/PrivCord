//! Signaling and mailboxes over public Nostr relays (`signaling/nostr.ts`): events signed with BIP-340 Schnorr under a
//! fresh throwaway key (so events cannot be linked to the PrivCord identity), and the rules for which relay messages
//! become blobs. The sockets themselves stay in the platform adapters.

use crate::{
    rng::{random_array, Entropy},
    CryptoError,
};
use k256::schnorr::{signature::Error as SigError, Signature, SigningKey, VerifyingKey};
use privcord_domain::{blob::SealedBlob, codec, signaling::SeenSet};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Ephemeral range: relays do not store it.
pub const NOSTR_KIND_SIGNAL: u64 = 21733;
/// Parameterised replaceable range: relays store it.
pub const NOSTR_KIND_MESSAGE: u64 = 31733;

pub use privcord_domain::signaling::PutKind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NostrEvent {
    pub id: String,
    pub pubkey: String,
    pub created_at: i64,
    pub kind: u64,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub sig: String,
}

impl NostrEvent {
    pub fn to_value(&self) -> Value {
        json!({
            "id": self.id, "pubkey": self.pubkey, "created_at": self.created_at, "kind": self.kind,
            "tags": self.tags, "content": self.content, "sig": self.sig,
        })
    }

    /// `None` unless every field has the right type.
    pub fn from_value(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        let tags = o
            .get("tags")?
            .as_array()?
            .iter()
            .map(|t| {
                t.as_array()?
                    .iter()
                    .map(|s| s.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            id: o.get("id")?.as_str()?.to_owned(),
            pubkey: o.get("pubkey")?.as_str()?.to_owned(),
            created_at: o.get("created_at")?.as_i64()?,
            kind: o.get("kind")?.as_u64()?,
            tags,
            content: o.get("content")?.as_str()?.to_owned(),
            sig: o.get("sig")?.as_str()?.to_owned(),
        })
    }

    pub fn tag(&self, name: &str) -> Option<&str> {
        self.tags
            .iter()
            .find(|t| t.first().map(String::as_str) == Some(name))
            .and_then(|t| t.get(1))
            .map(String::as_str)
    }
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || !s.is_ascii() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// SHA-256 of `[0, pubkey, created_at, kind, tags, content]` as compact JSON, in lowercase hex.
pub fn event_id(
    pubkey: &str,
    created_at: i64,
    kind: u64,
    tags: &[Vec<String>],
    content: &str,
) -> String {
    let text = json!([0, pubkey, created_at, kind, tags, content]).to_string();
    codec::hex(&Sha256::digest(text.as_bytes()))
}

/// An event carrying `blob` for `mailbox`, signed with a fresh throwaway key.
pub fn make_event(
    mailbox: &str,
    blob: &SealedBlob,
    kind: PutKind,
    ttl_sec: u32,
    now_secs: i64,
    entropy: &mut dyn Entropy,
) -> Result<NostrEvent, CryptoError> {
    // A random 32-byte value is a valid secret key except with negligible probability; try a few times anyway.
    let sk = (0..8)
        .find_map(|_| {
            let bytes: [u8; 32] = random_array(entropy).ok()?;
            SigningKey::from_bytes(&k256::FieldBytes::from(bytes)).ok()
        })
        .ok_or(CryptoError::Random)?;
    let pubkey = codec::hex(&sk.verifying_key().to_bytes());
    let d: [u8; 16] = random_array(entropy)?;
    let tags = vec![
        vec!["t".to_owned(), mailbox.to_owned()],
        // `d` makes every stored message its own addressable event instead of replacing the last one.
        vec!["d".to_owned(), codec::hex(&d)],
        vec![
            "expiration".to_owned(),
            (now_secs + i64::from(ttl_sec)).to_string(),
        ],
    ];
    let content = blob.encode();
    let nostr_kind = match kind {
        PutKind::Sig => NOSTR_KIND_SIGNAL,
        PutKind::Msg => NOSTR_KIND_MESSAGE,
    };
    let id = event_id(&pubkey, now_secs, nostr_kind, &tags, &content);
    let aux: [u8; 32] = random_array(entropy)?;
    let id_bytes = unhex(&id).ok_or(CryptoError::Invalid)?;
    let sig = sk
        .sign_raw(&id_bytes, &aux)
        .map_err(|_| CryptoError::Invalid)?;
    Ok(NostrEvent {
        id,
        pubkey,
        created_at: now_secs,
        kind: nostr_kind,
        tags,
        content,
        sig: codec::hex(&sig.to_bytes()),
    })
}

/// Does the id match the content, and does the signature check out under the event's own key?
pub fn verify_event(e: &NostrEvent) -> bool {
    fn check(e: &NostrEvent) -> Result<bool, SigError> {
        if event_id(&e.pubkey, e.created_at, e.kind, &e.tags, &e.content) != e.id {
            return Ok(false);
        }
        let (Some(sig), Some(id), Some(pk)) = (unhex(&e.sig), unhex(&e.id), unhex(&e.pubkey))
        else {
            return Ok(false);
        };
        let (Ok(pk32), true) = (<[u8; 32]>::try_from(pk.as_slice()), sig.len() == 64) else {
            return Ok(false);
        };
        let key = VerifyingKey::from_bytes(&k256::FieldBytes::from(pk32))?;
        let sig = Signature::try_from(sig.as_slice())?;
        key.verify_raw(&id, &sig)?;
        Ok(true)
    }
    check(e).unwrap_or(false)
}

/// The subscription request for a mailbox: `["REQ", subId, {kinds, "#t": [mailbox], since}]`.
pub fn req_frame(sub_id: &str, mailbox: &str, since_secs: i64) -> String {
    json!(["REQ", sub_id, { "kinds": [NOSTR_KIND_SIGNAL, NOSTR_KIND_MESSAGE], "#t": [mailbox], "since": since_secs }])
        .to_string()
}

pub fn event_frame(e: &NostrEvent) -> String {
    json!(["EVENT", e.to_value()]).to_string()
}

/// What to do with one message from a relay: a blob (and the event id) only if it is for our subscription, verifies,
/// names our mailbox, has not expired and has not been seen. Everything else is dropped.
pub fn accept_relay_message(
    raw: &str,
    sub_id: &str,
    mailbox: &str,
    seen: &mut SeenSet,
    now_secs: i64,
) -> Option<(SealedBlob, String)> {
    let frame: Value = serde_json::from_str(raw).ok()?;
    let arr = frame.as_array()?;
    if arr.first()?.as_str()? != "EVENT" || arr.get(1)?.as_str()? != sub_id {
        return None;
    }
    let event = NostrEvent::from_value(arr.get(2)?)?;
    if !verify_event(&event) || event.tag("t") != Some(mailbox) {
        return None;
    }
    // JS compares `Number(expiry) < now`; an unparsable value is NaN, which never compares true, so it is kept.
    if let Some(Ok(exp)) = event.tag("expiration").map(str::parse::<f64>) {
        if exp < now_secs as f64 {
            return None;
        }
    }
    if !seen.first_time(&event.id) {
        return None;
    }
    let blob = SealedBlob::decode(&event.content)?;
    Some((blob, event.id))
}
