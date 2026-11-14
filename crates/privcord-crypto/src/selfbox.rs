//! The account's self-mailbox (docs/design/syncengine.md §5): where the devices of one account leave each other their
//! sync entries on the relays, so two devices that are never online at the same time still catch up.
//!
//! * It is keyed by the account's **sync key**, not by the account key. Every device of the account holds the sync key;
//!   only the device(s) holding the account key can sign the device list. A linked device gets the sync key from
//!   another device ([`seal_to_device`]), never the account key.
//! * The **label** a relay sees changes every week and is a keyed hash, so a relay cannot tell two weeks' mailboxes
//!   belong to the same person (risk 25). A device listens on this week's and last week's.
//! * The **contents** are encrypted under that week's key and **signed by the device** that posted them; the reader
//!   checks the signature against that device's key in the account-signed device list.
//!
//! The first sync key of an account (version 0) is derived from the account key, so installs restored from the
//! recovery phrase share it without asking anyone. Removing a device replaces it with a random one (step 9).

use crate::{
    aead,
    devices::DeviceEntry,
    error::CryptoError,
    identity::{uid_from_keys, Identity},
    kdf::{hkdf_sha256, sha256},
    rng::{random_array, Entropy},
    seal::{open, placeholder_epk, seal, sign_blob, verify_blob_signature},
};
use privcord_domain::{blob::SealedBlob, codec};
use serde_json::Value;
use zeroize::Zeroizing;

/// One mailbox per week.
pub const EPOCH_MS: i64 = 7 * 24 * 3600 * 1000;
/// The largest plaintext one blob carries (relays refuse large events; risk 3).
pub const MAX_PLAIN_BYTES: usize = 30 * 1024;

const SALT: &[u8] = b"duocord-self-mailbox-v1";

/// The key every device of an account shares for the self-mailbox. Not the account key: it cannot sign anything.
#[derive(Clone, PartialEq, Eq)]
pub struct SyncKey {
    /// Which sync key this is (0: derived from the account key; then one per replacement).
    pub version: u32,
    key: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for SyncKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SyncKey(v{})", self.version)
    }
}

impl SyncKey {
    /// Version 0, which every holder of the account key can derive.
    pub fn from_account(account: &Identity) -> Result<Self, CryptoError> {
        let s = account.export_for_storage();
        let mut ikm = Zeroizing::new([0u8; 64]);
        for (dst, src) in ikm.iter_mut().zip(s.sign.iter().chain(s.dh.iter())) {
            *dst = *src;
        }
        Ok(Self {
            version: 0,
            key: Zeroizing::new(hkdf_sha256::<32>(&*ikm, SALT, b"sync-key/v0")?),
        })
    }

    /// A fresh one (when a device is removed).
    pub fn random(version: u32, entropy: &mut dyn Entropy) -> Result<Self, CryptoError> {
        Ok(Self {
            version,
            key: Zeroizing::new(random_array::<32>(entropy)?),
        })
    }

    pub fn from_bytes(version: u32, bytes: &[u8]) -> Option<Self> {
        let key: [u8; 32] = bytes.try_into().ok()?;
        Some(Self {
            version,
            key: Zeroizing::new(key),
        })
    }

