//! Epoch-keyed group messages (`groupCrypto.ts`): every group epoch has one 32-byte key; a message is AES-256-GCM under
//! it with the group, epoch, sender and sequence number authenticated. Changing the epoch (on removal) locks removed
//! members out of later messages.

use crate::{
    aead,
    error::CryptoError,
    rng::{random_array, Entropy},
};
use privcord_domain::codec;
use serde_json::{json, Value};
use std::collections::HashMap;
use zeroize::Zeroizing;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupEncryptedMessage {
    pub group_id: String,
    pub epoch: u64,
    pub sender_uid: String,
    pub seq: u64,
    pub iv: String,
    pub ciphertext: String,
}

impl GroupEncryptedMessage {
    pub fn to_value(&self) -> Value {
        json!({
            "v": 1, "kind": "group_msg", "groupId": self.group_id, "epoch": self.epoch,
            "senderUid": self.sender_uid, "seq": self.seq, "iv": self.iv, "ciphertext": self.ciphertext,
        })
    }

    pub fn from_value(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        if o.get("v")?.as_u64()? != 1 || o.get("kind")?.as_str()? != "group_msg" {
            return None;
        }
        Some(Self {
            group_id: o.get("groupId")?.as_str()?.to_owned(),
            epoch: o.get("epoch")?.as_u64()?,
            sender_uid: o.get("senderUid")?.as_str()?.to_owned(),
            seq: o.get("seq")?.as_u64()?,
            iv: o.get("iv")?.as_str()?.to_owned(),
            ciphertext: o.get("ciphertext")?.as_str()?.to_owned(),
        })
    }
}

fn aad(group_id: &str, epoch: u64, sender: &str, seq: u64) -> Vec<u8> {
    format!("group|{group_id}|{epoch}|{sender}|{seq}").into_bytes()
}

/// The keys of one group: its current epoch and the key of every epoch we hold.
type GroupKeys = (u64, HashMap<u64, Zeroizing<[u8; 32]>>);

/// Group metadata and epoch keys held on this device.
#[derive(Default)]
pub struct GroupSessionManager {
    /// group id to (current epoch, keys by epoch).
    groups: HashMap<String, GroupKeys>,
}

impl std::fmt::Debug for GroupSessionManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GroupSessionManager(..)")
    }
}

impl GroupSessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Declare a group and which epoch is current.
    pub fn set_group(&mut self, group_id: &str, epoch: u64) {
        self.groups.entry(group_id.to_owned()).or_default().0 = epoch;
    }

    pub fn set_epoch_key(&mut self, group_id: &str, epoch: u64, key: [u8; 32]) {
        self.groups
            .entry(group_id.to_owned())
            .or_default()
            .1
            .insert(epoch, Zeroizing::new(key));
    }

    pub fn generate_epoch_secret(entropy: &mut dyn Entropy) -> Result<[u8; 32], CryptoError> {
        random_array(entropy)
    }

    /// Encrypt to the group's current epoch.
    pub fn encrypt(
        &self,
        group_id: &str,
        sender_uid: &str,
        seq: u64,
        payload: &Value,
        entropy: &mut dyn Entropy,
    ) -> Result<GroupEncryptedMessage, CryptoError> {
        let (epoch, keys) = self
            .groups
            .get(group_id)
            .ok_or(CryptoError::E2ee("Unknown group."))?;
        let key = keys
            .get(epoch)
            .ok_or(CryptoError::E2ee("Missing epoch key for the group."))?;
        let iv: [u8; 12] = random_array(entropy)?;
        let ct = aead::encrypt(
            &**key,
            &iv,
            payload.to_string().as_bytes(),
            &aad(group_id, *epoch, sender_uid, seq),
        )?;
        Ok(GroupEncryptedMessage {
            group_id: group_id.to_owned(),
            epoch: *epoch,
            sender_uid: sender_uid.to_owned(),
            seq,
            iv: codec::encode(&iv),
            ciphertext: codec::encode(&ct),
        })
    }

    /// Decrypt a message of any epoch whose key we hold.
    pub fn decrypt(&self, msg: &GroupEncryptedMessage) -> Result<Value, CryptoError> {
        let key = self
            .groups
            .get(&msg.group_id)
            .and_then(|(_, keys)| keys.get(&msg.epoch))
            .ok_or(CryptoError::E2ee("Cannot decrypt: missing epoch key."))?;
        let iv = codec::decode(&msg.iv).ok_or(CryptoError::Decrypt)?;
        let ct = codec::decode(&msg.ciphertext).ok_or(CryptoError::Decrypt)?;
        let plain = aead::decrypt(
            &**key,
            &iv,
            &ct,
            &aad(&msg.group_id, msg.epoch, &msg.sender_uid, msg.seq),
        )?;
        serde_json::from_slice(&plain).map_err(|_| CryptoError::Decrypt)
    }
}
