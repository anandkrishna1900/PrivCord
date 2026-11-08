//! The Double Ratchet (`ratchet.ts`): HKDF-SHA-256 chains, AES-256-GCM with a derived IV, bounded skipped-message keys.
//!
//! One deliberate difference from the TypeScript: decrypting is atomic. The ratchet is only advanced when the message
//! authenticates, so a tampered or replayed message leaves it exactly as it was (the TypeScript documents this but can
//! leave a half-advanced state behind).

use super::keys::EcdhKeypair;
use crate::{
    aead,
    error::CryptoError,
    kdf::{blank, hkdf_sha256},
    rng::Entropy,
};
use privcord_domain::{blob::PublicJwk, codec};
use serde_json::{json, Value};
use zeroize::Zeroizing;

pub const MAX_SKIP: u32 = 1000;
const RK_INFO: &[u8] = b"DuoChat-RatchetRoot-v1";
const CK_MSG_INFO: &[u8] = b"DuoChat-MsgKey-v1";
const CK_NEXT_INFO: &[u8] = b"DuoChat-ChainNext-v1";
const MSG_EXPAND_INFO: &[u8] = b"DuoChat-MessageMaterial-v1";
const HEADER_PREFIX: &str = "duochat-dr-hdr-v1\n";
const MAX_COUNTER: u32 = MAX_SKIP * 100;

type Key32 = Zeroizing<[u8; 32]>;

const fn err(msg: &'static str) -> CryptoError {
    CryptoError::E2ee(msg)
}

fn kdf_rk(root: &[u8; 32], dh_output: &[u8; 32]) -> Result<(Key32, Key32), CryptoError> {
    let material = Zeroizing::new(hkdf_sha256::<64>(dh_output, root, RK_INFO)?);
    let mut rk = crate::kdf::blank::<32>();
    let mut ck = crate::kdf::blank::<32>();
    let (first, second) = material.split_at(32);
    rk.copy_from_slice(first);
    ck.copy_from_slice(second);
    Ok((Zeroizing::new(rk), Zeroizing::new(ck)))
}

fn kdf_ck(chain: &[u8; 32]) -> Result<(Key32, Key32), CryptoError> {
    let zeros = blank::<32>();
    Ok((
        Zeroizing::new(hkdf_sha256::<32>(chain, &zeros, CK_MSG_INFO)?),
        Zeroizing::new(hkdf_sha256::<32>(chain, &zeros, CK_NEXT_INFO)?),
    ))
}

/// The AES key and the IV, both derived from the message key: the IV is never random, so a broken RNG cannot repeat one.
fn message_material(message_key: &[u8; 32]) -> Result<(Key32, [u8; 12]), CryptoError> {
    let m = Zeroizing::new(hkdf_sha256::<44>(
        message_key,
        &blank::<32>(),
        MSG_EXPAND_INFO,
    )?);
    let mut key = crate::kdf::blank::<32>();
    let mut iv = crate::kdf::blank::<12>();
    let (first, second) = m.split_at(32);
    key.copy_from_slice(first);
    iv.copy_from_slice(second);
    Ok((Zeroizing::new(key), iv))
}

/// What travels in the clear beside each message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RatchetHeader {
    /// The sender's current ratchet public key, base64url of `x || y`.
    pub dh: String,
    /// Index of this message in the sender's current chain.
    pub n: u32,
    /// Messages in the previous sending chain.
    pub pn: u32,
}

impl RatchetHeader {
    pub fn to_value(&self) -> Value {
        json!({ "dh": self.dh, "n": self.n, "pn": self.pn })
    }