    /// For storage in the encrypted database and for handing to another device (sealed to it).
    pub fn to_bytes(&self) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(self.key.to_vec())
    }
}

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
    pub fn for_epoch(sync: &SyncKey, epoch: i64) -> Result<Self, CryptoError> {
        let v = sync.version;
        let label = hkdf_sha256::<16>(&*sync.key, SALT, format!("label/{v}/{epoch}").as_bytes())?;
        let key = hkdf_sha256::<32>(&*sync.key, SALT, format!("key/{v}/{epoch}").as_bytes())?;
        Ok(Self {
            epoch,
            label: format!("self-{}", codec::hex(&label)),
            key: Zeroizing::new(key),
        })
    }

    /// This week's and last week's.
    pub fn current(sync: &SyncKey, now: i64) -> Result<[Self; 2], CryptoError> {
        let e = epoch_at(now);
        Ok([Self::for_epoch(sync, e)?, Self::for_epoch(sync, e - 1)?])
    }

    /// Encrypts `payload` for this mailbox, signed by the posting device.
    pub fn seal(
        &self,
        device: &Identity,
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
        blob.sig = sign_blob(device, &blob)?;
        Ok(blob)
    }

    /// The payload, if this blob was sealed for this mailbox. Its signature is not checked here: the payload names the
    /// device that posted it, and the caller checks [`signed_by`] against that device's key from the account's list.
    pub fn open(&self, blob: &SealedBlob) -> Option<Value> {
        if blob.to != "self" || blob.from != self.label {
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

/// Was this blob signed by this device?
pub fn signed_by(blob: &SealedBlob, device: &DeviceEntry) -> bool {
    verify_blob_signature(blob, &device.sign)
}

/* ------------------------------------------------------------------ device inboxes */

/// The relay label where one device receives what other devices of its account seal to it (the sync key). Computed
/// from the device's public id, so a device that has no sync key yet can still be reached, and can reach the others.
pub fn device_inbox(device_id: &str) -> String {
    let h = sha256(format!("duocord-device-inbox\n{device_id}").as_bytes());
    format!("dev-{}", codec::hex(&h[..16]))
}

/// The id a device's keys give it when sealing: what `seal`/`open` call a uid.
fn device_uid(d: &DeviceEntry) -> Result<privcord_domain::UserId, CryptoError> {
    uid_from_keys(&d.sign, &d.dh)
}

/// Seals `payload` from one device to another device of the same account (only that device can open it, and it can
/// tell which device sent it).
pub fn seal_to_device(
    from: &Identity,
    to: &DeviceEntry,
    payload: &Value,
    entropy: &mut dyn Entropy,
) -> Result<SealedBlob, CryptoError> {
    seal(from, &device_uid(to)?, &to.dh, payload, entropy)
}

/// Opens what `from` sealed to this device (`own` its keys, `own_entry` its entry in the list).
pub fn open_from_device(
    blob: &SealedBlob,
    own: &Identity,
    own_entry: &DeviceEntry,
    from: &DeviceEntry,
) -> Option<Value> {
    open(
        blob,
        &device_uid(own_entry).ok()?,
        own,
        &from.sign,
        &device_uid(from).ok()?,
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::{devices::DeviceList, rng::OsEntropy};
    use serde_json::json;

    fn ident() -> Identity {
        Identity::generate(&mut OsEntropy).unwrap()
    }

    #[test]
    fn devices_with_the_sync_key_share_the_mailbox_and_each_post_is_signed_by_its_device() {
        let phrase = crate::identity::generate_recovery_phrase(&mut OsEntropy).unwrap();
        let account = Identity::from_phrase(&phrase, "").unwrap();
        // Restored from the phrase: the same version-0 sync key without asking anyone.
        assert_eq!(
            SyncKey::from_account(&account).unwrap(),
            SyncKey::from_account(&Identity::from_phrase(&phrase, "").unwrap()).unwrap()
        );
        let sync = SyncKey::from_account(&account).unwrap();
        let (phone, laptop) = (ident(), ident());
        let list = DeviceList::first(&account, &phone, "Phone", 1).unwrap();
        let phone_entry = list.devices[0].clone();
        let laptop_entry = DeviceEntry::new(&laptop, "Laptop", 1).unwrap();
        let now = 1_700_000_000_000;

        let [a, _] = SelfBox::current(&sync, now).unwrap();
        let blob = a
            .seal(&phone, &json!({"t": "hello"}), &mut OsEntropy)
            .unwrap();
        let decoded = SealedBlob::decode(&blob.encode()).unwrap();
        let [b, _] =
            SelfBox::current(&SyncKey::from_bytes(0, &sync.to_bytes()).unwrap(), now).unwrap();
        assert_eq!(b.open(&decoded), Some(json!({"t": "hello"})));
        assert!(signed_by(&decoded, &phone_entry));
        assert!(
            !signed_by(&decoded, &laptop_entry),
            "the signature names the device that posted it"
        );

        // Another key (another account, or after a replacement) neither finds nor opens it.
        let other = SyncKey::random(1, &mut OsEntropy).unwrap();
        let [o, _] = SelfBox::current(&other, now).unwrap();
        assert_ne!(o.label, a.label);
        let mut moved = decoded.clone();
        moved.from = o.label.clone();
        assert!(o.open(&moved).is_none());
    }

    #[test]
    fn the_label_changes_every_week_and_with_the_key() {
        let sync = SyncKey::random(0, &mut OsEntropy).unwrap();
        let t = 1_700_000_000_000;
        let [this_week, last_week] = SelfBox::current(&sync, t).unwrap();
        let [next_week, again] = SelfBox::current(&sync, t + EPOCH_MS).unwrap();
        assert_ne!(this_week.label, last_week.label);
        assert_ne!(next_week.label, this_week.label);
        assert_eq!(again, this_week);
        let replaced = SyncKey::from_bytes(1, &sync.to_bytes()).unwrap();
        assert_ne!(
            SelfBox::current(&replaced, t).unwrap()[0].label,
            this_week.label,
            "the version is part of it"
        );
    }

    #[test]
    fn a_full_blob_fits_what_relays_accept() {
        let sync = SyncKey::random(0, &mut OsEntropy).unwrap();
        let [b, _] = SelfBox::current(&sync, 0).unwrap();
        let full = json!({"x": "é".repeat((MAX_PLAIN_BYTES - 64) / 2)});
        assert!(full.to_string().len() <= MAX_PLAIN_BYTES);
        let encoded = b.seal(&ident(), &full, &mut OsEntropy).unwrap().encode();
        assert!(encoded.len() < 64 * 1024, "{}", encoded.len());
        let big = json!({"x": "a".repeat(MAX_PLAIN_BYTES)});
        assert_eq!(
            b.seal(&ident(), &big, &mut OsEntropy),
            Err(CryptoError::TooLarge)
        );
    }

    #[test]
    fn the_sync_key_is_handed_to_one_device_only() {
        let (phone, laptop, stranger) = (ident(), ident(), ident());
        let (pe, le, se) = (
            DeviceEntry::new(&phone, "Phone", 1).unwrap(),
            DeviceEntry::new(&laptop, "Laptop", 1).unwrap(),
            DeviceEntry::new(&stranger, "X", 1).unwrap(),
        );
        assert_ne!(device_inbox(&pe.id), device_inbox(&le.id));
        let sync = SyncKey::random(3, &mut OsEntropy).unwrap();
        let payload =
            json!({"t": "sync-key", "v": sync.version, "key": codec::encode(&sync.to_bytes())});
        let blob = seal_to_device(&phone, &le, &payload, &mut OsEntropy).unwrap();
        assert_eq!(open_from_device(&blob, &laptop, &le, &pe), Some(payload));
        assert!(
            open_from_device(&blob, &stranger, &se, &pe).is_none(),
            "not for anyone else"
        );
        assert!(
            open_from_device(&blob, &laptop, &le, &se).is_none(),
            "and it says who sent it"
        );
    }
}
