//! `DuoEnvelope` and sessions (`envelope.ts`): the transport-independent encrypted container, and the calls that start a
//! session from a bundle, accept one, and send and receive along it.

use super::{
    ratchet::{DoubleRatchet, RatchetHeader},
    x3dh::{
        associated_data_of, initiate_x3dh, respond_x3dh, validate_bundle, OneTimePrekey,
        PrekeyBundle, PrekeyIntro, SignedPrekey,
    },
};
use crate::{
    canonical::canonical_json,
    error::CryptoError,
    identity::{verify_identity_proof, Identity},
    kdf::sha256,
    rng::Entropy,
};
use privcord_domain::{blob::PublicJwk, codec};
use serde_json::{json, Map, Value};

pub const ENVELOPE_VERSION: u64 = 1;

const fn err(msg: &'static str) -> CryptoError {
    CryptoError::E2ee(msg)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuoEnvelope {
    /// Public deduplication id (digest of the content).
    pub id: String,
    /// A caller-chosen public context bound by the authentication (for example the message id).
    pub ctx: String,
    pub header: RatchetHeader,
    pub body: String,
    /// Only on the first envelope of a session.
    pub prekey: Option<PrekeyIntro>,
}

impl DuoEnvelope {
    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("v".into(), json!(ENVELOPE_VERSION));
        o.insert("kind".into(), json!("dr1"));
        o.insert("id".into(), json!(self.id));
        o.insert("ctx".into(), json!(self.ctx));
        o.insert("header".into(), self.header.to_value());
        o.insert("body".into(), json!(self.body));
        if let Some(p) = &self.prekey {
            o.insert("prekey".into(), p.to_value());
        }
        Value::Object(o)
    }
}

/// Structural validation only; it does not try to decrypt.
pub fn validate_envelope(value: &Value) -> Option<DuoEnvelope> {
    let o = value.as_object()?;
    if o.get("v")?.as_u64()? != ENVELOPE_VERSION || o.get("kind")?.as_str()? != "dr1" {
        return None;
    }
    let id = o.get("id")?.as_str()?;
    let ctx = o.get("ctx")?.as_str()?;
    let body = o.get("body")?.as_str()?;
    if id.is_empty() || id.encode_utf16().count() > 64 {
        return None;
    }
    if ctx.is_empty() || ctx.encode_utf16().count() > 128 || body.is_empty() {
        return None;
    }
    let header = RatchetHeader::from_value(o.get("header")?)?;
    if header.dh.is_empty() {
        return None;
    }
    let prekey = match o.get("prekey") {
        None => None,
        Some(p) => Some(PrekeyIntro::from_value(p)?),
    };
    Some(DuoEnvelope {
        id: id.to_owned(),
        ctx: ctx.to_owned(),
        header,
        body: body.to_owned(),
        prekey,
    })
}

/// The digest of the canonical content, used as the public dedup id.
pub fn envelope_digest(
    ctx: &str,
    header: &RatchetHeader,
    body: &str,
    prekey: Option<&PrekeyIntro>,
) -> Result<String, CryptoError> {
    let canon = canonical_json(&json!({
        "kind": "dr1",
        "ctx": ctx,
        "header": header.to_value(),
        "body": body,
        "prekey": prekey.map(PrekeyIntro::to_value),
    }))?;
    Ok(codec::encode(&sha256(canon.as_bytes())))
}

/// SHA-256 of `JSON(thumb(self)) \n JSON(thumb(peer))` (the initiator's key first on both sides).
pub fn associated_data_for(self_dh: &PublicJwk, peer_dh: &PublicJwk) -> [u8; 32] {
    associated_data_of(self_dh, peer_dh)
}

/// A verified peer identity a session is bound to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContactIdentity {
    pub sign: PublicJwk,
    pub dh: PublicJwk,
    pub identity_proof: String,
}

impl ContactIdentity {
    fn to_value(&self) -> Value {
        json!({ "signJwk": self.sign, "dhJwk": self.dh, "identityProof": self.identity_proof })
    }
}

#[derive(Debug)]
pub struct DuoSession {
    pub contact: ContactIdentity,
    pub associated_data: [u8; 32],
    pub ratchet: DoubleRatchet,
}

pub fn serialize_session(s: &DuoSession) -> Value {
    json!({
        "contact": s.contact.to_value(),
        "associatedData": codec::encode(&s.associated_data),
        "ratchet": s.ratchet.serialize(),
    })
}

pub fn restore_session(v: &Value) -> Result<DuoSession, CryptoError> {
    let bad = || err("Malformed session snapshot.");
    let o = v.as_object().ok_or_else(bad)?;
    let c = o
        .get("contact")
        .and_then(Value::as_object)
        .ok_or_else(bad)?;
    let contact = ContactIdentity {
        sign: c
            .get("signJwk")
            .and_then(PublicJwk::from_value)
            .ok_or_else(bad)?,
        dh: c
            .get("dhJwk")
            .and_then(PublicJwk::from_value)
            .ok_or_else(bad)?,
        identity_proof: c
            .get("identityProof")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    };
    let associated_data: [u8; 32] = o
        .get("associatedData")
        .and_then(Value::as_str)
        .and_then(codec::decode)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(bad)?;
    Ok(DuoSession {
        contact,
        associated_data,
        ratchet: DoubleRatchet::from_serialized(o.get("ratchet").ok_or_else(bad)?)?,
    })
}

