//! An ECDH key pair on P-256 as the TypeScript protocol stores it: a public JWK and a private JWK (with `d`).

use crate::{
    error::CryptoError,
    identity::{jwk_of, public_key_from_jwk, SharedSecret},
    rng::{random_secret_key, Entropy},
};
use p256::{ecdh::diffie_hellman, SecretKey};
use privcord_domain::{blob::PublicJwk, codec};
use serde_json::{json, Value};
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct EcdhKeypair {
    secret: SecretKey,
    public: PublicJwk,
}

impl std::fmt::Debug for EcdhKeypair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EcdhKeypair(..)")
    }
}

impl EcdhKeypair {
    pub fn generate(entropy: &mut dyn Entropy) -> Result<Self, CryptoError> {
        Ok(Self::from_secret(random_secret_key(entropy)?))
    }

    pub fn from_secret(secret: SecretKey) -> Self {
        let public = jwk_of(&secret.public_key());
        Self { secret, public }
    }

    pub fn public(&self) -> &PublicJwk {
        &self.public
    }

    /// The shared x coordinate with a peer's public key (what WebCrypto's `deriveBits` returns). Fails for a key that is
    /// not on the curve.
    pub fn agree(&self, peer: &PublicJwk) -> Result<SharedSecret, CryptoError> {
        let peer = public_key_from_jwk(peer)?;
        let shared = diffie_hellman(self.secret.to_nonzero_scalar(), peer.as_affine());
        let mut out = [0u8; 32];
        out.copy_from_slice(shared.raw_secret_bytes());
        Ok(Zeroizing::new(out))
    }

    /// `{ privJwk, pubJwk }` as the TypeScript persists it.
    pub fn to_value(&self) -> Value {
        let d = codec::encode(&self.secret.to_bytes());
        json!({
            "privJwk": {
                "kty": "EC", "crv": "P-256", "x": self.public.x, "y": self.public.y, "d": d,
                "ext": true, "key_ops": ["deriveBits"],
            },
            "pubJwk": { "kty": "EC", "crv": "P-256", "x": self.public.x, "y": self.public.y },
        })
    }

    /// Reads it back; the stored public half must be the one the private scalar gives.
    pub fn from_value(v: &Value) -> Result<Self, CryptoError> {
        let d = v
            .get("privJwk")
            .and_then(|p| p.get("d"))
            .and_then(Value::as_str)
            .and_then(codec::decode)
            .ok_or(CryptoError::InvalidKey)?;
        let secret = SecretKey::from_slice(&d).map_err(|_| CryptoError::InvalidKey)?;
        let pair = Self::from_secret(secret);
        if let Some(stored) = v.get("pubJwk").and_then(PublicJwk::from_value) {
            if stored != pair.public {
                return Err(CryptoError::InvalidKey);
            }
        }
        Ok(pair)
    }
}
