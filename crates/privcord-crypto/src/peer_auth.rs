//! The legacy peer handshake the desktop and Android apps speak over WebRTC (`peerAuth.ts`, `peerLink.ts`,
//! `PeerSession.kt`).
//!
//! Both sides send a `hello` carrying their identity keys and a nonce, check it against the contact they pinned, then each
//! signs a challenge made of both nonces (`auth_proof`) and acknowledges the other's (`auth_ok`). The link is trusted only
//! once the peer has proved its identity and acknowledged ours. After that the frames travel as plain JSON, because the
//! WebRTC data channel is already encrypted (DTLS); a link that is not (Bluetooth) uses [`crate::secure_channel`] instead.

use crate::{
    error::CryptoError,
    identity::{uid_from_keys, verify_identity_proof, verify_signature, Identity},
    rng::{random_array, Entropy},
};
use privcord_domain::{blob::PublicJwk, codec};
use serde_json::{json, Value};

pub const AUTH_TIMEOUT_MS: i64 = 15_000;
const PROTOCOL_VERSION: u64 = 1;

/// Why a handshake step was refused. `Display` gives the text shown to a person (the same as the apps').
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AuthError {
    #[error("This is not the device you added. The connection was refused.")]
    NotTheContact,
    #[error("Refused a connection that claimed our own identity.")]
    OwnIdentity,
    #[error("The other device failed its identity check.")]
    BadIdentity,
    #[error("Identity proof arrived out of order.")]
    OutOfOrder,
    #[error("The other device failed its identity proof.")]
    BadProof,
    #[error("Identity acknowledgement came from the wrong device.")]
    WrongAck,
    #[error("Could not sign the identity proof.")]
    Sign,
}

/// What we already know about the person on the other end (their pinned card).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expected {
    pub uid: String,
    pub sign: PublicJwk,
    pub dh: PublicJwk,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hello {
    pub uid: String,
    pub device_id: String,
    pub sign: PublicJwk,
    pub dh: PublicJwk,
    pub identity_proof: String,
    pub nonce: String,
}

fn valid_jwk(v: &Value) -> Option<PublicJwk> {
    let j = PublicJwk::from_value(v)?;
    (j.x.encode_utf16().count() >= 40 && j.y.encode_utf16().count() >= 40).then_some(j)
}

impl Hello {
    pub fn to_value(&self) -> Value {
        json!({
            "v": PROTOCOL_VERSION, "kind": "hello", "uid": self.uid, "deviceId": self.device_id,
            "publicKeyJwk": self.sign, "dhJwk": self.dh, "identityProof": self.identity_proof, "nonce": self.nonce
        })
    }

    /// The same shape rules as `parsePeerFrame` applies to a `hello`.
    pub fn parse(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        if o.get("v")?.as_u64()? != PROTOCOL_VERSION || o.get("kind")?.as_str()? != "hello" {
            return None;
        }
        let uid = o.get("uid")?.as_str()?;
        let device_id = o.get("deviceId")?.as_str()?;
        let nonce = o.get("nonce")?.as_str()?;
        let proof = o.get("identityProof")?.as_str()?;
        if uid.is_empty()
            || device_id.is_empty()
            || nonce.encode_utf16().count() < 16
            || proof.encode_utf16().count() < 40
        {
            return None;
        }
        Some(Self {
            uid: uid.to_owned(),
            device_id: device_id.to_owned(),
            sign: valid_jwk(o.get("publicKeyJwk")?)?,
            dh: valid_jwk(o.get("dhJwk")?)?,
            identity_proof: proof.to_owned(),
            nonce: nonce.to_owned(),
        })
    }
}

/// The text both sides sign: protocol label, conversation context, the signer's uid and device, then both nonces.
pub fn auth_challenge(
    context: &str,
    uid: &str,
    device_id: &str,
    nonce_self: &str,
    nonce_peer: &str,
) -> String {
    [
        "duochat-peer-auth-v1",
        context,
        uid,
        device_id,
        nonce_self,
        nonce_peer,
    ]
    .join("\n")
}

fn same_key(a: &PublicJwk, b: &PublicJwk) -> bool {
    a.x == b.x && a.y == b.y && a.crv == b.crv && a.kty == b.kty
}

/// One side of one handshake.
#[derive(Debug)]
pub struct PeerAuth {
    context: String,
    own_uid: String,
    own_device: String,
    expected: Expected,
    nonce: String,
    peer_hello: Option<Hello>,
    proof_sent: bool,
    proven: bool,
    acknowledged: bool,
}

impl PeerAuth {
    /// `nonce` is a fresh 24 random bytes in hex.
    pub fn new(
        context: &str,
        own: &Identity,
        own_device: &str,
        expected: Expected,
        entropy: &mut dyn Entropy,
    ) -> Result<Self, CryptoError> {
        let bytes: [u8; 24] = random_array(entropy)?;
        Ok(Self::with_nonce(
            context,
            own.uid()?.as_str(),
            own_device,
            expected,
            codec::hex(&bytes),
        ))
    }

