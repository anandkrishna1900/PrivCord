//! Protocol v2 keys for sealed blobs (messages and signals that travel through relays while the other side is offline).
//!
//! Each device hands each contact, over the post-quantum link, two kinds of hybrid (P-256 + ML-KEM-768) public keys:
//! * one-time keys: a blob sealed to one is opened once and its private half is then erased, so a later compromise of
//!   the device cannot open it again (forward secrecy for every offline message);
//! * a standing key, replaced every week (the previous one is kept a while for late blobs): used when the one-time keys
//!   have run out, and for small signals.
//!
//! A v2 blob is: a fresh P-256 key, ECDH with the recipient key, ML-KEM encapsulation to the recipient key, both secrets
//! combined with the transcript ([`crate::pq::combine`]), AES-256-GCM over the padded payload, all signed by the
//! sender's identity key (as v1).

use crate::{
    aead,
    canonical::canonical_json,
    error::CryptoError,
    identity::{jwk_of, public_key_from_jwk, Identity},
    pq::{
        combine, kem_encapsulate, KemKeyPair, KEM_CIPHERTEXT_BYTES, KEM_PUBLIC_BYTES,
        KEM_SEED_BYTES,
    },
    pq_channel::{pad, unpad},
    rng::{random_array, random_secret_key, Entropy},
    seal::{signed_part, verify_blob_signature},
};
use p256::{ecdh::diffie_hellman, SecretKey};
use privcord_domain::{
    blob::{PublicJwk, SealedBlob, MAX_SEALED_BLOB_BYTES},
    codec, UserId,
};
use serde_json::{json, Value};
use zeroize::Zeroizing;

/// One of our own keys, with its private halves.
pub struct OwnKey {
    pub id: String,
    pub created_at: i64,
    dh: SecretKey,
    kem: KemKeyPair,
}

impl std::fmt::Debug for OwnKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OwnKey")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// Someone's public key, as they handed it to us.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerKey {
    pub id: String,
    pub dh: PublicJwk,
    pub kem: Vec<u8>,
}

impl PeerKey {
    pub fn to_value(&self) -> Value {
        json!({ "id": self.id, "dh": self.dh, "kem": codec::encode(&self.kem) })
    }

    /// `None` unless both keys are valid.
    pub fn from_value(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        let id = o.get("id")?.as_str()?;
        if id.is_empty() || id.len() > 64 {
            return None;
        }
        let dh = PublicJwk::from_value(o.get("dh")?)?;
        public_key_from_jwk(&dh).ok()?;
        let kem = codec::decode(o.get("kem")?.as_str()?).filter(|k| k.len() == KEM_PUBLIC_BYTES)?;
        Some(Self {
            id: id.to_owned(),
            dh,
            kem,
        })
    }
}

impl OwnKey {
    pub fn generate(entropy: &mut dyn Entropy, now: i64) -> Result<Self, CryptoError> {
        let id = codec::encode(&random_array::<12>(entropy)?);
        Ok(Self {
            id,
            created_at: now,
            dh: random_secret_key(entropy)?,
            kem: KemKeyPair::generate(entropy)?,
        })
    }

    pub fn public(&self) -> PeerKey {
        PeerKey {
            id: self.id.clone(),
            dh: jwk_of(&self.dh.public_key()),
            kem: self.kem.public().to_vec(),
        }
    }

    /// For our own storage only (private material).
    pub fn to_private_value(&self) -> Value {
        let scalar = Zeroizing::new(self.dh.to_bytes().to_vec());
        json!({ "id": self.id, "at": self.created_at, "dh": codec::encode(&scalar), "kem": codec::encode(self.kem.seed()) })
    }

    pub fn from_private_value(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        let scalar = Zeroizing::new(codec::decode(o.get("dh")?.as_str()?)?);
        let seed = Zeroizing::new(codec::decode(o.get("kem")?.as_str()?)?);
        let seed: &[u8; KEM_SEED_BYTES] = seed.as_slice().try_into().ok()?;
        Some(Self {
            id: o.get("id")?.as_str()?.to_owned(),
            created_at: o.get("at")?.as_i64()?,
            dh: SecretKey::from_slice(&scalar).ok()?,
            kem: KemKeyPair::from_seed(seed),
        })
    }
}

fn thumb(jwk: &PublicJwk) -> Result<String, CryptoError> {
    canonical_json(&json!({ "crv": jwk.crv, "kty": jwk.kty, "x": jwk.x, "y": jwk.y }))
}

fn blob_key(
    to: &str,
    from: &str,
    epk: &PublicJwk,
    key_id: &str,
    ecdh: &[u8],
    kem_ct: &[u8],
    kem_ss: &[u8; 32],
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    combine(
        "duocord-seal-v2",
        ecdh,
        &[kem_ss],
        &[
            to.as_bytes(),
            from.as_bytes(),
            thumb(epk)?.as_bytes(),
            key_id.as_bytes(),
            kem_ct,
        ],
    )
}

