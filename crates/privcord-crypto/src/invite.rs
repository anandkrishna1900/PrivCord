//! Six-word invites (`connectivity/inviteCode.ts`). The words are the only secret: they derive a rendezvous mailbox
//! and an encryption key, and the person who types them is confirmed by safety numbers.

use crate::{
    aead,
    card::{Contact, ContactCard},
    error::CryptoError,
    identity::Identity,
    kdf::{hkdf_sha256, pbkdf2_sha256, sha256_hex},
    rng::{random_array, Entropy},
    seal::{placeholder_epk, sign_blob, verify_blob_signature},
};
use privcord_domain::{blob::SealedBlob, codec};
use serde_json::{json, Value};
use zeroize::Zeroizing;

pub const INVITE_WORDS: usize = 6;
pub const INVITE_TTL_SEC: u64 = 15 * 60;
const PBKDF2_ITERATIONS: u32 = 150_000;
fn salt() -> Vec<u8> {
    crate::kdf::label(&["duochat", "invite", "v1"])
}
const MAILBOX_PREFIX: &str = "duochat-invite-mailbox-v1|";

fn word_list() -> &'static [&'static str] {
    bip39::Language::English.word_list()
}

/// Six random words from the BIP-39 list (11 bits each).
pub fn new_invite_words(entropy: &mut dyn Entropy) -> Result<Vec<String>, CryptoError> {
    let bytes: [u8; INVITE_WORDS * 2] = random_array(entropy)?;
    let list = word_list();
    bytes
        .chunks_exact(2)
        .map(|c| {
            let [hi, lo] = c else {
                return Err(CryptoError::Invalid);
            };
            let index = ((usize::from(*hi) << 8) | usize::from(*lo)) & 0x7ff;
            list.get(index)
                .map(|w| (*w).to_owned())
                .ok_or(CryptoError::Invalid)
        })
        .collect()
}

/// Lower-cases, splits on anything that is not a letter, and requires exactly six known words.
pub fn parse_invite_words(text: &str) -> Option<Vec<String>> {
    let lower = text.to_lowercase();
    let parts: Vec<String> = lower
        .split(|c: char| !c.is_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if parts.len() != INVITE_WORDS {
        return None;
    }
    let list = word_list();
    parts
        .iter()
        .all(|w| list.contains(&w.as_str()))
        .then_some(parts)
}

/// Where both people meet, and the key that protects what they leave there.
pub struct Rendezvous {
    pub mailbox: String,
    pub key: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for Rendezvous {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Rendezvous")
            .field("mailbox", &self.mailbox)
            .finish_non_exhaustive()
    }
}

/// Slow on purpose (150,000 PBKDF2 rounds): it is what makes guessing the words expensive.
pub fn derive_invite(words: &[String]) -> Result<Rendezvous, CryptoError> {
    let seed = Zeroizing::new(pbkdf2_sha256(
        words.join(" ").as_bytes(),
        &salt(),
        PBKDF2_ITERATIONS,
    ));
    let mailbox = sha256_hex(format!("{MAILBOX_PREFIX}{}", codec::hex(&*seed)).as_bytes());
    let key = Zeroizing::new(hkdf_sha256::<32>(&*seed, &salt(), b"key")?);
    Ok(Rendezvous { mailbox, key })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InviteKind {
    /// The first card, left by the person who made the invite.
    Card,
    /// The answer, left by the person who typed the words.
    Reply,
}

impl InviteKind {
    fn tag(self) -> &'static str {
        match self {
            Self::Card => "card",
            Self::Reply => "reply",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteMessage {
    pub kind: InviteKind,
    pub contact: Contact,
}

pub fn seal_invite(
    rendezvous: &Rendezvous,
    kind: InviteKind,
    identity: &Identity,
    name: Option<&str>,
    entropy: &mut dyn Entropy,
) -> Result<SealedBlob, CryptoError> {
    let card = ContactCard::of(identity, name)?;
    let uid = identity.uid()?;
    let iv: [u8; 12] = random_array(entropy)?;
    let body = json!({ "t": kind.tag(), "card": card.encode()? });
    let ct = aead::encrypt(
        &*rendezvous.key,
        &iv,
        body.to_string().as_bytes(),
        format!("invite|{uid}").as_bytes(),
    )?;
    let mut blob = SealedBlob {
        v: 1,
        to: "invite".into(),
        from: uid.to_string(),
        epk: placeholder_epk(entropy)?,
        iv: codec::encode(&iv),
        ct: codec::encode(&ct),
        sig: String::new(),
    };
    blob.sig = sign_blob(identity, &blob)?;
    Ok(blob)
}

pub fn open_invite(rendezvous: &Rendezvous, blob: &Value) -> Option<InviteMessage> {
    let blob = SealedBlob::from_value(blob)?;
    if blob.to != "invite" {
        return None;
    }
    let plain = aead::decrypt(
        &*rendezvous.key,
        &codec::decode(&blob.iv)?,
        &codec::decode(&blob.ct)?,
        format!("invite|{}", blob.from).as_bytes(),
    )
    .ok()?;
    let body: Value = serde_json::from_slice(&plain).ok()?;
    let kind = match body.get("t")?.as_str()? {
        "card" => InviteKind::Card,
        "reply" => InviteKind::Reply,
        _ => return None,
    };
    let contact = ContactCard::decode(body.get("card")?.as_str()?)?;
    if contact.uid.as_str() != blob.from || !verify_blob_signature(&blob, &contact.card.sign) {
        return None;
    }
    Some(InviteMessage { kind, contact })
}