    pub fn from_value(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        let counter = |k: &str| {
            let n = o.get(k)?.as_f64()?;
            (n.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&n)).then_some(n as u32)
        };
        Some(Self {
            dh: o.get("dh")?.as_str()?.to_owned(),
            n: counter("n")?,
            pn: counter("pn")?,
        })
    }

    /// The bytes that are authenticated with every message.
    pub fn encode(&self) -> Result<Vec<u8>, CryptoError> {
        let ok_dh = !self.dh.is_empty()
            && self.dh.len() <= 200
            && self
                .dh
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !ok_dh || self.n > MAX_COUNTER || self.pn > MAX_COUNTER {
            return Err(err("Malformed ratchet header."));
        }
        Ok(format!("{HEADER_PREFIX}{}", self.to_value()).into_bytes())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptResult {
    pub header: RatchetHeader,
    /// base64url of the AES-GCM ciphertext with its 128-bit tag (the IV is derived, not sent).
    pub body: String,
}

#[derive(Clone)]
struct State {
    dhs: Option<EcdhKeypair>,
    /// The remote ratchet public key, base64url of `x || y`.
    dhr: Option<String>,
    rk: Key32,
    cks: Option<Key32>,
    ckr: Option<Key32>,
    ns: u32,
    nr: u32,
    pn: u32,
    /// Keys of earlier chain positions, oldest first; bounded and single-use.
    skipped: Vec<(String, u32, Key32)>,
}

pub struct DoubleRatchet {
    state: State,
}

impl std::fmt::Debug for DoubleRatchet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DoubleRatchet(..)")
    }
}

fn pub_bytes(jwk: &PublicJwk) -> Result<[u8; 64], CryptoError> {
    let x = codec::decode(&jwk.x).filter(|b| b.len() == 32);
    let y = codec::decode(&jwk.y).filter(|b| b.len() == 32);
    let (Some(x), Some(y)) = (x, y) else {
        return Err(err("Malformed ratchet public key."));
    };
    let mut out = crate::kdf::blank::<64>();
    let (left, right) = out.split_at_mut(32);
    left.copy_from_slice(&x);
    right.copy_from_slice(&y);
    Ok(out)
}

fn jwk_from_pub(b64: &str) -> Result<PublicJwk, CryptoError> {
    let bytes = codec::decode(b64).filter(|b| b.len() == 64);
    let Some(b) = bytes else {
        return Err(err("Malformed ratchet public key."));
    };
    let (x, y) = b.split_at(32);
    Ok(PublicJwk::p256(codec::encode(x), codec::encode(y)))
}

fn aad_of(ad: &[u8], header: &[u8], context: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(ad.len() + header.len() + context.len() + 1);
    v.extend_from_slice(ad);
    v.extend_from_slice(header);
    v.push(b'\n');
    v.extend_from_slice(context.as_bytes());
    v
}

fn split_body(body: &str) -> Result<Vec<u8>, CryptoError> {
    codec::decode(body)
        .filter(|b| b.len() >= 16)
        .ok_or(err("Ciphertext body is too short."))
}

impl DoubleRatchet {
    /// Initiator (Alice): the root key comes from X3DH; the first sending key is her ephemeral key; the first remote
    /// key is Bob's signed prekey.
    pub fn init_initiator(
        root_key: &[u8; 32],
        own_ratchet_key: EcdhKeypair,
        remote_ratchet: &PublicJwk,
    ) -> Result<Self, CryptoError> {
        let dh = own_ratchet_key.agree(remote_ratchet)?;
        let (rk, ck) = kdf_rk(root_key, &dh)?;
        Ok(Self {
            state: State {
                dhs: Some(own_ratchet_key),
                dhr: Some(codec::encode(&pub_bytes(remote_ratchet)?)),
                rk,
                cks: Some(ck),
                ckr: None,
                ns: 0,
                nr: 0,
                pn: 0,
                skipped: Vec::new(),
            },
        })
    }

    /// Responder (Bob): the first remote key is the initiator's ephemeral key; his first ratchet key is his consumed
    /// signed prekey. His sending chain begins with his first message.
    pub fn init_responder(
        root_key: &[u8; 32],
        own_ratchet_key: EcdhKeypair,
        remote_initial: &PublicJwk,
    ) -> Result<Self, CryptoError> {
        let dh = own_ratchet_key.agree(remote_initial)?;
        let (rk, ck) = kdf_rk(root_key, &dh)?;
        Ok(Self {
            state: State {
                dhs: Some(own_ratchet_key),
                dhr: Some(codec::encode(&pub_bytes(remote_initial)?)),
                rk,
                cks: None,
                ckr: Some(ck),
                ns: 0,
                nr: 0,
                pn: 0,
                skipped: Vec::new(),
            },
        })
    }

