//! Safety numbers: six five-digit groups both people compare out loud (`safetyNumber.ts`). They detect a swapped
//! or mismatched key; they are not a substitute for an audited protocol. The apps feed it the two people's
//! signing keys (`contact.card.sign`), and so does this crate's test against the TypeScript vector.

use crate::{error::CryptoError, identity::public_key_from_jwk, kdf::sha256_hex};
use privcord_domain::blob::PublicJwk;

fn long_enough(jwk: &PublicJwk) -> bool {
    jwk.x.encode_utf16().count() >= 40 && jwk.y.encode_utf16().count() >= 40
}

fn thumbprint_hash(jwk: &PublicJwk) -> String {
    // `JSON.stringify({ crv, kty, x, y })`, in that order.
    let text = format!(r#"{{"crv":"{}","kty":"{}","x":"{}","y":"{}"}}"#, jwk.crv, jwk.kty, jwk.x, jwk.y);
    sha256_hex(text.as_bytes())
}

/// The number for two identity keys; the same for both people whichever order they are given in.
pub fn derive_safety_number(first: &PublicJwk, second: &PublicJwk) -> Result<String, CryptoError> {
    if !long_enough(first) || !long_enough(second) {
        return Err(CryptoError::InvalidKey);
    }
    public_key_from_jwk(first)?;
    public_key_from_jwk(second)?;
    let (a, b) = (thumbprint_hash(first), thumbprint_hash(second));
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let digest = crate::kdf::sha256(format!("{lo}|{hi}").as_bytes());
    let groups: Vec<String> = digest
        .chunks_exact(3)
        .take(6)
        .map(|c| {
            let v = c.iter().fold(0u32, |acc, byte| (acc << 8) | u32::from(*byte)) % 100_000;
            format!("{v:05}")
        })
        .collect();
    Ok(groups.join(" "))
}
