//! Contact cards: the public identity handed to a friend by QR or paste (`connectivity/contactCard.ts`).
//! Contains no secrets.

use crate::{
    canonical::canonical_json,
    error::CryptoError,
    identity::{thumb, uid_from_keys, verify_identity_proof, Identity},
};
use privcord_domain::{blob::PublicJwk, codec, ids::UserId, text::utf16_len};
use serde_json::{json, Map, Value};

pub const CONTACT_CARD_PREFIX: &str = "DUOID1:";
const MAX_NAME_UNITS: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContactCard {
    pub sign: PublicJwk,
    pub dh: PublicJwk,
    /// base64url self-signature binding the ECDH key to the signing key.
    pub proof: String,
    pub name: Option<String>,
}

/// A card whose proof has been checked, with the uid it gives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contact {
    pub uid: UserId,
    pub card: ContactCard,
}

/// The name cut to 40 UTF-16 units without splitting a character.
fn cut_name(name: &str) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in name.chars() {
        units += c.len_utf16();
        if units > MAX_NAME_UNITS {
            break;
        }
        out.push(c);
    }
    out
}

impl ContactCard {
    pub fn of(identity: &Identity, name: Option<&str>) -> Result<Self, CryptoError> {
        Ok(Self {
            sign: identity.sign_public(),
            dh: identity.dh_public(),
            proof: identity.identity_proof()?,
            name: name.filter(|n| !n.is_empty()).map(cut_name),
        })
    }

    /// `DUOID1:` + base64url of the canonical JSON.
    pub fn encode(&self) -> Result<String, CryptoError> {
        let mut o = Map::new();
        o.insert("v".into(), json!(1));
        o.insert("sign".into(), thumb(&self.sign));
        o.insert("dh".into(), thumb(&self.dh));
        o.insert("proof".into(), json!(self.proof));
        if let Some(n) = self.name.as_ref().filter(|n| !n.is_empty()) {
            o.insert("name".into(), json!(cut_name(n)));
        }
        Ok(format!(
            "{CONTACT_CARD_PREFIX}{}",
            codec::encode(canonical_json(&Value::Object(o))?.as_bytes())
        ))
    }

    /// Parses and cryptographically validates a card. `None` if anything is off.
    pub fn decode(text: &str) -> Option<Contact> {
        let trimmed = privcord_domain::text::js_trim(text);
        let body = trimmed.strip_prefix(CONTACT_CARD_PREFIX)?;
        let value: Value = serde_json::from_slice(&codec::decode(body)?).ok()?;
        Self::from_value(&value)
    }

    /// The same checks for a card that is already parsed JSON.
    pub fn from_value(value: &Value) -> Option<Contact> {
        let o = value.as_object()?;
        if o.get("v")?.as_u64()? != 1 {
            return None;
        }
        let proof = o.get("proof")?.as_str()?;
        let sign = PublicJwk::from_value(o.get("sign")?)?;
        let dh = PublicJwk::from_value(o.get("dh")?)?;
        let name = match o.get("name") {
            None => None,
            Some(n) => Some(n.as_str()?.to_owned()),
        };
        if !verify_identity_proof(&sign, &dh, proof) {
            return None;
        }
        let uid = uid_from_keys(&sign, &dh).ok()?;
        let name = name.filter(|n| !n.is_empty()).map(|n| cut_name(&n));
        debug_assert!(name.as_ref().is_none_or(|n| utf16_len(n) <= MAX_NAME_UNITS));
        Some(Contact {
            uid,
            card: ContactCard {
                sign,
                dh,
                proof: proof.to_owned(),
                name,
            },
        })
    }
}
