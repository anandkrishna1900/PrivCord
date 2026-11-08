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

const SEAL_SALT: &[u8] = b"duochat-seal-v1";
const MAILBOX_PREFIX: &str = "duochat-mailbox-v1|";

/// The bytes a blob's signature covers.
pub fn signed_part(blob: &SealedBlob) -> Result<Vec<u8>, CryptoError> {
    let v = json!({ "v": blob.v, "to": blob.to, "from": blob.from, "epk": thumb(&blob.epk), "iv": blob.iv, "ct": blob.ct });
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
        SEAL_SALT,
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
        SEAL_SALT,
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

/// A fresh throwaway key whose public half fills the `epk` slot of blobs that are not ECDH-sealed (invites, channels),
/// so they keep the shape every relay and client already validates.
pub(crate) fn placeholder_epk(entropy: &mut dyn Entropy) -> Result<PublicJwk, CryptoError> {
    Ok(jwk_of(&random_secret_key(entropy)?.public_key()))
}
