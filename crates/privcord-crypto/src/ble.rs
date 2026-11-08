//! Rotating Bluetooth advertisement tags (docs/BLE_TRANSPORT.md section 3).
//! `HMAC-SHA-256(secret, "duochat-ble-tag-v1|" + epoch)` cut to 8 bytes; `secret` is the 32-byte contact ECDH secret.

use hmac::{Hmac, Mac};
use privcord_domain::ble::{ble_epoch, BLE_TAG_BYTES};
use sha2::Sha256;

use crate::CryptoError;

pub fn ble_tag(secret: &[u8], epoch: u64) -> Result<[u8; BLE_TAG_BYTES], CryptoError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(|_| CryptoError::Invalid)?;
    mac.update(format!("duochat-ble-tag-v1|{epoch}").as_bytes());
    let full = mac.finalize().into_bytes();
    let mut out = crate::kdf::blank::<BLE_TAG_BYTES>();
    out.copy_from_slice(full.get(..BLE_TAG_BYTES).ok_or(CryptoError::Invalid)?);
    Ok(out)
}

/// Tags a scanner should accept now: the previous, current and next epoch (clock skew up to one epoch).
pub fn ble_accept_tags(
    secret: &[u8],
    now_ms: u64,
) -> Result<Vec<[u8; BLE_TAG_BYTES]>, CryptoError> {
    let e = ble_epoch(now_ms);
    [e.saturating_sub(1), e, e + 1]
        .iter()
        .map(|x| ble_tag(secret, *x))
        .collect()
}