    /// The persisted form (`SerializedRatchetState`): plain JSON, private keys as JWKs. The caller protects it at rest.
    pub fn serialize(&self) -> Value {
        let s = &self.state;
        let b = |k: &Key32| codec::encode(&**k);
        json!({
            "dhs": s.dhs.as_ref().map(EcdhKeypair::to_value),
            "dhr": s.dhr,
            "rk": b(&s.rk),
            "cks": s.cks.as_ref().map(b),
            "ckr": s.ckr.as_ref().map(b),
            "ns": s.ns,
            "nr": s.nr,
            "pn": s.pn,
            "mkSkipped": s.skipped.iter().map(|(dh, n, mk)| json!({ "dh": dh, "n": n, "mk": b(mk) })).collect::<Vec<_>>(),
        })
    }

    pub fn from_serialized(v: &Value) -> Result<Self, CryptoError> {
        let bad = || err("Malformed ratchet state.");
        let o = v.as_object().ok_or_else(bad)?;
        let key = |x: &Value| -> Result<Key32, CryptoError> {
            let b: [u8; 32] = codec::decode(x.as_str().ok_or_else(bad)?)
                .and_then(|b| b.try_into().ok())
                .ok_or_else(bad)?;
            Ok(Zeroizing::new(b))
        };
        let opt_key = |name: &str| -> Result<Option<Key32>, CryptoError> {
            match o.get(name) {
                None | Some(Value::Null) => Ok(None),
                Some(x) => key(x).map(Some),
            }
        };
        let counter = |name: &str| -> Result<u32, CryptoError> {
            let n = o.get(name).and_then(Value::as_f64).ok_or_else(bad)?;
            (n.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&n))
                .then_some(n as u32)
                .ok_or_else(bad)
        };
        let dhs = match o.get("dhs") {
            None | Some(Value::Null) => None,
            Some(x) => Some(EcdhKeypair::from_value(x)?),
        };
        let dhr = match o.get("dhr") {
            None | Some(Value::Null) => None,
            Some(x) => Some(x.as_str().ok_or_else(bad)?.to_owned()),
        };
        let mut skipped = Vec::new();
        for e in o
            .get("mkSkipped")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            skipped.push((
                e.get("dh")
                    .and_then(Value::as_str)
                    .ok_or_else(bad)?
                    .to_owned(),
                u32::try_from(e.get("n").and_then(Value::as_u64).ok_or_else(bad)?)
                    .map_err(|_| bad())?,
                key(e.get("mk").ok_or_else(bad)?)?,
            ));
        }
        Ok(Self {
            state: State {
                dhs,
                dhr,
                rk: key(o.get("rk").ok_or_else(bad)?)?,
                cks: opt_key("cks")?,
                ckr: opt_key("ckr")?,
                ns: counter("ns")?,
                nr: counter("nr")?,
                pn: counter("pn")?,
                skipped,
            },
        })
    }

    /// Encrypt one message. `ad` is the associated data from X3DH and `context` any public binding (the message id);
    /// both are authenticated.
    pub fn encrypt(
        &mut self,
        plaintext: &[u8],
        ad: &[u8],
        context: &str,
        entropy: &mut dyn Entropy,
    ) -> Result<EncryptResult, CryptoError> {
        let mut s = self.state.clone();
        let dhr = s
            .dhr
            .clone()
            .ok_or(err("Receiving ratchet key missing for sending."))?;
        if s.cks.is_none() || s.dhs.is_none() {
            // A sender without a chain ratchets a fresh key against the remote key before sending (Signal 5.2).
            let new_key = EcdhKeypair::generate(entropy)?;
            let (rk, ck) = kdf_rk(&s.rk, &*new_key.agree(&jwk_from_pub(&dhr)?)?)?;
            s.rk = rk;
            s.cks = Some(ck);
            s.dhs = Some(new_key);
            s.ns = 0;
        }
        if plaintext.len() > 1 << 20 {
            return Err(err("Payload too large for a ratchet message."));
        }
        let (Some(cks), Some(dhs)) = (s.cks.clone(), s.dhs.as_ref()) else {
            return Err(err("Receiving ratchet key missing for sending."));
        };
        let (message_key, next) = kdf_ck(&cks)?;
        let header = RatchetHeader {
            dh: codec::encode(&pub_bytes(dhs.public())?),
            n: s.ns,
            pn: s.pn,
        };
        let header_bytes = header.encode()?;
        let (key, iv) = message_material(&message_key)?;
        let ct = aead::encrypt(&*key, &iv, plaintext, &aad_of(ad, &header_bytes, context))?;
        s.cks = Some(next);
        s.ns += 1;
        self.state = s;
        Ok(EncryptResult {
            header,
            body: codec::encode(&ct),
        })
    }

    /// Decrypt one message. Refuses tampered, replayed and over-skipped messages; on any refusal the ratchet is as it was.
    pub fn decrypt(
        &mut self,
        header: &RatchetHeader,
        body: &str,
        ad: &[u8],
        context: &str,
        entropy: &mut dyn Entropy,
    ) -> Result<Vec<u8>, CryptoError> {
        let header_bytes = header.encode()?;
        let aad = aad_of(ad, &header_bytes, context);
        let ct = split_body(body)?;
        let mut s = self.state.clone();

        // 1. An earlier position: its key is single-use.
        if let Some(i) = s
            .skipped
            .iter()
            .position(|(dh, n, _)| *dh == header.dh && *n == header.n)
        {
            let (_, _, mk) = s.skipped.remove(i);
            let (key, iv) = message_material(&mk)?;
            let plain = aead::decrypt(&*key, &iv, &ct, &aad)?;
            self.state = s;
            return Ok(plain);
        }
        // 2. A new remote ratchet key triggers a DH ratchet.
        if s.dhr.as_deref() != Some(header.dh.as_str()) {
            skip_message_keys(&mut s, header.pn)?;
            dh_ratchet(&mut s, header, entropy)?;
        }
        // 3. Skip ahead in the current receiving chain (bounded).
        if header.n > MAX_SKIP {
            return Err(err("Too many skipped messages."));
        }
        skip_message_keys(&mut s, header.n)?;
        let ckr = s
            .ckr
            .clone()
            .ok_or(err("Receiving chain not established."))?;
        let (message_key, next) = kdf_ck(&ckr)?;
        let (key, iv) = message_material(&message_key)?;
        let plain = aead::decrypt(&*key, &iv, &ct, &aad)?;
        // Advance only after the message authenticated.
        s.ckr = Some(next);
        s.nr += 1;
        self.state = s;
        Ok(plain)
    }
}

