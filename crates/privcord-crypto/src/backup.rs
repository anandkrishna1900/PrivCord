//! Encrypted backups: a passphrase-protected text file. A wrong passphrase and a damaged file look the same.
//!
//! v2 (written now) derives the key with Argon2id, which costs an attacker memory as well as time, so guessing a
//! passphrase of a leaked backup on graphics cards is expensive. v1 (PBKDF2-SHA256, `backup.ts`) is still read, so
//! older backups open.

use crate::{
    aead,
    error::CryptoError,
    kdf::pbkdf2_sha256,
    rng::{random_array, Entropy},
};
use privcord_domain::codec;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

pub const BACKUP_PREFIX: &str = "PRIVCORD-BACKUP1:";
pub const BACKUP_MIN_PASSPHRASE: usize = 12;
const ITERATIONS: u32 = 300_000;
const AAD: &[u8] = b"privcord-backup-v1";
const AAD_V2: &[u8] = b"privcord-backup-v2";
/// Argon2id: 64 MiB, 3 passes, 1 lane (about a second on a phone).
const M_KIB: u32 = 64 * 1024;
const T_COST: u32 = 3;
const P_COST: u32 = 1;
/// The most a backup file may ask for when it is opened (a crafted file must not tie up the phone).
const MAX_M_KIB: u32 = 256 * 1024;
const MAX_T_COST: u32 = 10;
const MAX_P_COST: u32 = 4;

fn normalised(passphrase: &str) -> Zeroizing<String> {
    Zeroizing::new(passphrase.nfkc().collect())
}

fn key_from(passphrase: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    pbkdf2_sha256(normalised(passphrase).as_bytes(), salt, iterations)
}

fn argon2_key(
    passphrase: &str,
    salt: &[u8],
    m: u32,
    t: u32,
    p: u32,
) -> Option<Zeroizing<[u8; 32]>> {
    let params = argon2::Params::new(m, t, p, Some(32)).ok()?;
    let a = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    a.hash_password_into(normalised(passphrase).as_bytes(), salt, &mut *key)
        .ok()?;
    Some(key)
}

/// Seal `data` as a v2 backup (Argon2id).
pub fn seal_backup(
    data: &Value,
    passphrase: &str,
    entropy: &mut dyn Entropy,
) -> Result<String, CryptoError> {
    if passphrase.encode_utf16().count() < BACKUP_MIN_PASSPHRASE {
        return Err(CryptoError::WeakPassphrase(BACKUP_MIN_PASSPHRASE));
    }
    let salt: [u8; 16] = random_array(entropy)?;
    let iv: [u8; 12] = random_array(entropy)?;
    let key = argon2_key(passphrase, &salt, M_KIB, T_COST, P_COST).ok_or(CryptoError::Invalid)?;
    let ct = aead::encrypt(&*key, &iv, data.to_string().as_bytes(), AAD_V2)?;
    let body = format!(
        r#"{{"v":2,"kdf":"argon2id","m":{M_KIB},"t":{T_COST},"p":{P_COST},"salt":"{}","iv":"{}","ct":"{}"}}"#,
        codec::encode(&salt),
        codec::encode(&iv),
        codec::encode(&ct)
    );
    Ok(format!("{BACKUP_PREFIX}{}", codec::encode(body.as_bytes())))
}

/// A v1 backup (PBKDF2), as the TypeScript code and older versions make them. Only for test vectors that other
/// implementations must open; the apps write v2.
#[doc(hidden)]
pub fn seal_backup_v1(
    data: &Value,
    passphrase: &str,
    entropy: &mut dyn Entropy,
) -> Result<String, CryptoError> {
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
    let body: Value =
        serde_json::from_slice(&codec::decode(trimmed.strip_prefix(BACKUP_PREFIX)?)?).ok()?;
    let salt = codec::decode(body.get("salt")?.as_str()?)?;
    let iv = codec::decode(body.get("iv")?.as_str()?)?;
    let ct = codec::decode(body.get("ct")?.as_str()?)?;
    let plain = match body.get("v")?.as_u64()? {
        1 => {
            let it = body.get("it")?.as_f64()?;
            if it.fract() != 0.0 || !(100_000.0..=2_000_000.0).contains(&it) {
                return None;
            }
            let key = key_from(passphrase, &salt, it as u32);
            aead::decrypt(&key, &iv, &ct, AAD).ok()?
        }
        2 => {
            if body.get("kdf")?.as_str()? != "argon2id" || salt.len() < 16 {
                return None;
            }
            let num = |k: &str| body.get(k)?.as_u64().and_then(|n| u32::try_from(n).ok());
            let (m, t, p) = (num("m")?, num("t")?, num("p")?);
            if m > MAX_M_KIB || t > MAX_T_COST || p == 0 || p > MAX_P_COST {
                return None;
            }
            let key = argon2_key(passphrase, &salt, m, t, p)?;
            aead::decrypt(&*key, &iv, &ct, AAD_V2).ok()?
        }
        _ => return None,
    };
    serde_json::from_slice(&plain).ok()
}
