//! Identity: two P-256 keys (one signs, one agrees on secrets), restored from a 12-word recovery phrase.
//!
//! Derivation (docs/IDENTITY_AND_RECOVERY.md, identical on every platform): BIP-39 seed (PBKDF2-HMAC-SHA-512,
//! 2048 rounds, optional passphrase) -> HKDF-SHA-256 with a fixed salt and a per-purpose label -> the 32 bytes taken
//! modulo the curve order become the private scalars. The phrase is never used directly as a key.

use crate::{
    canonical::canonical_json,
    error::CryptoError,
    kdf::hkdf_sha256,
    rng::{Entropy, RngAdapter},
};
use p256::{
    ecdh::diffie_hellman,
    ecdsa::{
        signature::{Signer, Verifier},
        Signature, SigningKey, VerifyingKey,
    },
    elliptic_curve::{ops::Reduce, sec1::ToEncodedPoint},
    EncodedPoint, FieldBytes, NonZeroScalar, PublicKey, Scalar, SecretKey,
};
use privcord_domain::{blob::PublicJwk, codec, ids::UserId};
use serde_json::json;
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, Zeroizing};

pub const REQUIRED_WORDS: usize = 12;
const DERIVE_SALT: &[u8] = b"DuoChat-Recovery-Trust-v1";
const DERIVE_PREFIX: &str = "duochat-derive-v1";
const IDENTITY_PROOF_PREFIX: &str = "duochat-identity-proof-v1\n";

/// Why a recovery phrase was refused. `Display` gives the text shown to a person.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PhraseError {
    #[error("Enter your recovery phrase.")]
    Empty,
    #[error("A recovery phrase must be exactly 12 words.")]
    WrongWordCount,
    #[error("This phrase does not match the DuoChat word list or checksum.")]
    NotValid,
}

fn canonical_phrase(phrase: &str) -> String {
    phrase
        .trim_matches(privcord_domain::text::is_js_whitespace)
        .to_lowercase()
}

/// Word count, word list and checksum, without deriving anything. Words must be separated by single spaces (after
/// trimming), exactly as the TypeScript checker requires.
pub fn validate_recovery_phrase(phrase: &str) -> Result<(), PhraseError> {
    let trimmed = canonical_phrase(phrase);
    if trimmed.is_empty() {
        return Err(PhraseError::Empty);
    }
    let count = trimmed
        .split(privcord_domain::text::is_js_whitespace)
        .filter(|w| !w.is_empty())
        .count();
    if count != REQUIRED_WORDS {
        return Err(PhraseError::WrongWordCount);
    }
    let words: Vec<&str> = trimmed.split(' ').collect();
    if words.len() != REQUIRED_WORDS || words.iter().any(|w| w.is_empty()) {
        return Err(PhraseError::NotValid);
    }
    bip39::Mnemonic::parse_in_normalized(bip39::Language::English, &words.join(" "))
        .map(|_| ())
        .map_err(|_| PhraseError::NotValid)
}

/// A new 12-word phrase from 128 bits of entropy.
pub fn generate_recovery_phrase(
    entropy: &mut dyn Entropy,
) -> Result<Zeroizing<String>, CryptoError> {
    let mut bytes = [0u8; 16];
    entropy.fill(&mut bytes)?;
    let m = bip39::Mnemonic::from_entropy_in(bip39::Language::English, &bytes)
        .map_err(|_| CryptoError::Invalid);
    bytes.zeroize();
    Ok(Zeroizing::new(m?.to_string()))
}

/// The BIP-39 seed for a phrase (identical across platforms for the same phrase and passphrase).
pub fn derive_seed(phrase: &str, passphrase: &str) -> Result<Zeroizing<[u8; 64]>, CryptoError> {
    validate_recovery_phrase(phrase).map_err(|_| CryptoError::InvalidPhrase)?;
    let m = bip39::Mnemonic::parse_in_normalized(
        bip39::Language::English,
        &canonical_phrase(phrase)
            .split(' ')
            .collect::<Vec<_>>()
            .join(" "),
    )
    .map_err(|_| CryptoError::InvalidPhrase)?;
    let pass: String = passphrase.nfkd().collect();
    Ok(Zeroizing::new(m.to_seed_normalized(&pass)))
}

/// What a derived key is for. Distinct purposes give unrelated keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    IdentitySign,
    IdentityAgreement,
}

