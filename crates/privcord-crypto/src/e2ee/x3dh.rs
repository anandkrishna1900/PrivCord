//! X3DH on P-256 (`x3dh.ts`): prekeys, bundles, and the shared secret both sides derive.
//!
//! ```text
//! DH1 = DH(IKa, SPKb)  DH2 = DH(EKa, IKb)  DH3 = DH(EKa, SPKb)  [DH4 = DH(EKa, OPKb)]
//! SK  = HKDF(0xFF*32 || DH1 || DH2 || DH3 [|| DH4], salt = 32 zero bytes, info = "DuoChat-X3DH-v1")
//! AD  = SHA-256(TH(IKa) || 0x0A || TH(IKb))
//! ```

use super::keys::EcdhKeypair;
use crate::{
    canonical::canonical_json,
    error::CryptoError,
    identity::{thumb, verify_identity_proof, verify_signature, Identity},
    kdf::{blank, hkdf_sha256, sha256},
    rng::Entropy,
};
use privcord_domain::{blob::PublicJwk, codec};
use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

pub const X3DH_INFO: &str = "DuoChat-X3DH-v1";
pub const SIGNED_PREKEY_PREFIX: &str = "duochat-signed-prekey-v1\n";
pub const BUNDLE_VERSION: u64 = 1;

const fn err(msg: &'static str) -> CryptoError {
    CryptoError::E2ee(msg)
}

/// A signed prekey: an ECDH key whose public half the identity signing key has signed.
#[derive(Debug, Clone)]
pub struct SignedPrekey {
    pub id: i64,
    pub key: EcdhKeypair,
    /// base64url ECDSA signature by the identity signing key.
    pub signature: String,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct OneTimePrekey {
    pub id: i64,
    pub key: EcdhKeypair,
}

fn signed_prekey_payload(dh: &PublicJwk) -> Result<Vec<u8>, CryptoError> {
    Ok(format!("{SIGNED_PREKEY_PREFIX}{}", canonical_json(&thumb(dh))?).into_bytes())
}

pub fn create_signed_prekey(
    identity: &Identity,
    id: i64,
    now_ms: i64,
    entropy: &mut dyn Entropy,
) -> Result<SignedPrekey, CryptoError> {
    if id <= 0 {
        return Err(err("Prekey id must be a positive integer."));
    }
    let key = EcdhKeypair::generate(entropy)?;
    let signature = codec::encode(&identity.sign_message(&signed_prekey_payload(key.public())?));
    Ok(SignedPrekey {
        id,
        key,
        signature,
        created_at: now_ms,
    })
}

pub fn create_one_time_prekey(
    id: i64,
    entropy: &mut dyn Entropy,
) -> Result<OneTimePrekey, CryptoError> {
    if id <= 0 {
        return Err(err("Prekey id must be a positive integer."));
    }
    Ok(OneTimePrekey {
        id,
        key: EcdhKeypair::generate(entropy)?,
    })
}

/// The public part a person publishes so others can start a session with them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrekeyBundle {
    pub sign: PublicJwk,
    pub dh: PublicJwk,
    pub identity_proof: String,
    pub signed_prekey_id: i64,
    pub signed_prekey_dh: PublicJwk,
    pub signed_prekey_signature: String,
    pub signed_prekey_created_at: i64,
    pub one_time_prekey: Option<(i64, PublicJwk)>,
}

impl PrekeyBundle {
    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("version".into(), json!(BUNDLE_VERSION));
        o.insert(
            "identity".into(),
            json!({ "signJwk": self.sign, "dhJwk": self.dh, "identityProof": self.identity_proof }),
        );
        o.insert(
            "signedPrekey".into(),
            json!({ "id": self.signed_prekey_id, "dhJwk": self.signed_prekey_dh,
                    "signature": self.signed_prekey_signature, "createdAt": self.signed_prekey_created_at }),
        );
        if let Some((id, dh)) = &self.one_time_prekey {
            o.insert("oneTimePrekey".into(), json!({ "id": id, "dhJwk": dh }));
        }
        Value::Object(o)
    }
}

pub fn create_bundle(
    identity: &Identity,
    signed: &SignedPrekey,
    one_time: Option<&OneTimePrekey>,
) -> Result<PrekeyBundle, CryptoError> {
    Ok(PrekeyBundle {
        sign: identity.sign_public(),
        dh: identity.dh_public(),
        identity_proof: identity.identity_proof()?,
        signed_prekey_id: signed.id,
        signed_prekey_dh: signed.key.public().clone(),
        signed_prekey_signature: signed.signature.clone(),
        signed_prekey_created_at: signed.created_at,
        one_time_prekey: one_time.map(|o| (o.id, o.key.public().clone())),
    })
}

