//! Open channels (`mesh/channel.ts`): anyone who knows the name can read and post. Messages are signed (so you see
//! who wrote them) but not private.

use crate::{
    aead,
    card::{Contact, ContactCard},
    error::CryptoError,
    identity::Identity,
    kdf::{hkdf_sha256, sha256},
    rng::{random_array, Entropy},
    seal::{placeholder_epk, sign_blob, verify_blob_signature},
};
use privcord_domain::{blob::SealedBlob, codec, limits::MAX_CHANNEL_TEXT, text::js_trim};
use serde_json::{json, Value};
use zeroize::Zeroizing;

pub const CHANNEL_TTL_SEC: u64 = 24 * 3600;
const SALT: &[u8] = b"duochat-channel-v1";
const MAILBOX_PREFIX: &str = "duochat-channel-mailbox-v1|";

/// Everything a name gives: where messages travel, the key they are wrapped in, and the label blobs carry.
pub struct ChannelKeys {
    pub name: String,
    pub mailbox: String,
    pub tag: String,
    key: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for ChannelKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChannelKeys").field("name", &self.name).finish_non_exhaustive()
    }
}

/// `name` must already be normalised (`privcord_domain::channel::normalize_channel_name`).
pub fn derive_channel(name: &str) -> Result<ChannelKeys, CryptoError> {
    let digest = sha256(format!("{MAILBOX_PREFIX}{name}").as_bytes());
    let mailbox = codec::hex(&digest);
    let tag = format!("ch:{}", mailbox.chars().take(16).collect::<String>());
    let key = Zeroizing::new(hkdf_sha256::<32>(&digest, SALT, b"key")?);
    Ok(ChannelKeys { name: name.to_owned(), mailbox, tag, key })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelMessage {
    pub channel: String,
    pub text: String,
    pub at: i64,
    pub contact: Contact,
}

pub fn seal_channel_message(channel: &ChannelKeys, identity: &Identity, name: Option<&str>, text: &str, at: i64, entropy: &mut dyn Entropy) -> Result<SealedBlob, CryptoError> {
    let text: String = js_trim(text).chars().take(MAX_CHANNEL_TEXT).collect();
    if text.is_empty() {
        return Err(CryptoError::EmptyMessage);
    }
    let card = ContactCard::of(identity, name)?;
    let uid = identity.uid()?;
    let iv: [u8; 12] = random_array(entropy)?;
    let body = json!({ "c": channel.name, "t": text, "at": at, "card": card.encode()? });
    let ct = aead::encrypt(&*channel.key, &iv, body.to_string().as_bytes(), format!("{}|{uid}", channel.tag).as_bytes())?;
    let mut blob = SealedBlob {
        v: 1,
        to: channel.tag.clone(),
        from: uid.to_string(),
        epk: placeholder_epk(entropy),
        iv: codec::encode(&iv),
        ct: codec::encode(&ct),
        sig: String::new(),
    };
    blob.sig = sign_blob(identity, &blob)?;
    Ok(blob)
}

pub fn open_channel_message(channel: &ChannelKeys, blob: &Value) -> Option<ChannelMessage> {
    let blob = SealedBlob::from_value(blob)?;
    if blob.to != channel.tag {
        return None;
    }
    let plain = aead::decrypt(&*channel.key, &codec::decode(&blob.iv)?, &codec::decode(&blob.ct)?, format!("{}|{}", channel.tag, blob.from).as_bytes()).ok()?;
    let body: Value = serde_json::from_slice(&plain).ok()?;
    if body.get("c")?.as_str()? != channel.name {
        return None;
    }
    let text = body.get("t")?.as_str()?;
    let at = body.get("at")?.as_f64()?;
    if !at.is_finite() || at <= 0.0 || js_trim(text).is_empty() || text.chars().count() > MAX_CHANNEL_TEXT {
        return None;
    }
    let contact = ContactCard::decode(body.get("card")?.as_str()?)?;
    if contact.uid.as_str() != blob.from || !verify_blob_signature(&blob, &contact.card.sign) {
        return None;
    }
    Some(ChannelMessage { channel: channel.name.clone(), text: text.to_owned(), at: at as i64, contact })
}
