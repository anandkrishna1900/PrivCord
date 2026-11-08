//! Saved pairing records and reconnect backoff (`pairing.ts`).

use crate::blob::PublicJwk;
use serde_json::{json, Map, Value};

pub const PAIRING_RECORD_VERSION: u64 = 1;
pub const RECONNECT_BASE_MS: f64 = 5_000.0;
pub const RECONNECT_MAX_MS: f64 = 120_000.0;

/// The wire rule for a public key in these records: EC P-256 with coordinates at least 40 characters long.
pub fn is_valid_public_jwk(value: &Value) -> Option<PublicJwk> {
    let o = value.as_object()?;
    if o.get("kty")?.as_str()? != "EC" || o.get("crv")?.as_str()? != "P-256" {
        return None;
    }
    let x = o.get("x")?.as_str()?;
    let y = o.get("y")?.as_str()?;
    if x.encode_utf16().count() < 40 || y.encode_utf16().count() < 40 {
        return None;
    }
    Some(PublicJwk::p256(x, y))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingStatus {
    Unpaired,
    Saved,
    Connecting,
    Connected,
    Offline,
}

impl PairingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unpaired => "UNPAIRED",
            Self::Saved => "SAVED",
            Self::Connecting => "CONNECTING",
            Self::Connected => "CONNECTED",
            Self::Offline => "OFFLINE",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PairingRecord {
    pub peer_uid: String,
    pub peer_device_id: String,
    pub public_key: PublicJwk,
    /// The contact's ECDH identity key, needed to seal blobs to them.
    pub dh: Option<PublicJwk>,
    pub safety_number: String,
    pub paired_at: i64,
    pub last_connected_at: i64,
}

fn finite_time(v: &Value) -> Option<i64> {
    let n = v.as_f64()?;
    n.is_finite().then_some(n as i64)
}

impl PairingRecord {
    /// `None` for anything that breaks the rules; `expected_peer` must match when given.
    pub fn from_value(value: &Value, expected_peer: Option<&str>) -> Option<Self> {
        let o = value.as_object()?;
        if o.get("version")?.as_u64()? != PAIRING_RECORD_VERSION {
            return None;
        }
        let peer_uid = o.get("peerUid")?.as_str()?;
        if peer_uid.is_empty() || expected_peer.is_some_and(|e| e != peer_uid) {
            return None;
        }
        let peer_device_id = o.get("peerDeviceId")?.as_str()?;
        if peer_device_id.is_empty() {
            return None;
        }
        let public_key = is_valid_public_jwk(o.get("publicKeyJwk")?)?;
        let dh = match o.get("dhJwk") {
            None => None,
            Some(v) => Some(is_valid_public_jwk(v)?),
        };
        let safety_number = o.get("safetyNumber")?.as_str()?;
        if safety_number.is_empty() {
            return None;
        }
        Some(Self {
            peer_uid: peer_uid.to_owned(),
            peer_device_id: peer_device_id.to_owned(),
            public_key,
            dh,
            safety_number: safety_number.to_owned(),
            paired_at: finite_time(o.get("pairedAt")?)?,
            last_connected_at: finite_time(o.get("lastConnectedAt")?)?,
        })
    }

    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("version".into(), json!(PAIRING_RECORD_VERSION));
        o.insert("peerUid".into(), json!(self.peer_uid));
        o.insert("peerDeviceId".into(), json!(self.peer_device_id));
        o.insert("publicKeyJwk".into(), json!(self.public_key));
        if let Some(d) = &self.dh {
            o.insert("dhJwk".into(), json!(d));
        }
        o.insert("safetyNumber".into(), json!(self.safety_number));
        o.insert("pairedAt".into(), json!(self.paired_at));
        o.insert("lastConnectedAt".into(), json!(self.last_connected_at));
        Value::Object(o)
    }

    /// A fresh record, or the previous one refreshed when it is the same person on the same device with the same key
    /// (then `paired_at` is kept).
    pub fn create(
        peer_uid: &str,
        peer_device_id: &str,
        public_key: PublicJwk,
        dh: Option<PublicJwk>,
        safety_number: &str,
        previous: Option<&Self>,
        now: i64,
    ) -> Self {
        let same = previous.is_some_and(|p| {
            p.peer_uid == peer_uid
                && p.peer_device_id == peer_device_id
                && p.public_key == public_key
        });
        Self {
            peer_uid: peer_uid.to_owned(),
            peer_device_id: peer_device_id.to_owned(),
            public_key,
            dh,
            safety_number: safety_number.to_owned(),
            paired_at: if same {
                previous.map_or(now, |p| p.paired_at)
            } else {
                now
            },
            last_connected_at: now,
        }
    }

    pub fn matches_peer(&self, peer_uid: &str, device_id: &str, key: &PublicJwk) -> bool {
        self.peer_uid == peer_uid && self.peer_device_id == device_id && self.public_key == *key
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PairingStoreState {
    pub record: Option<PairingRecord>,
    pub auto_reconnect: bool,
}

impl Default for PairingStoreState {
    fn default() -> Self {
        Self {
            record: None,
            auto_reconnect: true,
        }
    }
}

impl PairingStoreState {
    /// Anything unreadable gives the empty state (never an error), as the apps do.
    pub fn parse(raw: Option<&str>, expected_peer: Option<&str>) -> Self {
        let Some(raw) = raw.filter(|r| !r.is_empty()) else {
            return Self::default();
        };
        let Ok(Value::Object(o)) = serde_json::from_str::<Value>(raw) else {
            return Self::default();
        };
        if o.get("version").and_then(Value::as_u64) != Some(PAIRING_RECORD_VERSION) {
            return Self::default();
        }
        Self {
            record: o
                .get("record")
                .and_then(|r| PairingRecord::from_value(r, expected_peer)),
            auto_reconnect: o
                .get("autoReconnect")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        }
    }

    pub fn serialize(&self) -> String {
        json!({
            "version": PAIRING_RECORD_VERSION,
            "record": self.record.as_ref().map(PairingRecord::to_value),
            "autoReconnect": self.auto_reconnect,
        })
        .to_string()
    }

    pub fn can_auto_reconnect(&self) -> bool {
        self.record.is_some() && self.auto_reconnect
    }
}

pub fn should_persist_pairing(trust: &str) -> bool {
    trust == "verified" || trust == "confirmed"
}

pub fn derive_pairing_status(
    saved: bool,
    connected: bool,
    connecting: bool,
    failed: bool,
) -> PairingStatus {
    if connected {
        PairingStatus::Connected
    } else if connecting {
        PairingStatus::Connecting
    } else if saved && failed {
        PairingStatus::Offline
    } else if saved {
        PairingStatus::Saved
    } else {
        PairingStatus::Unpaired
    }
}

/// Delay before reconnect attempt number `attempt`: `base * 2^min(attempt, 8)`, capped at `max`. Nonsense options fall
/// back to the defaults exactly as the TypeScript does.
pub fn reconnect_delay_ms(attempt: f64, base_ms: Option<f64>, max_ms: Option<f64>) -> f64 {
    let base = base_ms.unwrap_or(RECONNECT_BASE_MS);
    let max = max_ms.unwrap_or(RECONNECT_MAX_MS);
    if !base.is_finite() || base <= 0.0 {
        return RECONNECT_BASE_MS;
    }
    if !max.is_finite() || max < base {
        return base;
    }
    let bounded = attempt.floor().clamp(0.0, 8.0);
    max.min(base * 2f64.powf(bounded))
}