fn integer(v: &Value) -> Option<i64> {
    let n = v.as_f64()?;
    (n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n as i64)
}

/// Full structural and cryptographic validation of a bundle. A bundle that fails this is not trusted for anything. The
/// error text is the one the TypeScript gives.
pub fn validate_bundle(value: &Value) -> Result<PrekeyBundle, &'static str> {
    let o = value.as_object().ok_or("Malformed bundle.")?;
    if o.get("version").and_then(Value::as_u64) != Some(BUNDLE_VERSION) {
        return Err("Unsupported bundle version.");
    }
    let id = o.get("identity").and_then(Value::as_object);
    let sign = id
        .and_then(|i| i.get("signJwk"))
        .and_then(PublicJwk::from_value);
    let dh = id
        .and_then(|i| i.get("dhJwk"))
        .and_then(PublicJwk::from_value);
    let (Some(sign), Some(dh)) = (sign, dh) else {
        return Err("Bundle identity keys are malformed.");
    };
    let proof = id
        .and_then(|i| i.get("identityProof"))
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .ok_or("Bundle identity proof missing.")?;
    let spk = o.get("signedPrekey").and_then(Value::as_object);
    let spk_id = spk.and_then(|s| s.get("id")).and_then(integer);
    let spk_dh = spk
        .and_then(|s| s.get("dhJwk"))
        .and_then(PublicJwk::from_value);
    let (Some(spk_id), Some(spk_dh)) = (spk_id, spk_dh) else {
        return Err("Signed prekey is malformed.");
    };
    let sig = spk.and_then(|s| s.get("signature")).and_then(Value::as_str);
    let created = spk
        .and_then(|s| s.get("createdAt"))
        .and_then(Value::as_f64)
        .filter(|t| t.is_finite());
    let (Some(sig), Some(created)) = (sig, created) else {
        return Err("Signed prekey signature missing.");
    };
    let one_time = match o.get("oneTimePrekey") {
        None => None,
        Some(v) => {
            let oid = v.get("id").and_then(integer);
            let odh = v.get("dhJwk").and_then(PublicJwk::from_value);
            match (oid, odh) {
                (Some(i), Some(d)) => Some((i, d)),
                _ => return Err("One-time prekey is malformed."),
            }
        }
    };
    if !verify_identity_proof(&sign, &dh, proof) {
        return Err("Identity proof is invalid.");
    }
    let sig_bytes = codec::decode(sig).unwrap_or_default();
    let payload =
        signed_prekey_payload(&spk_dh).map_err(|_| "Signed prekey signature is invalid.")?;
    if !verify_signature(&sign, &sig_bytes, &payload) {
        return Err("Signed prekey signature is invalid.");
    }
    Ok(PrekeyBundle {
        sign,
        dh,
        identity_proof: proof.to_owned(),
        signed_prekey_id: spk_id,
        signed_prekey_dh: spk_dh,
        signed_prekey_signature: sig.to_owned(),
        signed_prekey_created_at: created as i64,
        one_time_prekey: one_time,
    })
}

#[derive(Debug)]
pub struct X3dhResult {
    /// The 32-byte initial root key for the Double Ratchet.
    pub root_key: Zeroizing<[u8; 32]>,
    /// 32 bytes bound to both identity ECDH keys.
    pub associated_data: [u8; 32],
}

#[derive(Debug)]
pub struct X3dhInitiation {
    pub result: X3dhResult,
    /// The ephemeral key; its public half must reach the responder.
    pub ephemeral: EcdhKeypair,
    pub used_signed_prekey_id: i64,
    pub used_one_time_prekey_id: Option<i64>,
}

fn derive_root(dh_outputs: &[&[u8; 32]]) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let mut ikm = Zeroizing::new(vec![0xffu8; 32]);
    for d in dh_outputs {
        ikm.extend_from_slice(*d);
    }
    Ok(Zeroizing::new(hkdf_sha256::<32>(
        &ikm,
        &blank::<32>(),
        X3DH_INFO.as_bytes(),
    )?))
}

/// SHA-256 of `JSON(thumb(a)) \n JSON(thumb(b))`: the same bytes on both sides, the initiator's key first.
pub fn associated_data_of(first: &PublicJwk, second: &PublicJwk) -> [u8; 32] {
    sha256(format!("{}\n{}", thumb(first), thumb(second)).as_bytes())
}