impl Purpose {
    fn label(self) -> &'static str {
        match self {
            Self::IdentitySign => "identity-sign",
            Self::IdentityAgreement => "identity-agreement",
        }
    }
}

/// 32 bytes of key material for one purpose.
pub fn derive_key_material(
    seed: &[u8],
    purpose: Purpose,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let info = format!("{DERIVE_PREFIX}/{}", purpose.label());
    Ok(Zeroizing::new(hkdf_sha256::<32>(
        seed,
        DERIVE_SALT,
        info.as_bytes(),
    )?))
}

fn secret_from_material(material: &[u8; 32]) -> Result<SecretKey, CryptoError> {
    let scalar = <Scalar as Reduce<p256::U256>>::reduce_bytes(FieldBytes::from_slice(material));
    let nonzero: Option<NonZeroScalar> = NonZeroScalar::new(scalar).into();
    nonzero.map(SecretKey::from).ok_or(CryptoError::InvalidKey)
}

pub(crate) fn jwk_of(public: &PublicKey) -> PublicJwk {
    let point = public.to_encoded_point(false);
    let x = point.x().map(|v| codec::encode(v)).unwrap_or_default();
    let y = point.y().map(|v| codec::encode(v)).unwrap_or_default();
    PublicJwk::p256(x, y)
}

/// The key a JWK describes. Fails unless both coordinates are 32 bytes and the point is on the curve.
pub fn public_key_from_jwk(jwk: &PublicJwk) -> Result<PublicKey, CryptoError> {
    if jwk.kty != "EC" || jwk.crv != "P-256" {
        return Err(CryptoError::InvalidKey);
    }
    let x = codec::decode(&jwk.x)
        .filter(|b| b.len() == 32)
        .ok_or(CryptoError::InvalidKey)?;
    let y = codec::decode(&jwk.y)
        .filter(|b| b.len() == 32)
        .ok_or(CryptoError::InvalidKey)?;
    let point = EncodedPoint::from_affine_coordinates(
        FieldBytes::from_slice(&x),
        FieldBytes::from_slice(&y),
        false,
    );
    PublicKey::from_sec1_bytes(point.as_bytes()).map_err(|_| CryptoError::InvalidKey)
}

pub(crate) fn thumb(jwk: &PublicJwk) -> serde_json::Value {
    json!({ "kty": jwk.kty, "crv": jwk.crv, "x": jwk.x, "y": jwk.y })
}

fn identity_proof_payload(dh: &PublicJwk) -> Result<Vec<u8>, CryptoError> {
    Ok(format!("{IDENTITY_PROOF_PREFIX}{}", canonical_json(&thumb(dh))?).into_bytes())
}

/// The person's id: SHA-256 of `EC|P-256|<x bytes>|<y bytes>` in lower-case hex.
pub fn uid_from_dh(dh: &PublicJwk) -> Result<UserId, CryptoError> {
    let x = codec::decode(&dh.x).ok_or(CryptoError::InvalidKey)?;
    let y = codec::decode(&dh.y).ok_or(CryptoError::InvalidKey)?;
    let mut input = format!("{}|{}|", dh.kty, dh.crv).into_bytes();
    input.extend_from_slice(&x);
    input.push(b'|');
    input.extend_from_slice(&y);
    UserId::new(crate::kdf::sha256_hex(&input)).map_err(|_| CryptoError::InvalidKey)
}

/// ECDSA P-256 / SHA-256 signature check; the signature is the 64-byte `r || s` form WebCrypto produces.
pub fn verify_signature(public: &PublicJwk, signature: &[u8], message: &[u8]) -> bool {
    let Ok(key) = public_key_from_jwk(public) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(signature) else {
        return false;
    };
    VerifyingKey::from(&key).verify(message, &sig).is_ok()
}

/// Checks that an ECDH key and a signing key belong together (the owner signed the ECDH key).
pub fn verify_identity_proof(sign: &PublicJwk, dh: &PublicJwk, proof_b64: &str) -> bool {
    let Some(sig) = codec::decode(proof_b64) else {
        return false;
    };
    let Ok(payload) = identity_proof_payload(dh) else {
        return false;
    };
    verify_signature(sign, &sig, &payload)
}

/// A shared secret from key agreement. Wiped when dropped.
pub type SharedSecret = Zeroizing<[u8; 32]>;

/// Both keys of one person.
pub struct Identity {
    sign: SigningKey,
    dh: SecretKey,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never prints key material.
        f.debug_struct("Identity")
            .field(
                "uid",
                &self.uid().map(|u| u.to_string()).unwrap_or_default(),
            )
            .finish_non_exhaustive()
    }
}

