//! Encrypted backups (`backup.ts`): a passphrase-protected text file. A wrong passphrase and a damaged file look the same.

use crate::{
    aead,
    error::CryptoError,
    kdf::pbkdf2_sha256,
    rng::{random_array, Entropy},
};
use privcord_domain::codec;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

pub const BACKUP_PREFIX: &str = "PRIVCORD-BACKUP1:";
pub const BACKUP_MIN_PASSPHRASE: usize = 8;
const ITERATIONS: u32 = 300_000;
const AAD: &[u8] = b"privcord-backup-v1";

fn key_from(passphrase: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let normalised: String = passphrase.nfkc().collect();
    pbkdf2_sha256(normalised.as_bytes(), salt, iterations)
}

pub fn seal_backup(data: &Value, passphrase: &str, entropy: &mut dyn Entropy) -> Result<String, CryptoError> {
    if passphrase.encode_utf16().count() < BACKUP_MIN_PASSPHRASE {
        return Err(CryptoError::WeakPassphrase(BACKUP_MIN_PASSPHRASE));
    }
    let salt: [u8; 16] = random_array(entropy)?;
    let iv: [u8; 12] = random_array(entropy)?;
    let key = key_from(passphrase, &salt, ITERATIONS);
    let ct = aead::encrypt(&key, &iv, data.to_string().as_bytes(), AAD)?;
    // Written as text in this key order, as the TypeScript code does.
    let body = format!(
        r#"{{"v":1,"it":{ITERATIONS},"salt":"{}","iv":"{}","ct":"{}"}}"#,
        codec::encode(&salt),
        codec::encode(&iv),
        codec::encode(&ct)
    );
    Ok(format!("{BACKUP_PREFIX}{}", codec::encode(body.as_bytes())))
}

pub fn open_backup(text: &str, passphrase: &str) -> Option<Value> {
    let trimmed = privcord_domain::text::js_trim(text);
    let body: Value = serde_json::from_slice(&codec::decode(trimmed.strip_prefix(BACKUP_PREFIX)?)?).ok()?;
    if body.get("v")?.as_u64()? != 1 {
        return None;
    }
    let it = body.get("it")?.as_f64()?;
    if it.fract() != 0.0 || !(100_000.0..=2_000_000.0).contains(&it) {
        return None;
    }
    let salt = codec::decode(body.get("salt")?.as_str()?)?;
    let iv = codec::decode(body.get("iv")?.as_str()?)?;
    let ct = codec::decode(body.get("ct")?.as_str()?)?;
    let key = key_from(passphrase, &salt, it as u32);
    let plain = aead::decrypt(&key, &iv, &ct, AAD).ok()?;
    serde_json::from_slice(&plain).ok()
}