/// The prekeys the host app holds (and removes once used).
pub trait PrekeyInventory {
    fn signed_prekey(&self, id: i64) -> Option<&SignedPrekey>;
    fn one_time_prekey(&self, id: i64) -> Option<&OneTimePrekey>;
}

#[derive(Debug)]
pub struct SessionStart {
    /// The first envelope (it carries the prekey intro), ready for any transport.
    pub envelope: DuoEnvelope,
    pub session: DuoSession,
}

/// Initiator: start a session from a bundle and produce the first envelope. The bundle is validated here every time.
pub fn initiate_session(
    identity: &Identity,
    bundle: &PrekeyBundle,
    ctx: &str,
    payload: &[u8],
    entropy: &mut dyn Entropy,
) -> Result<SessionStart, CryptoError> {
    let initiation = initiate_x3dh(identity, bundle, entropy)?;
    let ad = initiation.result.associated_data;
    let mut ratchet = DoubleRatchet::init_initiator(
        &initiation.result.root_key,
        initiation.ephemeral.clone(),
        &bundle.signed_prekey_dh,
    )?;
    let sent = ratchet.encrypt(payload, &ad, ctx, entropy)?;
    let prekey = PrekeyIntro::create(identity, &initiation)?;
    let id = envelope_digest(ctx, &sent.header, &sent.body, Some(&prekey))?;
    Ok(SessionStart {
        envelope: DuoEnvelope {
            id,
            ctx: ctx.to_owned(),
            header: sent.header,
            body: sent.body,
            prekey: Some(prekey),
        },
        session: DuoSession {
            contact: ContactIdentity {
                sign: bundle.sign.clone(),
                dh: bundle.dh.clone(),
                identity_proof: bundle.identity_proof.clone(),
            },
            associated_data: ad,
            ratchet,
        },
    })
}

#[derive(Debug)]
pub struct AcceptedSession {
    pub session: DuoSession,
    pub payload: Vec<u8>,
    /// Prekeys the host should now remove, so the same intro cannot start a second session.
    pub consumed_signed_prekey_id: i64,
    pub consumed_one_time_prekey_id: Option<i64>,
}

/// Responder: take the session-starting envelope, decrypt its payload and derive the session.
pub fn accept_initial_envelope(
    identity: &Identity,
    inventory: &dyn PrekeyInventory,
    envelope: &DuoEnvelope,
    entropy: &mut dyn Entropy,
) -> Result<AcceptedSession, CryptoError> {
    let intro = envelope
        .prekey
        .as_ref()
        .ok_or(err("Not a session-initializing envelope."))?;
    if !verify_identity_proof(
        &intro.sender_sign,
        &intro.sender_dh,
        &intro.sender_identity_proof,
    ) {
        return Err(err("Sender identity proof is invalid."));
    }
    let signed = inventory
        .signed_prekey(intro.signed_prekey_id)
        .ok_or(err("Referenced signed prekey is unknown."))?;
    let one_time = intro
        .one_time_prekey_id
        .and_then(|id| inventory.one_time_prekey(id));
    let x = respond_x3dh(identity, intro, signed, one_time)?;
    let mut ratchet =
        DoubleRatchet::init_responder(&x.root_key, signed.key.clone(), &intro.ephemeral_dh)?;
    let payload = ratchet.decrypt(
        &envelope.header,
        &envelope.body,
        &x.associated_data,
        &envelope.ctx,
        entropy,
    )?;
    Ok(AcceptedSession {
        session: DuoSession {
            contact: ContactIdentity {
                sign: intro.sender_sign.clone(),
                dh: intro.sender_dh.clone(),
                identity_proof: intro.sender_identity_proof.clone(),
            },
            associated_data: x.associated_data,
            ratchet,
        },
        payload,
        consumed_signed_prekey_id: intro.signed_prekey_id,
        consumed_one_time_prekey_id: intro.one_time_prekey_id,
    })
}

/// Encrypt the next outgoing message of an established session.
pub fn encrypt_to_envelope(
    session: &mut DuoSession,
    ctx: &str,
    payload: &[u8],
    entropy: &mut dyn Entropy,
) -> Result<DuoEnvelope, CryptoError> {
    let sent = session
        .ratchet
        .encrypt(payload, &session.associated_data, ctx, entropy)?;
    Ok(DuoEnvelope {
        id: envelope_digest(ctx, &sent.header, &sent.body, None)?,
        ctx: ctx.to_owned(),
        header: sent.header,
        body: sent.body,
        prekey: None,
    })
}

/// Decrypt a follow-up envelope. The caller dedups by `id` first; the ratchet also refuses any position already used.
pub fn decrypt_envelope(
    session: &mut DuoSession,
    envelope: &DuoEnvelope,
    entropy: &mut dyn Entropy,
) -> Result<Vec<u8>, CryptoError> {
    if envelope.prekey.is_some() {
        return Err(err(
            "Prekey envelope belongs to a new session; accept it there.",
        ));
    }
    session.ratchet.decrypt(
        &envelope.header,
        &envelope.body,
        &session.associated_data,
        &envelope.ctx,
        entropy,
    )
}

/// Validate a fetched bundle's JSON and keep it for `initiate_session` (a convenience over `validate_bundle`).
pub fn parse_bundle(value: &Value) -> Result<PrekeyBundle, &'static str> {
    validate_bundle(value)
}