/// The private scalars, for the secure-storage adapter only. Wiped when dropped. Never put this in a log or an FFI type.
#[derive(Zeroize, zeroize::ZeroizeOnDrop)]
pub struct StoredSecrets {
    pub sign: [u8; 32],
    pub dh: [u8; 32],
}

impl std::fmt::Debug for StoredSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StoredSecrets(..)")
    }
}

impl Identity {
    /// Restore the identity a phrase (and optional BIP-39 passphrase) always produces.
    pub fn from_phrase(phrase: &str, passphrase: &str) -> Result<Self, CryptoError> {
        let seed = derive_seed(phrase, passphrase)?;
        let sign = secret_from_material(&*derive_key_material(&*seed, Purpose::IdentitySign)?)?;
        let dh = secret_from_material(&*derive_key_material(&*seed, Purpose::IdentityAgreement)?)?;
        Ok(Self {
            sign: SigningKey::from(&sign),
            dh,
        })
    }

    /// A fresh random identity (not recoverable from a phrase).
    pub fn generate(entropy: &mut dyn Entropy) -> Result<Self, CryptoError> {
        let mut a = RngAdapter(entropy);
        let sign = SecretKey::random(&mut a);
        let dh = SecretKey::random(&mut a);
        Ok(Self {
            sign: SigningKey::from(&sign),
            dh,
        })
    }

    /// Rebuild from scalars read back from secure storage.
    pub fn from_stored(secrets: &StoredSecrets) -> Result<Self, CryptoError> {
        let sign = SecretKey::from_slice(&secrets.sign).map_err(|_| CryptoError::InvalidKey)?;
        let dh = SecretKey::from_slice(&secrets.dh).map_err(|_| CryptoError::InvalidKey)?;
        Ok(Self {
            sign: SigningKey::from(&sign),
            dh,
        })
    }

    /// For the secure-storage adapter only.
    pub fn export_for_storage(&self) -> StoredSecrets {
        let mut s = [0u8; 32];
        let mut d = [0u8; 32];
        s.copy_from_slice(&self.sign.to_bytes());
        d.copy_from_slice(&self.dh.to_bytes());
        StoredSecrets { sign: s, dh: d }
    }

    pub fn sign_public(&self) -> PublicJwk {
        jwk_of(&PublicKey::from(self.sign.verifying_key()))
    }

    pub fn dh_public(&self) -> PublicJwk {
        jwk_of(&self.dh.public_key())
    }

    pub fn uid(&self) -> Result<UserId, CryptoError> {
        uid_from_dh(&self.dh_public())
    }

    /// The self-signature that binds the ECDH key to the signing key, as base64url.
    pub fn identity_proof(&self) -> Result<String, CryptoError> {
        let sig = self.sign_message(&identity_proof_payload(&self.dh_public())?);
        Ok(codec::encode(&sig))
    }

    /// ECDSA P-256 / SHA-256, 64-byte `r || s`. Deterministic (RFC 6979), so it needs no randomness.
    pub fn sign_message(&self, message: &[u8]) -> [u8; 64] {
        let sig: Signature = self.sign.sign(message);
        let mut out = [0u8; 64];
        out.copy_from_slice(&sig.to_bytes());
        out
    }

    /// ECDH with a peer's public key: the shared x coordinate, the same bytes WebCrypto's `deriveBits` returns.
    pub fn agree(&self, peer_dh: &PublicJwk) -> Result<SharedSecret, CryptoError> {
        let peer = public_key_from_jwk(peer_dh)?;
        let shared = diffie_hellman(self.dh.to_nonzero_scalar(), peer.as_affine());
        let mut out = [0u8; 32];
        out.copy_from_slice(shared.raw_secret_bytes());
        Ok(Zeroizing::new(out))
    }

    /// A short public fingerprint shown after recovery (not the uid): SHA-256 of `{"kty","crv","x","y"}` as JSON text in
    /// that key order, which is what the TypeScript code hashes.
    pub fn recovery_fingerprint(&self) -> String {
        let dh = self.dh_public();
        let text = format!(
            r#"{{"kty":"{}","crv":"{}","x":"{}","y":"{}"}}"#,
            dh.kty, dh.crv, dh.x, dh.y
        );
        crate::kdf::sha256_hex(text.as_bytes())
    }
}
