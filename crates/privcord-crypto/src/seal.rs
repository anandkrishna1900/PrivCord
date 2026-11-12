//! Sealed blobs: a signed, encrypted payload addressed to one contact. Relays only ever see this
//! (`connectivity/seal.ts`).
//!
//! ECDH (fresh ephemeral key) -> HKDF-SHA-256(salt `duochat-seal-v1`, info `to|from`) -> AES-256-GCM (aad `to|from`),
//! then ECDSA over the canonical JSON of everything but the signature.

use crate::{
    aead,
    canonical::canonical_json,
    error::CryptoError,
    identity::{jwk_of, public_key_from_jwk, thumb, verify_signature, Identity},
    kdf::{hkdf_sha256, sha256_hex},
    rng::{random_array, random_secret_key, Entropy},
};
use p256::ecdh::diffie_hellman;
use privcord_domain::{
    blob::{PublicJwk, SealedBlob, MAX_SEALED_BLOB_BYTES},
    codec,
    ids::UserId,
};
use serde_json::{json, Value};

fn seal_salt() -> Vec<u8> {
    crate::kdf::label(&["duochat", "seal", "v1"])
}
const MAILBOX_PREFIX: &str = "duochat-mailbox-v1|";

/// The bytes a blob's signature covers.
pub fn signed_part(blob: &SealedBlob) -> Result<Vec<u8>, CryptoError> {
    let mut v = json!({ "v": blob.v, "to": blob.to, "from": blob.from, "epk": thumb(&blob.epk), "iv": blob.iv, "ct": blob.ct });
    // v2 also signs the ML-KEM ciphertext and which key it was sealed to, so neither can be swapped in transit.
    if let (Some(kem), Some(key), Some(o)) = (&blob.kem, &blob.key, v.as_object_mut()) {
        o.insert("kem".into(), json!(kem));
        o.insert("key".into(), json!(key));
    }
    Ok(canonical_json(&v)?.into_bytes())
}

/// Where a client publishes to and listens on. Hashing keeps the uid out of relay logs.
pub fn mailbox_for(uid: &str) -> String {
    sha256_hex(format!("{MAILBOX_PREFIX}{uid}").as_bytes())
}

/// Seal `payload` for one contact, signed by `identity`.
pub fn seal(
    identity: &Identity,
    to: &UserId,
    to_dh: &PublicJwk,
    payload: &Value,
    entropy: &mut dyn Entropy,
) -> Result<SealedBlob, CryptoError> {
    let from = identity.uid()?;
    let ephemeral = random_secret_key(entropy)?;
    let peer = public_key_from_jwk(to_dh)?;
    let shared = diffie_hellman(ephemeral.to_nonzero_scalar(), peer.as_affine());
    let key = hkdf_sha256::<32>(
        shared.raw_secret_bytes(),
        &seal_salt(),
        format!("{to}|{from}").as_bytes(),
    )?;
    let iv: [u8; 12] = random_array(entropy)?;
    let plaintext = serde_json::to_vec(payload).map_err(|_| CryptoError::Invalid)?;
    let ct = aead::encrypt(&key, &iv, &plaintext, format!("{to}|{from}").as_bytes())?;
    let mut blob = SealedBlob {
        v: 1,
        to: to.to_string(),
        from: from.to_string(),
        epk: jwk_of(&ephemeral.public_key()),
        iv: codec::encode(&iv),
        ct: codec::encode(&ct),
        sig: String::new(),
        kem: None,
        key: None,
    };
    blob.sig = codec::encode(&identity.sign_message(&signed_part(&blob)?));
    if blob.encode().encode_utf16().count() > MAX_SEALED_BLOB_BYTES {
        return Err(CryptoError::TooLarge);
    }
    Ok(blob)
}

/// Signs a blob that is not ECDH-sealed (invite and channel blobs keep the same shape).
pub fn sign_blob(identity: &Identity, unsigned: &SealedBlob) -> Result<String, CryptoError> {
    Ok(codec::encode(
        &identity.sign_message(&signed_part(unsigned)?),
    ))
}

pub fn verify_blob_signature(blob: &SealedBlob, sign_pub: &PublicJwk) -> bool {
    let (Some(sig), Ok(part)) = (codec::decode(&blob.sig), signed_part(blob)) else {
        return false;
    };
    verify_signature(sign_pub, &sig, &part)
}

/// The payload, or `None` for anything not addressed to us, not from the pinned sender, or changed in transit.
pub fn open(
    blob: &SealedBlob,
    own_uid: &UserId,
    own: &Identity,
    sender_sign: &PublicJwk,
    sender_uid: &UserId,
) -> Option<Value> {
    if blob.v != 1 || blob.to != own_uid.as_str() || blob.from != sender_uid.as_str() {
        return None;
    }
    if !verify_blob_signature(blob, sender_sign) {
        return None;
    }
    let shared = own.agree(&blob.epk).ok()?;
    let key = hkdf_sha256::<32>(
        &*shared,
        &seal_salt(),
        format!("{}|{}", blob.to, blob.from).as_bytes(),
    )
    .ok()?;
    let plain = aead::decrypt(
        &key,
        &codec::decode(&blob.iv)?,
        &codec::decode(&blob.ct)?,
        format!("{}|{}", blob.to, blob.from).as_bytes(),
    )
    .ok()?;
    serde_json::from_slice(&plain).ok()
}

/// Open a blob from someone who is not a contact yet: a friend request after they added us from our card (a QR code).
/// The payload must carry their contact card under `"card"`. Their identity is taken from that card (its proof binds the
/// signing key to the key the uid comes from) and must be the blob's sender; only then is the signature checked with the
/// card's own key. So a request can only come from whoever holds that identity's private keys.
pub fn open_from_stranger(
    blob: &SealedBlob,
    own_uid: &UserId,
    own: &Identity,
) -> Option<(crate::card::Contact, Value)> {
    if blob.v != 1 || blob.to != own_uid.as_str() {
        return None;
    }
    let shared = own.agree(&blob.epk).ok()?;
    let key = hkdf_sha256::<32>(
        &*shared,
        &seal_salt(),
        format!("{}|{}", blob.to, blob.from).as_bytes(),
    )
    .ok()?;
    let plain = aead::decrypt(
        &key,
        &codec::decode(&blob.iv)?,
        &codec::decode(&blob.ct)?,
        format!("{}|{}", blob.to, blob.from).as_bytes(),
    )
    .ok()?;
    let payload: Value = serde_json::from_slice(&plain).ok()?;
    let contact = crate::card::ContactCard::decode(payload.get("card")?.as_str()?)?;
    if contact.uid.as_str() != blob.from || !verify_blob_signature(blob, &contact.card.sign) {
        return None;
    }
    Some((contact, payload))
}

/// A fresh throwaway key whose public half fills the `epk` slot of blobs that are not ECDH-sealed (invites, channels),
/// so they keep the shape every relay and client already validates.
pub(crate) fn placeholder_epk(entropy: &mut dyn Entropy) -> Result<PublicJwk, CryptoError> {
    Ok(jwk_of(&random_secret_key(entropy)?.public_key()))
}
