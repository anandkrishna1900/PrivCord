//! The signed, encrypted envelope every relay and radio carries (`SealedBlob`). Data and shape rules only; sealing
//! and opening are in `privcord-crypto`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A P-256 public key in the JWK shape used on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PublicJwk {
    pub kty: String,
    pub crv: String,
    pub x: String,
    pub y: String,
}

impl PublicJwk {
    /// `None` unless it is an EC P-256 key with string coordinates (the wire rule; the point is checked on use).
    pub fn from_value(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        let kty = o.get("kty")?.as_str()?;
        let crv = o.get("crv")?.as_str()?;
        if kty != "EC" || crv != "P-256" {
            return None;
        }
        Some(Self {
            kty: kty.to_owned(),
            crv: crv.to_owned(),
            x: o.get("x")?.as_str()?.to_owned(),
            y: o.get("y")?.as_str()?.to_owned(),
        })
    }

    pub fn p256(x: impl Into<String>, y: impl Into<String>) -> Self {
        Self {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: x.into(),
            y: y.into(),
        }
    }
}

pub const MAX_SEALED_BLOB_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SealedBlob {
    pub v: u8,
    pub to: String,
    pub from: String,
    pub epk: PublicJwk,
    pub iv: String,
    pub ct: String,
    pub sig: String,
}

impl SealedBlob {
    /// The blob if it has the right shape; `None` otherwise (same test as `validateBlob`).
    pub fn from_value(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        if o.get("v")?.as_u64()? != 1 {
            return None;
        }
        Some(Self {
            v: 1,
            to: o.get("to")?.as_str()?.to_owned(),
            from: o.get("from")?.as_str()?.to_owned(),
            epk: PublicJwk::from_value(o.get("epk")?)?,
            iv: o.get("iv")?.as_str()?.to_owned(),
            ct: o.get("ct")?.as_str()?.to_owned(),
            sig: o.get("sig")?.as_str()?.to_owned(),
        })
    }

    /// base64url of the JSON text, the form carried in relay events and QR payloads.
    pub fn encode(&self) -> String {
        crate::codec::encode(serde_json::to_string(self).unwrap_or_default().as_bytes())
    }

    pub fn decode(text: &str) -> Option<Self> {
        let bytes = crate::codec::decode(text)?;
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        Self::from_value(&value)
    }
}
