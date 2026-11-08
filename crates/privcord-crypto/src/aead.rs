//! AES-256-GCM with a 12-byte nonce and a 16-byte tag, the way WebCrypto lays it out (ciphertext then tag).

use crate::error::CryptoError;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};

pub const KEY_BYTES: usize = 32;
pub const IV_BYTES: usize = 12;

pub fn encrypt(key: &[u8], iv: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if key.len() != KEY_BYTES || iv.len() != IV_BYTES {
        return Err(CryptoError::Encrypt);
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::Encrypt)?;
    cipher.encrypt(Nonce::from_slice(iv), Payload { msg: plaintext, aad }).map_err(|_| CryptoError::Encrypt)
}

/// `Decrypt` for a wrong key, a changed byte, wrong associated data or a bad length: they are not told apart.
pub fn decrypt(key: &[u8], iv: &[u8], ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if key.len() != KEY_BYTES || iv.len() != IV_BYTES {
        return Err(CryptoError::Decrypt);
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::Decrypt)?;
    cipher.decrypt(Nonce::from_slice(iv), Payload { msg: ciphertext, aad }).map_err(|_| CryptoError::Decrypt)
}
