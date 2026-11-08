//! Link encryption over an untrusted radio or data channel (`connectivity/secureChannel.ts`).
//!
//! Both sides send a signed hello (a fresh ECDH key and a nonce), derive two directional AES-256-GCM keys, and then
//! every frame is encrypted with a counter that only moves forward, so a replayed or reordered frame is refused.

use crate::{
    aead,
    canonical::canonical_json,
    error::CryptoError,
    identity::{jwk_of, public_key_from_jwk, verify_signature, Identity},
    kdf::hkdf_sha256,
    rng::{random_array, Entropy, RngAdapter},
};
use p256::{ecdh::diffie_hellman, SecretKey};
use privcord_domain::{blob::PublicJwk, codec, text::cmp_utf16};
use serde_json::{json, Value};
use zeroize::Zeroizing;

const MAX_COUNTER: u64 = 1 << 48;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hello {
    pub epk: PublicJwk,
    pub nonce: String,
    pub sig: String,
}

impl Hello {
    pub fn to_value(&self) -> Value {
        json!({ "v": 1, "kind": "sc_hello", "epk": self.epk, "nonce": self.nonce, "sig": self.sig })
    }

    /// `None` unless it has the right shape (a nonce of at least 16 characters, a valid key, a signature string).
    pub fn from_value(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        if o.get("v")?.as_u64()? != 1 || o.get("kind")?.as_str()? != "sc_hello" {
            return None;
        }
        let nonce = o.get("nonce")?.as_str()?;
        if nonce.encode_utf16().count() < 16 {
            return None;
        }
        Some(Self { epk: PublicJwk::from_value(o.get("epk")?)?, nonce: nonce.to_owned(), sig: o.get("sig")?.as_str()?.to_owned() })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Data {
    pub n: u64,
    pub ct: String,
}

impl Data {
    pub fn to_value(&self) -> Value {
        json!({ "v": 1, "kind": "sc_data", "n": self.n, "ct": self.ct })
    }

    pub fn from_value(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        if o.get("v")?.as_u64()? != 1 || o.get("kind")?.as_str()? != "sc_data" {
            return None;
        }
        let n = o.get("n")?.as_u64().filter(|n| *n <= 9_007_199_254_740_991)?;
        Some(Self { n, ct: o.get("ct")?.as_str()?.to_owned() })
    }
}

fn hello_payload(own_uid: &str, peer_uid: &str, epk: &PublicJwk, nonce: &str) -> Result<Vec<u8>, CryptoError> {
    let thumb = canonical_json(&json!({ "crv": epk.crv, "kty": epk.kty, "x": epk.x, "y": epk.y }))?;
    Ok(format!("duochat-sc-v1|{own_uid}|{peer_uid}|{thumb}|{nonce}").into_bytes())
}

fn frame_iv(counter: u64) -> [u8; 12] {
    let mut iv = [0u8; 12];
    iv[4..].copy_from_slice(&counter.to_be_bytes());
    iv
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ChannelError {
    #[error("Secure channel already established.")]
    AlreadyEstablished,
    #[error("Secure channel handshake was not signed by the paired contact.")]
    BadHandshake,
    #[error("Secure channel is not established.")]
    NotEstablished,
    #[error("Secure channel exhausted; reconnect.")]
    Exhausted,
    #[error("Replayed or out-of-order frame.")]
    Replay,
    #[error("Could not decrypt the frame.")]
    Decrypt,
    #[error(transparent)]
    Crypto(#[from] CryptoError),
}

struct Keys {
    send: Zeroizing<[u8; 32]>,
    recv: Zeroizing<[u8; 32]>,
}

/// One side of one link.
pub struct SecureChannel {
    own_uid: String,
    peer_uid: String,
    peer_sign: PublicJwk,
    ephemeral: SecretKey,
    nonce: String,
    keys: Option<Keys>,
    send_counter: u64,
    recv_counter: Option<u64>,
}

impl std::fmt::Debug for SecureChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecureChannel").field("ready", &self.ready()).finish_non_exhaustive()
    }
}

impl SecureChannel {
    pub fn new(own_uid: &str, peer_uid: &str, peer_sign: PublicJwk, entropy: &mut dyn Entropy) -> Result<Self, CryptoError> {
        let ephemeral = SecretKey::random(&mut RngAdapter(entropy));
        let nonce = codec::encode(&random_array::<16>(entropy)?);
        Ok(Self::with_parts(own_uid, peer_uid, peer_sign, ephemeral, nonce))
    }

    /// For tests that must reproduce exact bytes.
    #[cfg(any(test, feature = "test-support"))]
    pub fn with_fixed(own_uid: &str, peer_uid: &str, peer_sign: PublicJwk, ephemeral_scalar: &[u8; 32], nonce: &str) -> Result<Self, CryptoError> {
        let ephemeral = SecretKey::from_slice(ephemeral_scalar).map_err(|_| CryptoError::InvalidKey)?;
        Ok(Self::with_parts(own_uid, peer_uid, peer_sign, ephemeral, nonce.to_owned()))
    }

    fn with_parts(own_uid: &str, peer_uid: &str, peer_sign: PublicJwk, ephemeral: SecretKey, nonce: String) -> Self {
        Self { own_uid: own_uid.to_owned(), peer_uid: peer_uid.to_owned(), peer_sign, ephemeral, nonce, keys: None, send_counter: 0, recv_counter: None }
    }

    pub fn ready(&self) -> bool {
        self.keys.is_some()
    }

    /// Our signed hello.
    pub fn hello(&self, identity: &Identity) -> Result<Hello, CryptoError> {
        let epk = jwk_of(&self.ephemeral.public_key());
        let payload = hello_payload(&self.own_uid, &self.peer_uid, &epk, &self.nonce)?;
        Ok(Hello { sig: codec::encode(&identity.sign_message(&payload)), epk, nonce: self.nonce.clone() })
    }

    /// Their hello: check it was signed by the paired contact, then derive the keys.
    pub fn accept(&mut self, hello: &Hello) -> Result<(), ChannelError> {
        if self.ready() {
            return Err(ChannelError::AlreadyEstablished);
        }
        // The peer signed (its uid | our uid), so the order is swapped when verifying.
        let payload = hello_payload(&self.peer_uid, &self.own_uid, &hello.epk, &hello.nonce)?;
        let sig = codec::decode(&hello.sig).ok_or(ChannelError::BadHandshake)?;
        if !verify_signature(&self.peer_sign, &sig, &payload) {
            return Err(ChannelError::BadHandshake);
        }
        let peer = public_key_from_jwk(&hello.epk).map_err(|_| ChannelError::BadHandshake)?;
        let shared = diffie_hellman(self.ephemeral.to_nonzero_scalar(), peer.as_affine());
        let low_is_me = cmp_utf16(&self.own_uid, &self.peer_uid).is_lt();
        let (n_low, n_high) = if low_is_me { (&self.nonce, &hello.nonce) } else { (&hello.nonce, &self.nonce) };
        let salt = format!("{n_low}|{n_high}");
        let low = Zeroizing::new(hkdf_sha256::<32>(shared.raw_secret_bytes(), salt.as_bytes(), b"duochat-sc-v1|low->high")?);
        let high = Zeroizing::new(hkdf_sha256::<32>(shared.raw_secret_bytes(), salt.as_bytes(), b"duochat-sc-v1|high->low")?);
        self.keys = Some(if low_is_me { Keys { send: low, recv: high } } else { Keys { send: high, recv: low } });
        Ok(())
    }

    pub fn encrypt(&mut self, value: &Value) -> Result<Data, ChannelError> {
        let keys = self.keys.as_ref().ok_or(ChannelError::NotEstablished)?;
        if self.send_counter >= MAX_COUNTER {
            return Err(ChannelError::Exhausted);
        }
        let n = self.send_counter;
        self.send_counter += 1;
        let ct = aead::encrypt(&*keys.send, &frame_iv(n), value.to_string().as_bytes(), format!("sc|{n}").as_bytes())?;
        Ok(Data { n, ct: codec::encode(&ct) })
    }

    pub fn decrypt(&mut self, frame: &Data) -> Result<Value, ChannelError> {
        let keys = self.keys.as_ref().ok_or(ChannelError::NotEstablished)?;
        if self.recv_counter.is_some_and(|last| frame.n <= last) {
            return Err(ChannelError::Replay);
        }
        let ct = codec::decode(&frame.ct).ok_or(ChannelError::Decrypt)?;
        let plain = aead::decrypt(&*keys.recv, &frame_iv(frame.n), &ct, format!("sc|{}", frame.n).as_bytes()).map_err(|_| ChannelError::Decrypt)?;
        self.recv_counter = Some(frame.n);
        serde_json::from_slice(&plain).map_err(|_| ChannelError::Decrypt)
    }
}
