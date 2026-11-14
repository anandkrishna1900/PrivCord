//! The account's self-mailbox (docs/design/syncengine.md §5): where the devices of one account leave each other their
//! sync entries on the relays, so two devices that are never online at the same time still catch up.
//!
//! Everything about it comes from the account's keys, which every device of the account holds:
//! * the **label** a relay sees changes every week and is a keyed hash, so a relay cannot tell two weeks' mailboxes
//!   belong to the same person (risk 25);
//! * the **contents** are encrypted under a key for that week, and signed with the account key, so a relay can neither
//!   read nor forge them.
//!
//! A device listens on this week's and last week's mailbox, so nothing posted just before the week turns is missed.

use crate::{
    aead,
    error::CryptoError,
    identity::Identity,
    kdf::hkdf_sha256,
    rng::{random_array, Entropy},
    seal::{placeholder_epk, sign_blob, verify_blob_signature},
};
use privcord_domain::{blob::SealedBlob, codec};
use serde_json::Value;
use zeroize::Zeroizing;

/// One mailbox per week.
pub const EPOCH_MS: i64 = 7 * 24 * 3600 * 1000;
/// The largest plaintext one blob carries (relays refuse large events; risk 3).
pub const MAX_PLAIN_BYTES: usize = 30 * 1024;

const SALT: &[u8] = b"duocord-self-mailbox-v1";

/// One week's mailbox: its label and its key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfBox {
    pub epoch: i64,
    pub label: String,
    key: Zeroizing<[u8; 32]>,
}

pub fn epoch_at(now: i64) -> i64 {
    now.div_euclid(EPOCH_MS)
}

impl SelfBox {
    pub fn for_epoch(account: &Identity, epoch: i64) -> Result<Self, CryptoError> {
        let s = account.export_for_storage();
        let mut ikm = Zeroizing::new([0u8; 64]);
        for (dst, src) in ikm.iter_mut().zip(s.sign.iter().chain(s.dh.iter())) {
            *dst = *src;
        }
        let label = hkdf_sha256::<16>(&*ikm, SALT, format!("label/{epoch}").as_bytes())?;
        let key = hkdf_sha256::<32>(&*ikm, SALT, format!("key/{epoch}").as_bytes())?;
        Ok(Self {
            epoch,
            label: format!("self-{}", codec::hex(&label)),
            key: Zeroizing::new(key),
        })
    }

    /// This week's and last week's.
    pub fn current(account: &Identity, now: i64) -> Result<[Self; 2], CryptoError> {
        let e = epoch_at(now);
        Ok([
            Self::for_epoch(account, e)?,
            Self::for_epoch(account, e - 1)?,
        ])
    }

    pub fn seal(
        &self,
        account: &Identity,
        payload: &Value,
        entropy: &mut dyn Entropy,
    ) -> Result<SealedBlob, CryptoError> {
        let plain = payload.to_string();
        if plain.len() > MAX_PLAIN_BYTES {
            return Err(CryptoError::TooLarge);
        }
        let iv: [u8; 12] = random_array(entropy)?;
        let ct = aead::encrypt(&*self.key, &iv, plain.as_bytes(), self.label.as_bytes())?;
        let mut blob = SealedBlob {
            v: 1,
            to: "self".into(),
            from: self.label.clone(),
            epk: placeholder_epk(entropy)?,
            iv: codec::encode(&iv),
            ct: codec::encode(&ct),
            sig: String::new(),
            kem: None,
            key: None,
        };
        blob.sig = sign_blob(account, &blob)?;
        Ok(blob)
    }

    /// The payload, if this blob was sealed for this mailbox by this account.
    pub fn open(&self, account: &Identity, blob: &SealedBlob) -> Option<Value> {
        if blob.to != "self"
            || blob.from != self.label
            || !verify_blob_signature(blob, &account.sign_public())
        {
            return None;
        }
        let plain = aead::decrypt(
            &*self.key,
            &codec::decode(&blob.iv)?,
            &codec::decode(&blob.ct)?,
            self.label.as_bytes(),
        )
        .ok()?;
        serde_json::from_slice(&plain).ok()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::rng::OsEntropy;
    use serde_json::json;

    #[test]
    fn devices_of_one_account_share_the_mailbox_and_nobody_else_can_read_or_forge_it() {
        let phrase = crate::identity::generate_recovery_phrase(&mut OsEntropy).unwrap();
        let phone = Identity::from_phrase(&phrase, "").unwrap();
        let laptop = Identity::from_phrase(&phrase, "").unwrap();
        let now = 1_700_000_000_000;
        let [a, _] = SelfBox::current(&phone, now).unwrap();
        let [b, _] = SelfBox::current(&laptop, now).unwrap();
        assert_eq!(a.label, b.label);
        let blob = a
            .seal(&phone, &json!({"t": "hello"}), &mut OsEntropy)
            .unwrap();
        let decoded = SealedBlob::decode(&blob.encode()).unwrap();
        assert_eq!(b.open(&laptop, &decoded), Some(json!({"t": "hello"})));

        let stranger = Identity::generate(&mut OsEntropy).unwrap();
        let theirs = SelfBox::for_epoch(&stranger, a.epoch).unwrap();
        assert_ne!(theirs.label, a.label);
        assert!(theirs.open(&stranger, &decoded).is_none());
        // A stranger sealing to our label with a guessed key, or their own signature, does not open.
        let mut forged = theirs
            .seal(&stranger, &json!({"t": "evil"}), &mut OsEntropy)
            .unwrap();
        forged.from = a.label.clone();
        assert!(a.open(&phone, &forged).is_none());
    }

    #[test]
    fn the_label_changes_every_week_and_last_week_is_still_read() {
        let id = Identity::generate(&mut OsEntropy).unwrap();
        let t = 1_700_000_000_000;
        let [this_week, last_week] = SelfBox::current(&id, t).unwrap();
        let [next_week, again] = SelfBox::current(&id, t + EPOCH_MS).unwrap();
        assert_ne!(this_week.label, last_week.label);
        assert_ne!(next_week.label, this_week.label);
        assert_eq!(again, this_week);
    }

    #[test]
    fn a_full_blob_fits_what_relays_accept() {
        // The DuoCord relay takes blobs up to 64 KiB; public Nostr relays commonly allow about as much.
        let id = Identity::generate(&mut OsEntropy).unwrap();
        let [b, _] = SelfBox::current(&id, 0).unwrap();
        let full = json!({"x": "é".repeat((MAX_PLAIN_BYTES - 64) / 2)});
        assert!(full.to_string().len() <= MAX_PLAIN_BYTES);
        let encoded = b.seal(&id, &full, &mut OsEntropy).unwrap().encode();
        assert!(encoded.len() < 64 * 1024, "{}", encoded.len());
    }

    #[test]
    fn oversized_payloads_are_refused() {
        let id = Identity::generate(&mut OsEntropy).unwrap();
        let [b, _] = SelfBox::current(&id, 0).unwrap();
        let big = json!({"x": "a".repeat(MAX_PLAIN_BYTES)});
        assert_eq!(
            b.seal(&id, &big, &mut OsEntropy),
            Err(CryptoError::TooLarge)
        );
    }
}