/// Initiator: validate the bundle (again, never trust a caller's earlier check) and derive the secret.
pub fn initiate_x3dh(
    identity: &Identity,
    bundle: &PrekeyBundle,
    entropy: &mut dyn Entropy,
) -> Result<X3dhInitiation, CryptoError> {
    validate_bundle(&bundle.to_value()).map_err(|_| err("Prekey bundle rejected."))?;
    let ephemeral = EcdhKeypair::generate(entropy)?;
    let dh1 = identity.agree(&bundle.signed_prekey_dh)?;
    let dh2 = ephemeral.agree(&bundle.dh)?;
    let dh3 = ephemeral.agree(&bundle.signed_prekey_dh)?;
    let dh4 = match &bundle.one_time_prekey {
        Some((_, dh)) => Some(ephemeral.agree(dh)?),
        None => None,
    };
    let mut outs: Vec<&[u8; 32]> = vec![&dh1, &dh2, &dh3];
    if let Some(d) = &dh4 {
        outs.push(d);
    }
    Ok(X3dhInitiation {
        result: X3dhResult {
            root_key: derive_root(&outs)?,
            associated_data: associated_data_of(&identity.dh_public(), &bundle.dh),
        },
        ephemeral,
        used_signed_prekey_id: bundle.signed_prekey_id,
        used_one_time_prekey_id: bundle.one_time_prekey.as_ref().map(|(i, _)| *i),
    })
}

/// Carried inside the first envelope of a session so the responder can derive the same secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrekeyIntro {
    pub sender_sign: PublicJwk,
    pub sender_dh: PublicJwk,
    pub sender_identity_proof: String,
    pub ephemeral_dh: PublicJwk,
    pub signed_prekey_id: i64,
    pub one_time_prekey_id: Option<i64>,
}

impl PrekeyIntro {
    pub fn create(identity: &Identity, initiation: &X3dhInitiation) -> Result<Self, CryptoError> {
        Ok(Self {
            sender_sign: identity.sign_public(),
            sender_dh: identity.dh_public(),
            sender_identity_proof: identity.identity_proof()?,
            ephemeral_dh: initiation.ephemeral.public().clone(),
            signed_prekey_id: initiation.used_signed_prekey_id,
            one_time_prekey_id: initiation.used_one_time_prekey_id,
        })
    }

    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("senderSignJwk".into(), json!(self.sender_sign));
        o.insert("senderDhJwk".into(), json!(self.sender_dh));
        o.insert(
            "senderIdentityProof".into(),
            json!(self.sender_identity_proof),
        );
        o.insert("ephemeralDhJwk".into(), json!(self.ephemeral_dh));
        o.insert("signedPrekeyId".into(), json!(self.signed_prekey_id));
        if let Some(id) = self.one_time_prekey_id {
            o.insert("oneTimePrekeyId".into(), json!(id));
        }
        Value::Object(o)
    }

    /// `None` unless every field is well formed (keys are only checked for shape here, as in the TypeScript).
    pub fn from_value(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        Some(Self {
            sender_sign: PublicJwk::from_value(o.get("senderSignJwk")?)?,
            sender_dh: PublicJwk::from_value(o.get("senderDhJwk")?)?,
            sender_identity_proof: o.get("senderIdentityProof")?.as_str()?.to_owned(),
            ephemeral_dh: PublicJwk::from_value(o.get("ephemeralDhJwk")?)?,
            signed_prekey_id: integer(o.get("signedPrekeyId")?)?,
            one_time_prekey_id: match o.get("oneTimePrekeyId") {
                None => None,
                Some(v) => Some(integer(v)?),
            },
        })
    }
}

/// Responder: derive the initiator's secret from an intro and the prekeys it names.
pub fn respond_x3dh(
    identity: &Identity,
    intro: &PrekeyIntro,
    signed_prekey: &SignedPrekey,
    one_time_prekey: Option<&OneTimePrekey>,
) -> Result<X3dhResult, CryptoError> {
    if signed_prekey.id != intro.signed_prekey_id {
        return Err(err("Intro points at an unknown signed prekey."));
    }
    if let (Some(otk), Some(id)) = (one_time_prekey, intro.one_time_prekey_id) {
        if otk.id != id {
            return Err(err("Intro points at an unknown one-time prekey."));
        }
    }
    // Mirror image of the initiator's DH1..4: DH(SPKb, IKa), DH(IKb, EKa), DH(SPKb, EKa), DH(OPKb, EKa).
    let dh1 = signed_prekey.key.agree(&intro.sender_dh)?;
    let dh2 = identity.agree(&intro.ephemeral_dh)?;
    let dh3 = signed_prekey.key.agree(&intro.ephemeral_dh)?;
    let dh4 = match (one_time_prekey, intro.one_time_prekey_id) {
        (Some(otk), Some(_)) => Some(otk.key.agree(&intro.ephemeral_dh)?),
        _ => None,
    };
    let mut outs: Vec<&[u8; 32]> = vec![&dh1, &dh2, &dh3];
    if let Some(d) = &dh4 {
        outs.push(d);
    }
    Ok(X3dhResult {
        root_key: derive_root(&outs)?,
        associated_data: associated_data_of(&intro.sender_dh, &identity.dh_public()),
    })
}