    /// For tests that must reproduce exact frames.
    pub fn with_nonce(
        context: &str,
        own_uid: &str,
        own_device: &str,
        expected: Expected,
        nonce: String,
    ) -> Self {
        Self {
            context: context.to_owned(),
            own_uid: own_uid.to_owned(),
            own_device: own_device.to_owned(),
            expected,
            nonce,
            peer_hello: None,
            proof_sent: false,
            proven: false,
            acknowledged: false,
        }
    }

    /// Our hello, sent as soon as the link opens.
    pub fn hello(&self, own: &Identity) -> Result<Value, CryptoError> {
        Ok(Hello {
            uid: self.own_uid.clone(),
            device_id: self.own_device.clone(),
            sign: own.sign_public(),
            dh: own.dh_public(),
            identity_proof: own.identity_proof()?,
            nonce: self.nonce.clone(),
        }
        .to_value())
    }

    /// Trusted: the peer proved who it is and acknowledged us.
    pub fn authenticated(&self) -> bool {
        self.peer_hello.is_some() && self.proven && self.acknowledged
    }

    /// The peer's hello, once accepted.
    pub fn peer(&self) -> Option<&Hello> {
        self.peer_hello.as_ref()
    }

    /// Handle one handshake frame. Returns the frames to send back. `Ok(None)` means the frame is not part of the handshake.
    pub fn on_frame(
        &mut self,
        own: &Identity,
        frame: &Value,
    ) -> Result<Option<Vec<Value>>, AuthError> {
        match frame.get("kind").and_then(Value::as_str) {
            Some("hello") => {
                let Some(hello) = Hello::parse(frame) else {
                    return Ok(Some(vec![]));
                };
                self.on_hello(own, hello).map(Some)
            }
            Some("auth_proof") => self.on_proof(frame).map(Some),
            Some("auth_ok") => self.on_ok(frame).map(|()| Some(vec![])),
            _ => Ok(None),
        }
    }

    fn on_hello(&mut self, own: &Identity, hello: Hello) -> Result<Vec<Value>, AuthError> {
        if hello.uid != self.expected.uid
            || !same_key(&self.expected.sign, &hello.sign)
            || !same_key(&self.expected.dh, &hello.dh)
        {
            return Err(AuthError::NotTheContact);
        }
        if same_key(&own.sign_public(), &hello.sign) {
            return Err(AuthError::OwnIdentity);
        }
        let uid_ok = uid_from_keys(&hello.sign, &hello.dh).is_ok_and(|u| u.as_str() == hello.uid);
        if !uid_ok || !verify_identity_proof(&hello.sign, &hello.dh, &hello.identity_proof) {
            return Err(AuthError::BadIdentity);
        }
        self.peer_hello = Some(hello);
        let mut out = Vec::new();
        if !self.proof_sent {
            let Some(peer) = self.peer_hello.as_ref() else {
                return Ok(out);
            };
            let challenge = auth_challenge(
                &self.context,
                &self.own_uid,
                &self.own_device,
                &self.nonce,
                &peer.nonce,
            );
            let signature = codec::encode(&own.sign_message(challenge.as_bytes()));
            self.proof_sent = true;
            out.push(json!({ "v": PROTOCOL_VERSION, "kind": "auth_proof", "uid": self.own_uid, "signature": signature }));
        }
        Ok(out)
    }

    fn on_proof(&mut self, frame: &Value) -> Result<Vec<Value>, AuthError> {
        let uid = frame.get("uid").and_then(Value::as_str).unwrap_or_default();
        let signature = frame
            .get("signature")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(hello) = self
            .peer_hello
            .as_ref()
            .filter(|h| h.uid == uid && signature.encode_utf16().count() > 40)
        else {
            return Err(AuthError::OutOfOrder);
        };
        // The peer signed its own uid and device with its nonce first, then ours.
        let challenge = auth_challenge(
            &self.context,
            &hello.uid,
            &hello.device_id,
            &hello.nonce,
            &self.nonce,
        );
        let ok = codec::decode(signature)
            .is_some_and(|sig| verify_signature(&hello.sign, &sig, challenge.as_bytes()));
        if !ok {
            return Err(AuthError::BadProof);
        }
        self.proven = true;
        Ok(vec![
            json!({ "v": PROTOCOL_VERSION, "kind": "auth_ok", "uid": self.own_uid }),
        ])
    }

    fn on_ok(&mut self, frame: &Value) -> Result<(), AuthError> {
        let uid = frame.get("uid").and_then(Value::as_str).unwrap_or_default();
        if self.peer_hello.as_ref().map(|h| h.uid.as_str()) != Some(uid) {
            return Err(AuthError::WrongAck);
        }
        self.acknowledged = true;
        Ok(())
    }
}
