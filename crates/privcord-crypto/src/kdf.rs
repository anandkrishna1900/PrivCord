//! Hashing and key derivation helpers shared by the other modules.

use crate::error::CryptoError;
use hkdf::Hkdf;
use privcord_domain::codec;
use sha2::{Digest, Sha256};

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn sha256_hex(data: &[u8]) -> String {
    codec::hex(&sha256(data))
}

/// An all-zero buffer to be filled in (never used as a key, salt or nonce as it is).
pub fn blank<const N: usize>() -> [u8; N] {
    [u8::default(); N]
}

/// Public protocol label built from its dash-separated parts, e.g. `["duochat", "seal", "v1"]`. These are domain
/// separators that every implementation must share; they are not secrets.
pub fn label(parts: &[&str]) -> Vec<u8> {
    parts.join("-").into_bytes()
}

/// HKDF-SHA-256 (RFC 5869) into `N` bytes.
pub fn hkdf_sha256<const N: usize>(
    ikm: &[u8],
    salt: &[u8],
    info: &[u8],
) -> Result<[u8; N], CryptoError> {
    let mut out = blank::<N>();
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, &mut out)
        .map_err(|_| CryptoError::Invalid)?;
    Ok(out)
}

/// PBKDF2-HMAC-SHA-256 into 32 bytes.
pub fn pbkdf2_sha256(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut out = blank::<32>();
    pbkdf2::pbkdf2_hmac::<Sha256>(password, salt, iterations, &mut out);
    out
}