/// Seal `payload` to one of the recipient's v2 keys, signed by us.
pub fn seal_v2(
    identity: &Identity,
    to: &UserId,
    key: &PeerKey,
    payload: &Value,
    entropy: &mut dyn Entropy,
) -> Result<SealedBlob, CryptoError> {
    let from = identity.uid()?;
    let ephemeral = random_secret_key(entropy)?;
    let peer = public_key_from_jwk(&key.dh)?;
    let shared = diffie_hellman(ephemeral.to_nonzero_scalar(), peer.as_affine());
    let (kem_ct, kem_ss) = kem_encapsulate(&key.kem, entropy)?;
    let epk = jwk_of(&ephemeral.public_key());
    let aead_key = blob_key(
        to.as_str(),
        from.as_str(),
        &epk,
        &key.id,
        shared.raw_secret_bytes(),
        &kem_ct,
        &kem_ss,
    )?;
    let iv: [u8; 12] = random_array(entropy)?;
    let plaintext = serde_json::to_vec(payload).map_err(|_| CryptoError::Invalid)?;
    let ct = aead::encrypt(
        &aead_key[..],
        &iv,
        &pad(&plaintext),
        format!("{to}|{from}|v2").as_bytes(),
    )?;
    let mut blob = SealedBlob {
        v: 2,
        to: to.to_string(),
        from: from.to_string(),
        epk,
        iv: codec::encode(&iv),
        ct: codec::encode(&ct),
        sig: String::new(),
        kem: Some(codec::encode(&kem_ct)),
        key: Some(key.id.clone()),
    };
    blob.sig = codec::encode(&identity.sign_message(&signed_part(&blob)?));
    if blob.encode().encode_utf16().count() > MAX_SEALED_BLOB_BYTES {
        return Err(CryptoError::TooLarge);
    }
    Ok(blob)
}

/// Open a v2 blob with the key it names. `None` for anything not for us, not from the pinned sender, for another key,
/// or changed in transit.
pub fn open_v2(
    blob: &SealedBlob,
    own_uid: &UserId,
    own_key: &OwnKey,
    sender_sign: &PublicJwk,
    sender_uid: &UserId,
) -> Option<Value> {
    if blob.v != 2 || blob.to != own_uid.as_str() || blob.from != sender_uid.as_str() {
        return None;
    }
    if blob.key.as_deref() != Some(own_key.id.as_str()) || !verify_blob_signature(blob, sender_sign)
    {
        return None;
    }
    let kem_ct = codec::decode(blob.kem.as_deref()?).filter(|c| c.len() == KEM_CIPHERTEXT_BYTES)?;
    let kem_ss = own_key.kem.decapsulate(&kem_ct).ok()?;
    let peer = public_key_from_jwk(&blob.epk).ok()?;
    let shared = diffie_hellman(own_key.dh.to_nonzero_scalar(), peer.as_affine());
    let aead_key = blob_key(
        &blob.to,
        &blob.from,
        &blob.epk,
        &own_key.id,
        shared.raw_secret_bytes(),
        &kem_ct,
        &kem_ss,
    )
    .ok()?;
    let padded = aead::decrypt(
        &aead_key[..],
        &codec::decode(&blob.iv)?,
        &codec::decode(&blob.ct)?,
        format!("{}|{}|v2", blob.to, blob.from).as_bytes(),
    )
    .ok()?;
    serde_json::from_slice(unpad(&padded)?).ok()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use crate::rng::SeededEntropy;

    #[test]
    fn a_blob_sealed_to_a_key_opens_only_with_that_key_from_that_sender() {
        let mut rng = SeededEntropy::new("prekeys");
        let ann = Identity::generate(&mut rng).unwrap();
        let bob = Identity::generate(&mut rng).unwrap();
        let eve = Identity::generate(&mut rng).unwrap();
        let (au, bu) = (ann.uid().unwrap(), bob.uid().unwrap());
        let bob_key = OwnKey::generate(&mut rng, 1).unwrap();
        let other_key = OwnKey::generate(&mut rng, 1).unwrap();
        // The public half travels as JSON; the private half is stored and read back.
        let public = PeerKey::from_value(&bob_key.public().to_value()).unwrap();
        let stored = OwnKey::from_private_value(&bob_key.to_private_value()).unwrap();
        let payload = json!({ "t": "msg", "text": "hello ✓" });
        let blob = seal_v2(&ann, &bu, &public, &payload, &mut rng).unwrap();
        // It survives the trip as text.
        let blob = SealedBlob::decode(&blob.encode()).unwrap();
        assert_eq!(
            open_v2(&blob, &bu, &stored, &ann.sign_public(), &au),
            Some(payload)
        );
        // Wrong key, wrong sender, wrong recipient: nothing.
        assert!(open_v2(&blob, &bu, &other_key, &ann.sign_public(), &au).is_none());
        assert!(open_v2(&blob, &bu, &stored, &eve.sign_public(), &eve.uid().unwrap()).is_none());
        assert!(open_v2(&blob, &eve.uid().unwrap(), &stored, &ann.sign_public(), &au).is_none());
        // Any change in transit, including to the ML-KEM ciphertext or the key id, is refused.
        let flip = |s: &str| {
            let mut b = codec::decode(s).unwrap();
            b[5] ^= 1;
            codec::encode(&b)
        };
        for change in 0..4 {
            let mut b = blob.clone();
            match change {
                0 => b.ct = flip(&b.ct),
                1 => b.kem = Some(flip(b.kem.as_deref().unwrap())),
                2 => b.iv = flip(&b.iv),
                _ => b.key = Some(other_key.id.clone()),
            }
            assert!(
                open_v2(&b, &bu, &stored, &ann.sign_public(), &au).is_none(),
                "change {change}"
            );
        }
        // A bad public key is refused when it arrives.
        let mut bad = bob_key.public().to_value();
        bad["kem"] = json!(codec::encode(&[0u8; 10]));
        assert!(PeerKey::from_value(&bad).is_none());
    }
}