fn skip_message_keys(s: &mut State, until: u32) -> Result<(), CryptoError> {
    let (Some(ckr), Some(dhr)) = (s.ckr.clone(), s.dhr.clone()) else {
        return Ok(());
    };
    if s.nr == until {
        return Ok(());
    }
    if until > s.nr + MAX_SKIP {
        return Err(err("Too many messages skipped inside a chain."));
    }
    if until < s.nr {
        // An earlier position that is not cached: consumed, replayed or unknown. It fails to authenticate later.
        return Ok(());
    }
    let mut ck = ckr;
    for i in s.nr..until {
        let (mk, next) = kdf_ck(&ck)?;
        s.skipped.push((dhr.clone(), i, mk));
        ck = next;
    }
    // Bounded storage: when the cache overflows, the oldest entries go.
    let overflow = s.skipped.len().saturating_sub(MAX_SKIP as usize);
    s.skipped.drain(..overflow);
    s.ckr = Some(ck);
    s.nr = until;
    Ok(())
}

fn dh_ratchet(
    s: &mut State,
    header: &RatchetHeader,
    entropy: &mut dyn Entropy,
) -> Result<(), CryptoError> {
    let remote = jwk_from_pub(&header.dh)?;
    let dhs = s.dhs.clone().ok_or(err("No current ratchet key."))?;
    s.pn = s.ns;
    s.ns = 0;
    s.nr = 0;
    let (rk, ckr) = kdf_rk(&s.rk, &*dhs.agree(&remote)?)?;
    s.rk = rk;
    s.ckr = Some(ckr);
    s.dhr = Some(header.dh.clone());
    s.cks = None;
    // A new sending key, ratcheted against the remote key (Signal 5.3 step 4).
    let new_key = EcdhKeypair::generate(entropy)?;
    let (rk, cks) = kdf_rk(&s.rk, &*new_key.agree(&remote)?)?;
    s.rk = rk;
    s.cks = Some(cks);
    s.dhs = Some(new_key);
    Ok(())
}
