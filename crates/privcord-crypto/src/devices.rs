//! One account, several devices (docs/design/syncengine.md §2).
//!
//! The account is the identity a person already has (derived from their recovery phrase); friends know them by its
//! uid. Each device has keys of its own, and the account signs a **device list**: which device keys belong to it. Only
//! the account key can change the list, so a friend (or one of the person's own devices) believes a device only if
//! the account vouches for it.
//!
//! The list only grows: a removed device stays in it, marked removed, so its id can never be reused (a device that is
//! linked again gets new keys and a new id) and nobody can quietly bring it back.
//!
//! [`link`] is how a new device joins: a QR code from a device already in the account, a short code both screens show
//! and the person compares, then the signed list.

use crate::{
    canonical::canonical_json,
    error::CryptoError,
    identity::{uid_from_keys, verify_signature, Identity},
    kdf::sha256,
};
use privcord_domain::{blob::PublicJwk, codec};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Most devices one account may have at once (risk 106).
pub const MAX_DEVICES: usize = 5;
/// Longest device name, in characters.
pub const MAX_NAME_CHARS: usize = 64;
/// Most entries a list may hold, removed ones included (a bound for anything read from the network).
pub const MAX_ENTRIES: usize = 64;

const LIST_TAG: &str = "duocord-devices-v1";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DeviceError {
    #[error("The device list is not signed by this account.")]
    BadSignature,
    #[error("The device list is malformed.")]
    Malformed,
    #[error("This account already has the most devices it can have.")]
    TooMany,
    #[error("That device is already in the list.")]
    AlreadyListed,
    #[error("There is no such device.")]
    Unknown,
    #[error("That is an older device list.")]
    Stale,
    #[error("The new device list rewrites the old one.")]
    Rewritten,
    #[error("{0}")]
    Crypto(#[from] CryptoError),
}

/// A device's id: a hash of its own keys, separate from any user id.
pub fn device_id(sign: &PublicJwk, dh: &PublicJwk) -> Result<String, CryptoError> {
    let sign = canonical_json(&serde_json::to_value(sign).map_err(|_| CryptoError::Canonical)?)?;
    let dh = canonical_json(&serde_json::to_value(dh).map_err(|_| CryptoError::Canonical)?)?;
    let digest = sha256(format!("duocord-device-v1\n{sign}\n{dh}").as_bytes());
    Ok(codec::hex(&digest[..16]))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceEntry {
    pub id: String,
    pub sign: PublicJwk,
    pub dh: PublicJwk,
    pub name: String,
    pub added_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_at: Option<i64>,
}

impl DeviceEntry {
    pub fn new(device: &Identity, name: &str, now: i64) -> Result<Self, CryptoError> {
        Ok(Self {
            id: device_id(&device.sign_public(), &device.dh_public())?,
            sign: device.sign_public(),
            dh: device.dh_public(),
            name: clean_name(name),
            added_at: now,
            removed_at: None,
        })
    }

    pub fn active(&self) -> bool {
        self.removed_at.is_none()
    }
}

fn clean_name(name: &str) -> String {
    let one_line: String = name.chars().filter(|c| !c.is_control()).collect();
    let trimmed = one_line.trim();
    let name = if trimmed.is_empty() {
        "Device"
    } else {
        trimmed
    };
    name.chars().take(MAX_NAME_CHARS).collect()
}

/// The account-signed list of the account's devices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceList {
    /// The account's uid.
    pub account: String,
    /// Goes up by one with every change.
    pub version: u64,
    pub devices: Vec<DeviceEntry>,
    /// The account's signature over everything above, base64url.
    pub sig: String,
}

impl DeviceList {
    fn payload(
        account: &str,
        version: u64,
        devices: &[DeviceEntry],
    ) -> Result<Vec<u8>, CryptoError> {
        let value = json!({
            "t": LIST_TAG,
            "account": account,
            "version": version,
            "devices": serde_json::to_value(devices).map_err(|_| CryptoError::Canonical)?,
        });
        Ok(canonical_json(&value)?.into_bytes())
    }

    fn signed(
        account: &Identity,
        version: u64,
        devices: Vec<DeviceEntry>,
    ) -> Result<Self, DeviceError> {
        let uid = account.uid()?.to_string();
        let sig = codec::encode(&account.sign_message(&Self::payload(&uid, version, &devices)?));
        let list = Self {
            account: uid,
            version,
            devices,
            sig,
        };
        list.check_shape()?;
        Ok(list)
    }

    /// The list an account starts with: the device it is on now. This is also how an existing install moves to
    /// devices: its identity becomes the account and the phone or PC it runs on, the first device.
    pub fn first(
        account: &Identity,
        device: &Identity,
        name: &str,
        now: i64,
    ) -> Result<Self, DeviceError> {
        Self::signed(account, 1, vec![DeviceEntry::new(device, name, now)?])
    }

    pub fn active(&self) -> impl Iterator<Item = &DeviceEntry> {
        self.devices.iter().filter(|d| d.active())
    }

    pub fn get(&self, id: &str) -> Option<&DeviceEntry> {
        self.devices.iter().find(|d| d.id == id)
    }

    /// The list with one more device. A device ever listed (even removed) cannot be added again.
    pub fn with_added(&self, account: &Identity, entry: DeviceEntry) -> Result<Self, DeviceError> {
        if self.get(&entry.id).is_some() {
            return Err(DeviceError::AlreadyListed);
        }
        if self.active().count() >= MAX_DEVICES {
            return Err(DeviceError::TooMany);
        }
        let mut devices = self.devices.clone();
        devices.push(entry);
        Self::signed(account, self.version + 1, devices)
    }

    /// The list with a device marked removed (it stays listed, so it can never come back under the same keys).
    pub fn with_removed(
        &self,
        account: &Identity,
        id: &str,
        now: i64,
    ) -> Result<Self, DeviceError> {
        let mut devices = self.devices.clone();
        let entry = devices
            .iter_mut()
            .find(|d| d.id == id && d.active())
            .ok_or(DeviceError::Unknown)?;
        entry.removed_at = Some(now);
        Self::signed(account, self.version + 1, devices)
    }

    fn check_shape(&self) -> Result<(), DeviceError> {
        if self.version == 0 || self.devices.is_empty() || self.devices.len() > MAX_ENTRIES {
            return Err(DeviceError::Malformed);
        }
        if self.active().count() > MAX_DEVICES {
            return Err(DeviceError::TooMany);
        }
        let mut seen = std::collections::BTreeSet::new();
        for d in &self.devices {
            let id = device_id(&d.sign, &d.dh).map_err(|_| DeviceError::Malformed)?;
            if id != d.id || !seen.insert(id) || d.name != clean_name(&d.name) {
                return Err(DeviceError::Malformed);
            }
        }
        Ok(())
    }

    /// Checks a list against the account it claims to belong to (the account's two public keys, as a friend knows
    /// them from its contact card): the uid, the signature, and that every entry is well formed.
    pub fn verify(
        &self,
        account_sign: &PublicJwk,
        account_dh: &PublicJwk,
    ) -> Result<(), DeviceError> {
        if uid_from_keys(account_sign, account_dh)?.to_string() != self.account {
            return Err(DeviceError::BadSignature);
        }
        self.check_shape()?;
        let sig = codec::decode(&self.sig).ok_or(DeviceError::BadSignature)?;
        let payload = Self::payload(&self.account, self.version, &self.devices)?;
        if !verify_signature(account_sign, &sig, &payload) {
            return Err(DeviceError::BadSignature);
        }
        Ok(())
    }

    /// Whether `next` may replace this list: it verifies, is newer, and only adds devices or marks them removed (an
    /// entry is never dropped, changed, or brought back).
    pub fn accepts(
        &self,
        next: &DeviceList,
        account_sign: &PublicJwk,
        account_dh: &PublicJwk,
    ) -> Result<(), DeviceError> {
        next.verify(account_sign, account_dh)?;
        if next.account != self.account {
            return Err(DeviceError::BadSignature);
        }
        if next.version <= self.version {
            return Err(DeviceError::Stale);
        }
        for old in &self.devices {
            let new = next.get(&old.id).ok_or(DeviceError::Rewritten)?;
            let same = new.sign == old.sign && new.dh == old.dh && new.added_at <= old.added_at;
            let removal_kept = old.removed_at.is_none()
                || new.removed_at.is_some_and(|r| Some(r) <= old.removed_at);
            if !same || !removal_kept {
                return Err(DeviceError::Rewritten);
            }
        }
        Ok(())
    }

    /// Two lists of the same account that do not extend each other (an install restored from the recovery phrase
    /// started its own): every device of both, with removals kept, signed as one list newer than either. Only a holder
    /// of the account key can make it; every other device accepts it because it extends the list it had.
    pub fn merged(&self, other: &DeviceList, account: &Identity) -> Result<Self, DeviceError> {
        if self.account != other.account || account.uid()?.to_string() != self.account {
            return Err(DeviceError::BadSignature);
        }
        let mut devices = self.devices.clone();
        for theirs in &other.devices {
            match devices.iter_mut().find(|d| d.id == theirs.id) {
                Some(mine) => {
                    if mine.sign != theirs.sign || mine.dh != theirs.dh {
                        return Err(DeviceError::Rewritten);
                    }
                    mine.added_at = mine.added_at.min(theirs.added_at);
                    mine.removed_at = match (mine.removed_at, theirs.removed_at) {
                        (Some(a), Some(b)) => Some(a.min(b)),
                        (a, b) => a.or(b),
                    };
                }
                None => devices.push(theirs.clone()),
            }
        }
        if devices.iter().filter(|d| d.active()).count() > MAX_DEVICES {
            return Err(DeviceError::TooMany);
        }
        Self::signed(account, self.version.max(other.version) + 1, devices)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Parses a list; it still has to be [`verify`](Self::verify)-ed against the account.
    pub fn from_json(text: &str) -> Result<Self, DeviceError> {
        serde_json::from_str(text).map_err(|_| DeviceError::Malformed)
    }
}

/// Linking a new device to the account.
///
/// 1. The device already in the account (A) shows a QR code with a random 32-byte link secret (`offer_code`).
/// 2. The new device (N) scans it and sends a [`Request`]: its device keys, its name, and a **commitment** (hash) to a
///    fresh key-agreement key, with a signature by its device key.
/// 3. A answers with its own fresh key-agreement key.
/// 4. N reveals the key it committed to.
/// 5. Both compute the same 6-digit code from the two fresh keys. The person checks the codes match and confirms on A.
/// 6. A sends the signed device list with N in it.
///
/// Every message is encrypted under a key from the link secret, so relays carrying them learn nothing. Someone who
/// photographed the QR code and gets in the middle ends up with a different code on each screen: the commitment makes
/// them choose their keys before they see the other side's, so they can only match by luck (1 in a million, once).
pub mod link {
    use super::*;
    use crate::{
        aead,
        kdf::hkdf_sha256,
        rng::{random_array, Entropy},
    };

    const OFFER_PREFIX: &str = "duocord-link-1:";

    pub type Secret = zeroize::Zeroizing<[u8; 32]>;

    /// A new link secret, and the text for the QR code (or to type by hand).
    pub fn new_offer(entropy: &mut dyn Entropy) -> Result<(Secret, String), CryptoError> {
        let secret = zeroize::Zeroizing::new(random_array::<32>(entropy)?);
        let code = format!("{OFFER_PREFIX}{}", codec::encode(&*secret));
        Ok((secret, code))
    }

    pub fn parse_offer(code: &str) -> Option<Secret> {
        let bytes = codec::decode(code.trim().strip_prefix(OFFER_PREFIX)?)?;
        let array: [u8; 32] = bytes.try_into().ok()?;
        Some(zeroize::Zeroizing::new(array))
    }

    /// Where the two devices meet on a relay: a label only the holders of the secret can compute.
    pub fn mailbox(secret: &Secret) -> String {
        codec::hex(
            &sha256(&[b"duocord-link-mailbox\n".as_slice(), secret.as_slice()].concat())[..16],
        )
    }

    fn key(secret: &Secret, step: &str) -> Result<zeroize::Zeroizing<[u8; 32]>, CryptoError> {
        Ok(zeroize::Zeroizing::new(hkdf_sha256::<32>(
            secret.as_slice(),
            b"duocord-link-v1",
            step.as_bytes(),
        )?))
    }

    fn seal(
        secret: &Secret,
        step: &str,
        value: &serde_json::Value,
        entropy: &mut dyn Entropy,
    ) -> Result<String, CryptoError> {
        let iv = random_array::<12>(entropy)?;
        let ct = aead::encrypt(
            &*key(secret, step)?,
            &iv,
            value.to_string().as_bytes(),
            step.as_bytes(),
        )?;
        Ok(format!("{}.{}", codec::encode(&iv), codec::encode(&ct)))
    }

    fn open(secret: &Secret, step: &str, text: &str) -> Result<serde_json::Value, CryptoError> {
        let (iv, ct) = text.split_once('.').ok_or(CryptoError::Decrypt)?;
        let iv = codec::decode(iv).ok_or(CryptoError::Decrypt)?;
        let ct = codec::decode(ct).ok_or(CryptoError::Decrypt)?;
        let plain = aead::decrypt(&*key(secret, step)?, &iv, &ct, step.as_bytes())?;
        serde_json::from_slice(&plain).map_err(|_| CryptoError::Decrypt)
    }

    fn jwk_field(v: &serde_json::Value, name: &str) -> Result<PublicJwk, CryptoError> {
        let jwk: PublicJwk =
            serde_json::from_value(v.get(name).cloned().ok_or(CryptoError::Invalid)?)
                .map_err(|_| CryptoError::Invalid)?;
        crate::identity::public_key_from_jwk(&jwk)?;
        Ok(jwk)
    }

    fn jwk_bytes(jwk: &PublicJwk) -> Result<Vec<u8>, CryptoError> {
        Ok(
            canonical_json(&serde_json::to_value(jwk).map_err(|_| CryptoError::Canonical)?)?
                .into_bytes(),
        )
    }

    fn commitment(ephemeral: &PublicJwk) -> Result<String, CryptoError> {
        Ok(codec::encode(&sha256(
            &[b"duocord-link-commit\n".as_slice(), &jwk_bytes(ephemeral)?].concat(),
        )))
    }

    /// The 6-digit code both screens show.
    fn short_code(
        shared: &[u8],
        secret: &Secret,
        old_eph: &PublicJwk,
        new_eph: &PublicJwk,
        device: &DeviceEntry,
    ) -> Result<String, CryptoError> {
        let transcript = sha256(
            &[
                secret.as_slice(),
                &jwk_bytes(old_eph)?,
                &jwk_bytes(new_eph)?,
                device.id.as_bytes(),
            ]
            .concat(),
        );
        let bytes = hkdf_sha256::<8>(shared, &transcript, b"duocord-link-v1/code")?;
        Ok(format!("{:06}", u64::from_be_bytes(bytes) % 1_000_000))
    }

    /* ---------------- the new device ---------------- */

    /// The new device's side, between its request and the grant.
    #[derive(Debug)]
    pub struct Joiner {
        secret: Secret,
        device: DeviceEntry,
        ephemeral: Identity,
        old_eph: Option<PublicJwk>,
        code: Option<String>,
    }

    impl Joiner {
        /// Step 2: the request to send, for a device that has its own keys already.
        pub fn start(
            secret: Secret,
            device: &Identity,
            name: &str,
            now: i64,
            entropy: &mut dyn Entropy,
        ) -> Result<(Self, String), CryptoError> {
            let entry = DeviceEntry::new(device, name, now)?;
            let ephemeral = Identity::generate(entropy)?;
            let commit = commitment(&ephemeral.dh_public())?;
            let proof =
                codec::encode(&device.sign_message(
                    format!("duocord-link-request\n{}\n{commit}", entry.id).as_bytes(),
                ));
            let msg = seal(
                &secret,
                "request",
                &json!({ "device": serde_json::to_value(&entry).map_err(|_| CryptoError::Canonical)?, "commit": commit, "proof": proof }),
                entropy,
            )?;
            Ok((
                Self {
                    secret,
                    device: entry,
                    ephemeral,
                    old_eph: None,
                    code: None,
                },
                msg,
            ))
        }

        /// Step 4: reads the answer, returns the reveal to send and the code to show.
        pub fn on_answer(
            &mut self,
            answer: &str,
            entropy: &mut dyn Entropy,
        ) -> Result<(String, String), CryptoError> {
            if self.old_eph.is_some() {
                return Err(CryptoError::Invalid);
            }
            let v = open(&self.secret, "answer", answer)?;
            let old_eph = jwk_field(&v, "ephemeral")?;
            let shared = self.ephemeral.agree(&old_eph)?;
            let code = short_code(
                &*shared,
                &self.secret,
                &old_eph,
                &self.ephemeral.dh_public(),
                &self.device,
            )?;
            let reveal = seal(
                &self.secret,
                "reveal",
                &json!({ "ephemeral": self.ephemeral.dh_public() }),
                entropy,
            )?;
            self.old_eph = Some(old_eph);
            self.code = Some(code.clone());
            Ok((reveal, code))
        }

        /// Step 6: the signed list. Returns it once it verifies against the account keys it came with and lists this
        /// device.
        pub fn on_grant(&self, grant: &str) -> Result<Granted, DeviceError> {
            let (old_eph, _) = self
                .old_eph
                .as_ref()
                .zip(self.code.as_ref())
                .ok_or(DeviceError::Malformed)?;
            let shared = self.ephemeral.agree(old_eph)?;
            let v = open(
                &grant_secret(&self.secret, shared.as_slice())?,
                "grant",
                grant,
            )?;
            let account_sign = jwk_field(&v, "account_sign")?;
            let account_dh = jwk_field(&v, "account_dh")?;
            let list = DeviceList::from_json(
                v.get("list")
                    .and_then(|l| l.as_str())
                    .ok_or(DeviceError::Malformed)?,
            )?;
            list.verify(&account_sign, &account_dh)?;
            if !list.get(&self.device.id).is_some_and(DeviceEntry::active) {
                return Err(DeviceError::Unknown);
            }
            Ok(Granted {
                account_sign,
                account_dh,
                list,
            })
        }
    }

    /// What a new device has once it is linked.
    #[derive(Debug, Clone)]
    pub struct Granted {
        pub account_sign: PublicJwk,
        pub account_dh: PublicJwk,
        pub list: DeviceList,
    }

    /// The grant is encrypted under a key that also depends on the fresh keys: only the device that took part in this
    /// exchange can read it, not anyone else who saw the QR code.
    fn grant_secret(secret: &Secret, shared: &[u8]) -> Result<Secret, CryptoError> {
        Ok(zeroize::Zeroizing::new(hkdf_sha256::<32>(
            shared,
            secret.as_slice(),
            b"duocord-link-v1/grant-key",
        )?))
    }

    /* ---------------- the device already in the account ---------------- */

    /// The existing device's side. It accepts one request per offer.
    #[derive(Debug)]
    pub struct Host {
        secret: Secret,
        ephemeral: Identity,
        device: Option<DeviceEntry>,
        commit: Option<String>,
        code: Option<String>,
        new_eph: Option<PublicJwk>,
    }

    impl Host {
        pub fn new(secret: Secret, entropy: &mut dyn Entropy) -> Result<Self, CryptoError> {
            Ok(Self {
                secret,
                ephemeral: Identity::generate(entropy)?,
                device: None,
                commit: None,
                code: None,
                new_eph: None,
            })
        }

        /// Step 3: checks the request and returns the answer. A second request on the same offer is refused.
        pub fn on_request(
            &mut self,
            request: &str,
            entropy: &mut dyn Entropy,
        ) -> Result<String, CryptoError> {
            if self.device.is_some() {
                return Err(CryptoError::Invalid);
            }
            let v = open(&self.secret, "request", request)?;
            let device: DeviceEntry =
                serde_json::from_value(v.get("device").cloned().ok_or(CryptoError::Invalid)?)
                    .map_err(|_| CryptoError::Invalid)?;
            if device_id(&device.sign, &device.dh)? != device.id
                || device.name != clean_name(&device.name)
                || device.removed_at.is_some()
            {
                return Err(CryptoError::Invalid);
            }
            let commit = v
                .get("commit")
                .and_then(|c| c.as_str())
                .ok_or(CryptoError::Invalid)?
                .to_owned();
            let proof = codec::decode(
                v.get("proof")
                    .and_then(|p| p.as_str())
                    .ok_or(CryptoError::Invalid)?,
            )
            .ok_or(CryptoError::Invalid)?;
            if !verify_signature(
                &device.sign,
                &proof,
                format!("duocord-link-request\n{}\n{commit}", device.id).as_bytes(),
            ) {
                return Err(CryptoError::Invalid);
            }
            self.device = Some(device);
            self.commit = Some(commit);
            seal(
                &self.secret,
                "answer",
                &json!({ "ephemeral": self.ephemeral.dh_public() }),
                entropy,
            )
        }

        /// Step 5: checks the reveal against the commitment and returns the code to show, with the device asking to
        /// join (its name, for the confirmation screen).
        pub fn on_reveal(&mut self, reveal: &str) -> Result<(String, DeviceEntry), CryptoError> {
            let (device, commit) = self
                .device
                .as_ref()
                .zip(self.commit.as_ref())
                .ok_or(CryptoError::Invalid)?;
            if self.code.is_some() {
                return Err(CryptoError::Invalid);
            }
            let v = open(&self.secret, "reveal", reveal)?;
            let new_eph = jwk_field(&v, "ephemeral")?;
            if &commitment(&new_eph)? != commit {
                return Err(CryptoError::Invalid);
            }
            let shared = self.ephemeral.agree(&new_eph)?;
            let code = short_code(
                &*shared,
                &self.secret,
                &self.ephemeral.dh_public(),
                &new_eph,
                device,
            )?;
            self.code = Some(code.clone());
            self.new_eph = Some(new_eph);
            Ok((code, device.clone()))
        }

        /// Step 6, after the person confirmed the codes match: adds the device to the list and returns the new list
        /// (to keep) and the grant (to send).
        pub fn grant(
            &self,
            account: &Identity,
            current: &DeviceList,
            entropy: &mut dyn Entropy,
        ) -> Result<(DeviceList, String), DeviceError> {
            let device = self.device.clone().ok_or(DeviceError::Malformed)?;
            let new_eph = self.new_eph.as_ref().ok_or(DeviceError::Malformed)?;
            let list = current.with_added(account, device)?;
            let shared = self.ephemeral.agree(new_eph)?;
            let grant = seal(
                &grant_secret(&self.secret, shared.as_slice())?,
                "grant",
                &json!({ "account_sign": account.sign_public(), "account_dh": account.dh_public(), "list": list.to_json() }),
                entropy,
            )?;
            Ok((list, grant))
        }
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::link::*;
    use super::*;
    use crate::rng::OsEntropy;

    fn rng() -> OsEntropy {
        OsEntropy
    }

    fn ident() -> Identity {
        Identity::generate(&mut rng()).unwrap()
    }

    #[test]
    fn a_first_list_verifies_and_only_for_its_account() {
        let (account, phone) = (ident(), ident());
        let list = DeviceList::first(&account, &phone, "Pixel 8", 1).unwrap();
        list.verify(&account.sign_public(), &account.dh_public())
            .unwrap();
        assert_eq!(list.active().count(), 1);
        let other = ident();
        assert!(list
            .verify(&other.sign_public(), &other.dh_public())
            .is_err());
        let round = DeviceList::from_json(&list.to_json()).unwrap();
        round
            .verify(&account.sign_public(), &account.dh_public())
            .unwrap();
    }

    #[test]
    fn any_change_to_a_signed_list_is_caught() {
        let (account, phone) = (ident(), ident());
        let list = DeviceList::first(&account, &phone, "Phone", 1).unwrap();
        let (a, d) = (account.sign_public(), account.dh_public());
        let mut renamed = list.clone();
        renamed.devices[0].name = "Laptop".into();
        assert!(renamed.verify(&a, &d).is_err());
        let mut bumped = list.clone();
        bumped.version = 7;
        assert!(bumped.verify(&a, &d).is_err());
        let mut swapped = list.clone();
        let thief = ident();
        swapped.devices[0].sign = thief.sign_public();
        assert!(swapped.verify(&a, &d).is_err());
    }

    #[test]
    fn devices_are_added_up_to_the_cap_and_removed_ones_never_come_back() {
        let account = ident();
        let first = ident();
        let mut list = DeviceList::first(&account, &first, "One", 1).unwrap();
        for i in 1..MAX_DEVICES {
            list = list
                .with_added(
                    &account,
                    DeviceEntry::new(&ident(), &format!("D{i}"), 2).unwrap(),
                )
                .unwrap();
        }
        assert_eq!(list.version, MAX_DEVICES as u64);
        let extra = DeviceEntry::new(&ident(), "Extra", 3).unwrap();
        assert_eq!(
            list.with_added(&account, extra.clone()),
            Err(DeviceError::TooMany)
        );

        let first_id = list.devices[0].id.clone();
        let removed = list.with_removed(&account, &first_id, 4).unwrap();
        assert_eq!(removed.active().count(), MAX_DEVICES - 1);
        let again = DeviceEntry::new(&first, "One again", 5).unwrap();
        assert_eq!(
            removed.with_added(&account, again),
            Err(DeviceError::AlreadyListed)
        );
        assert!(removed.with_added(&account, extra).is_ok());
        assert_eq!(
            removed.with_removed(&account, &first_id, 6),
            Err(DeviceError::Unknown)
        );
    }

    #[test]
    fn only_newer_lists_that_extend_the_old_one_are_accepted() {
        let (account, phone) = (ident(), ident());
        let (a, d) = (account.sign_public(), account.dh_public());
        let v1 = DeviceList::first(&account, &phone, "Phone", 1).unwrap();
        let laptop = DeviceEntry::new(&ident(), "Laptop", 2).unwrap();
        let v2 = v1.with_added(&account, laptop.clone()).unwrap();
        v1.accepts(&v2, &a, &d).unwrap();
        assert_eq!(v2.accepts(&v1, &a, &d), Err(DeviceError::Stale));
        assert_eq!(v2.accepts(&v2, &a, &d), Err(DeviceError::Stale));

        // A newer list that forgets the laptop was removed, or drops a device, is refused even though it is signed.
        let v3 = v2.with_removed(&account, &laptop.id, 3).unwrap();
        let mut revived = DeviceList::first(&account, &phone, "Phone", 1).unwrap();
        revived = revived.with_added(&account, laptop).unwrap();
        revived = revived
            .with_added(&account, DeviceEntry::new(&ident(), "X", 4).unwrap())
            .unwrap();
        revived = revived
            .with_added(&account, DeviceEntry::new(&ident(), "X2", 4).unwrap())
            .unwrap();
        assert_eq!(v3.accepts(&revived, &a, &d), Err(DeviceError::Rewritten));
        let dropped = DeviceList::first(&account, &ident(), "Other", 1)
            .unwrap()
            .with_added(&account, DeviceEntry::new(&ident(), "Y", 1).unwrap())
            .unwrap()
            .with_added(&account, DeviceEntry::new(&ident(), "Z", 1).unwrap())
            .unwrap()
            .with_added(&account, DeviceEntry::new(&ident(), "W", 1).unwrap())
            .unwrap();
        assert_eq!(v3.accepts(&dropped, &a, &d), Err(DeviceError::Rewritten));
    }

    #[test]
    fn forked_lists_are_merged_by_the_account_and_both_sides_accept_the_merge() {
        let (account, phone, laptop, tablet) = (ident(), ident(), ident(), ident());
        let (a, d) = (account.sign_public(), account.dh_public());
        // The phone's list gained a tablet; a laptop restored from the phrase started its own list.
        let phones = DeviceList::first(&account, &phone, "Phone", 1)
            .unwrap()
            .with_added(&account, DeviceEntry::new(&tablet, "Tablet", 2).unwrap())
            .unwrap();
        let laptops = DeviceList::first(&account, &laptop, "Laptop", 3).unwrap();
        assert!(phones.accepts(&laptops, &a, &d).is_err());
        let merged = laptops.merged(&phones, &account).unwrap();
        assert_eq!(merged.active().count(), 3);
        assert_eq!(merged.version, 3);
        phones.accepts(&merged, &a, &d).unwrap();
        laptops.accepts(&merged, &a, &d).unwrap();
        let ids = |l: &DeviceList| {
            l.devices
                .iter()
                .map(|d| d.id.clone())
                .collect::<std::collections::BTreeSet<_>>()
        };
        assert_eq!(
            ids(&merged),
            ids(&phones.merged(&laptops, &account).unwrap()),
            "the same devices from either side"
        );

        // A removal on either side survives the merge.
        let tablet_id = phones.devices[1].id.clone();
        let removed = phones.with_removed(&account, &tablet_id, 9).unwrap();
        let merged2 = removed.merged(&merged, &account).unwrap();
        assert!(!merged2.get(&tablet_id).unwrap().active());
        removed.accepts(&merged2, &a, &d).unwrap();
        merged.accepts(&merged2, &a, &d).unwrap();

        // Someone without the account key cannot make one.
        assert!(laptops.merged(&phones, &ident()).is_err());
    }

    #[test]
    fn names_are_cleaned() {
        let e = DeviceEntry::new(&ident(), "  Lap\ntop\u{7}  ", 1).unwrap();
        assert_eq!(e.name, "Laptop");
        assert_eq!(DeviceEntry::new(&ident(), "   ", 1).unwrap().name, "Device");
        assert_eq!(
            DeviceEntry::new(&ident(), &"x".repeat(200), 1)
                .unwrap()
                .name
                .chars()
                .count(),
            MAX_NAME_CHARS
        );
    }

    /// Runs the whole link exchange; returns both codes and what the new device ends up with.
    fn link(
        host: &mut Host,
        joiner_secret: Secret,
        new_device: &Identity,
    ) -> (String, String, Joiner) {
        let (mut joiner, request) =
            Joiner::start(joiner_secret, new_device, "Laptop", 5, &mut rng()).unwrap();
        let answer = host.on_request(&request, &mut rng()).unwrap();
        let (reveal, joiner_code) = joiner.on_answer(&answer, &mut rng()).unwrap();
        let (host_code, entry) = host.on_reveal(&reveal).unwrap();
        assert_eq!(entry.name, "Laptop");
        (host_code, joiner_code, joiner)
    }

    #[test]
    fn linking_a_device_end_to_end() {
        let (account, phone, laptop) = (ident(), ident(), ident());
        let list = DeviceList::first(&account, &phone, "Phone", 1).unwrap();
        let (secret, code) = new_offer(&mut rng()).unwrap();
        let scanned = parse_offer(&code).unwrap();
        assert_eq!(mailbox(&secret), mailbox(&scanned));
        let mut host = Host::new(secret, &mut rng()).unwrap();
        let (host_code, joiner_code, joiner) = link(&mut host, scanned, &laptop);
        assert_eq!(host_code, joiner_code);
        assert_eq!(host_code.len(), 6);

        let (new_list, grant) = host.grant(&account, &list, &mut rng()).unwrap();
        let granted = joiner.on_grant(&grant).unwrap();
        assert_eq!(granted.list, new_list);
        assert_eq!(granted.list.active().count(), 2);
        assert_eq!(granted.account_sign, account.sign_public());
        list.accepts(&granted.list, &account.sign_public(), &account.dh_public())
            .unwrap();
    }

    #[test]
    fn a_wrong_code_or_a_second_request_gets_nowhere() {
        let (secret, code) = new_offer(&mut rng()).unwrap();
        let mut host = Host::new(secret, &mut rng()).unwrap();
        // Someone without the secret cannot even be read.
        let (other, _) = new_offer(&mut rng()).unwrap();
        let (_, stranger) = Joiner::start(other, &ident(), "Evil", 1, &mut rng()).unwrap();
        assert!(host.on_request(&stranger, &mut rng()).is_err());

        let (_, _, _) = link(&mut host, parse_offer(&code).unwrap(), &ident());
        // One request per offer.
        let (_, second) = Joiner::start(
            parse_offer(&code).unwrap(),
            &ident(),
            "Second",
            1,
            &mut rng(),
        )
        .unwrap();
        assert!(host.on_request(&second, &mut rng()).is_err());
    }

    #[test]
    fn a_reveal_that_breaks_the_commitment_is_refused() {
        let (secret, code) = new_offer(&mut rng()).unwrap();
        let mut host = Host::new(secret, &mut rng()).unwrap();
        let (mut joiner, request) = Joiner::start(
            parse_offer(&code).unwrap(),
            &ident(),
            "Laptop",
            1,
            &mut rng(),
        )
        .unwrap();
        let answer = host.on_request(&request, &mut rng()).unwrap();
        let _ = joiner.on_answer(&answer, &mut rng()).unwrap();
        // An attacker who knows the secret swaps in a key of their choosing after seeing the host's.
        let secret = parse_offer(&code).unwrap();
        let forged = seal_for_test(
            &secret,
            "reveal",
            &serde_json::json!({ "ephemeral": ident().dh_public() }),
        );
        assert!(host.on_reveal(&forged).is_err());
    }

    #[test]
    fn a_man_in_the_middle_with_the_qr_code_shows_different_codes() {
        let (secret, code) = new_offer(&mut rng()).unwrap();
        // The attacker photographed the QR code and sits between the two devices, running each half separately.
        let mut host = Host::new(secret, &mut rng()).unwrap();
        let (mut attacker_as_new, req_to_host) = Joiner::start(
            parse_offer(&code).unwrap(),
            &ident(),
            "Laptop",
            1,
            &mut rng(),
        )
        .unwrap();
        let answer_from_host = host.on_request(&req_to_host, &mut rng()).unwrap();
        let (reveal_to_host, _) = attacker_as_new
            .on_answer(&answer_from_host, &mut rng())
            .unwrap();
        let (host_code, _) = host.on_reveal(&reveal_to_host).unwrap();

        let mut attacker_as_host = Host::new(parse_offer(&code).unwrap(), &mut rng()).unwrap();
        let (mut real_new, req) = Joiner::start(
            parse_offer(&code).unwrap(),
            &ident(),
            "Laptop",
            1,
            &mut rng(),
        )
        .unwrap();
        let answer = attacker_as_host.on_request(&req, &mut rng()).unwrap();
        let (_, new_code) = real_new.on_answer(&answer, &mut rng()).unwrap();
        assert_ne!(host_code, new_code);
    }

    #[test]
    fn a_grant_for_another_exchange_does_not_open() {
        let account = ident();
        let list = DeviceList::first(&account, &ident(), "Phone", 1).unwrap();
        let (secret, code) = new_offer(&mut rng()).unwrap();
        let mut host = Host::new(secret, &mut rng()).unwrap();
        let (_, _, _real) = link(&mut host, parse_offer(&code).unwrap(), &ident());
        let (_, grant) = host.grant(&account, &list, &mut rng()).unwrap();
        // Another joiner with the same QR secret, but not the one the host exchanged keys with.
        let mut other_host = Host::new(parse_offer(&code).unwrap(), &mut rng()).unwrap();
        let (_, _, eavesdropper) = link(&mut other_host, parse_offer(&code).unwrap(), &ident());
        assert!(eavesdropper.on_grant(&grant).is_err());
    }

    fn seal_for_test(secret: &Secret, step: &str, value: &serde_json::Value) -> String {
        let key =
            crate::kdf::hkdf_sha256::<32>(secret.as_slice(), b"duocord-link-v1", step.as_bytes())
                .unwrap();
        let iv = [7u8; 12];
        let ct =
            crate::aead::encrypt(&key, &iv, value.to_string().as_bytes(), step.as_bytes()).unwrap();
        format!("{}.{}", codec::encode(&iv), codec::encode(&ct))
    }
}
