//! Protocol v2 link layer: a post-quantum hybrid channel that runs inside any already-authenticated link (WebRTC, the
//! engine's secure channel, Bluetooth), so it upgrades every kind of link the same way and older apps simply ignore it.
//!
//! Handshake (symmetric, one round trip after the link is up):
//! * each side sends `pq_hello`: a fresh P-256 key, a fresh ML-KEM-768 key and a nonce, signed with its identity key;
//! * each side checks the other's signature against the pinned contact, encapsulates a secret to the other's ML-KEM key
//!   and sends the ciphertext (`pq_kem`);
//! * with both ciphertexts, both derive the same root from ECDH + both ML-KEM secrets + the whole transcript
//!   ([`crate::pq::combine`]). Breaking it needs breaking P-256 AND ML-KEM.
//!
//! Frames (`pq`): every frame has its own key from a one-way chain per direction (a symmetric ratchet). The chain only
//! moves forward and old keys are erased, so a device compromised later cannot read earlier frames of the session.
//! Plaintext is padded to a bucket size before encryption, so the length of a frame says little about its content.

use crate::{
    aead,
    canonical::canonical_json,
    error::CryptoError,
    identity::{jwk_of, public_key_from_jwk, verify_signature, Identity},
    kdf::hkdf_expand,
    pq::{
        combine, fingerprint, kem_encapsulate, KemKeyPair, KEM_CIPHERTEXT_BYTES, KEM_PUBLIC_BYTES,
    },
    rng::{random_array, random_secret_key, Entropy},
    secure_channel::ChannelError,
};
use p256::{ecdh::diffie_hellman, SecretKey};
use privcord_domain::{blob::PublicJwk, codec, text::cmp_utf16};
use serde_json::{json, Value};
use zeroize::Zeroizing;

pub const PQ_VERSION: u64 = 2;
/// A frame may skip at most this many frames ahead (lost frames); beyond that it is refused.
const MAX_SKIP: u64 = 50_000;
const MAX_INDEX: u64 = 1 << 48;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PqHello {
    pub epk: PublicJwk,
    pub kem: String,
    pub nonce: String,
    pub sig: String,
}

impl PqHello {
    pub fn to_value(&self) -> Value {
        json!({ "v": PQ_VERSION, "kind": "pq_hello", "epk": self.epk, "kem": self.kem, "nonce": self.nonce, "sig": self.sig })
    }

    pub fn from_value(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        if o.get("v")?.as_u64()? != PQ_VERSION || o.get("kind")?.as_str()? != "pq_hello" {
            return None;
        }
        let nonce = o.get("nonce")?.as_str()?;
        if nonce.len() < 16 || nonce.len() > 64 {
            return None;
        }
        Some(Self {
            epk: PublicJwk::from_value(o.get("epk")?)?,
            kem: o.get("kem")?.as_str()?.to_owned(),
            nonce: nonce.to_owned(),
            sig: o.get("sig")?.as_str()?.to_owned(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PqKem {
    pub ct: String,
}

impl PqKem {
    pub fn to_value(&self) -> Value {
        json!({ "v": PQ_VERSION, "kind": "pq_kem", "ct": self.ct })
    }

    pub fn from_value(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        if o.get("v")?.as_u64()? != PQ_VERSION || o.get("kind")?.as_str()? != "pq_kem" {
            return None;
        }
        Some(Self {
            ct: o.get("ct")?.as_str()?.to_owned(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PqData {
    pub n: u64,
    pub ct: String,
}

impl PqData {
    pub fn to_value(&self) -> Value {
        json!({ "v": PQ_VERSION, "kind": "pq", "n": self.n, "ct": self.ct })
    }

    pub fn from_value(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        if o.get("v")?.as_u64()? != PQ_VERSION || o.get("kind")?.as_str()? != "pq" {
            return None;
        }
        Some(Self {
            n: o.get("n")?.as_u64().filter(|n| *n < MAX_INDEX)?,
            ct: o.get("ct")?.as_str()?.to_owned(),
        })
    }
}

/// What a signature covers: who signs for whom, both public keys (the ML-KEM one by its hash) and the nonce.
fn hello_payload(
    signer: &str,
    other: &str,
    epk: &PublicJwk,
    kem: &[u8],
    nonce: &str,
) -> Result<Vec<u8>, CryptoError> {
    let thumb = canonical_json(&json!({ "crv": epk.crv, "kty": epk.kty, "x": epk.x, "y": epk.y }))?;
    let kem_hash = codec::encode(&fingerprint(kem));
    Ok(format!("duocord-pq-v2|{signer}|{other}|{thumb}|{kem_hash}|{nonce}").into_bytes())
}

type Secret = Zeroizing<[u8; 32]>;

/// One direction of the symmetric ratchet: `index` is the next frame number, `key` its chain key.
struct Chain {
    key: Zeroizing<[u8; 32]>,
    index: u64,
}

impl Chain {
    /// The key for the frame at `index`, and the chain key after it (HKDF-SHA-256 with two labels, so neither can be
    /// worked out from the other).
    fn step(key: &[u8; 32]) -> Result<(Secret, Secret), CryptoError> {
        Ok((
            Zeroizing::new(hkdf_expand::<32>(key, b"duocord-pq-v2|frame-key")?),
            Zeroizing::new(hkdf_expand::<32>(key, b"duocord-pq-v2|chain-key")?),
        ))
    }
}

/// Pads to a bucket: 256-byte steps up to 4 KiB, then 4 KiB steps. ISO 7816-4 style (0x80 then zeros).
pub(crate) fn pad(plain: &[u8]) -> Vec<u8> {
    let need = plain.len() + 1;
    let size = if need <= 4096 {
        need.div_ceil(256) * 256
    } else {
        need.div_ceil(4096) * 4096
    };
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(plain);
    out.push(0x80);
    out.resize(size, 0);
    out
}

pub(crate) fn unpad(padded: &[u8]) -> Option<&[u8]> {
    let end = padded.iter().rposition(|b| *b != 0)?;
    (padded.get(end) == Some(&0x80))
        .then(|| padded.get(..end))
        .flatten()
}

/// The nonce for frame `n`: its number, big-endian, in the last 8 of 12 bytes. Every frame has its own key, so a nonce
/// is never reused under a key.
fn frame_iv(n: u64) -> [u8; 12] {
    let counter = n.to_be_bytes();
    std::array::from_fn(|i| {
        i.checked_sub(4)
            .and_then(|j| counter.get(j))
            .copied()
            .unwrap_or_default()
    })
}

/// One side of the v2 channel on one link.
pub struct PqChannel {
    own_uid: String,
    peer_uid: String,
    peer_sign: PublicJwk,
    ephemeral: SecretKey,
    kem: KemKeyPair,
    nonce: String,
    own_payload: Vec<u8>,
    /// Their signed hello, once checked: (signed payload, P-256 key, ML-KEM key).
    peer: Option<(Vec<u8>, PublicJwk, Vec<u8>)>,
    /// The ciphertext we sent them and its secret.
    sent: Option<(Vec<u8>, Zeroizing<[u8; 32]>)>,
    /// The ciphertext they sent us and its secret.
    got: Option<(Vec<u8>, Zeroizing<[u8; 32]>)>,
    send: Option<Chain>,
    recv: Option<Chain>,
    /// The handshake is over (its ML-KEM secrets were dropped); a repeated hello or ciphertext is refused.
    done: bool,
}

impl std::fmt::Debug for PqChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PqChannel")
            .field("ready", &self.ready())
            .finish_non_exhaustive()
    }
}

impl PqChannel {
    pub fn new(
        own_uid: &str,
        peer_uid: &str,
        peer_sign: PublicJwk,
        entropy: &mut dyn Entropy,
    ) -> Result<Self, CryptoError> {
        let ephemeral = random_secret_key(entropy)?;
        let kem = KemKeyPair::generate(entropy)?;
        let nonce = codec::encode(&random_array::<16>(entropy)?);
        let own_payload = hello_payload(
            own_uid,
            peer_uid,
            &jwk_of(&ephemeral.public_key()),
            kem.public(),
            &nonce,
        )?;
        Ok(Self {
            own_uid: own_uid.to_owned(),
            peer_uid: peer_uid.to_owned(),
            peer_sign,
            ephemeral,
            kem,
            nonce,
            own_payload,
            peer: None,
            sent: None,
            got: None,
            send: None,
            recv: None,
            done: false,
        })
    }

    pub fn ready(&self) -> bool {
        self.send.is_some() && self.recv.is_some()
    }

    /// Our signed hello.
    pub fn hello(&self, identity: &Identity) -> PqHello {
        PqHello {
            epk: jwk_of(&self.ephemeral.public_key()),
            kem: codec::encode(self.kem.public()),
            nonce: self.nonce.clone(),
            sig: codec::encode(&identity.sign_message(&self.own_payload)),
        }
    }

    /// Their hello: check it was signed by the pinned contact, then encapsulate to their ML-KEM key. Returns the
    /// ciphertext frame to send them.
    pub fn on_hello(
        &mut self,
        hello: &PqHello,
        entropy: &mut dyn Entropy,
    ) -> Result<PqKem, ChannelError> {
        if self.peer.is_some() || self.done {
            return Err(ChannelError::AlreadyEstablished);
        }
        let kem = codec::decode(&hello.kem)
            .filter(|k| k.len() == KEM_PUBLIC_BYTES)
            .ok_or(ChannelError::BadHandshake)?;
        let payload = hello_payload(
            &self.peer_uid,
            &self.own_uid,
            &hello.epk,
            &kem,
            &hello.nonce,
        )?;
        let sig = codec::decode(&hello.sig).ok_or(ChannelError::BadHandshake)?;
        if !verify_signature(&self.peer_sign, &sig, &payload) {
            return Err(ChannelError::BadHandshake);
        }
        public_key_from_jwk(&hello.epk).map_err(|_| ChannelError::BadHandshake)?;
        let (ct, ss) = kem_encapsulate(&kem, entropy).map_err(|_| ChannelError::BadHandshake)?;
        let frame = PqKem {
            ct: codec::encode(&ct),
        };
        self.peer = Some((payload, hello.epk.clone(), kem));
        self.sent = Some((ct, ss));
        self.finish()?;
        Ok(frame)
    }

    /// Their ciphertext for our ML-KEM key.
    pub fn on_kem(&mut self, frame: &PqKem) -> Result<(), ChannelError> {
        if self.got.is_some() || self.done {
            return Err(ChannelError::AlreadyEstablished);
        }
        let ct = codec::decode(&frame.ct)
            .filter(|c| c.len() == KEM_CIPHERTEXT_BYTES)
            .ok_or(ChannelError::BadHandshake)?;
        let ss = self.kem.decapsulate(&ct)?;
        self.got = Some((ct, ss));
        self.finish()
    }

    /// With their hello and both ciphertexts in hand, derive the two chains.
    fn finish(&mut self) -> Result<(), ChannelError> {
        let (Some((peer_payload, peer_epk, _)), Some((sent_ct, sent_ss)), Some((got_ct, got_ss))) =
            (&self.peer, &self.sent, &self.got)
        else {
            return Ok(());
        };
        let peer_key = public_key_from_jwk(peer_epk).map_err(|_| ChannelError::BadHandshake)?;
        let shared = diffie_hellman(self.ephemeral.to_nonzero_scalar(), peer_key.as_affine());
        let low_is_me = cmp_utf16(&self.own_uid, &self.peer_uid).is_lt();
        // Everything in an order both sides agree on: the lower uid's parts first.
        let (pay_low, pay_high) = if low_is_me {
            (&self.own_payload, peer_payload)
        } else {
            (peer_payload, &self.own_payload)
        };
        // `sent` is what we encapsulated (to them), `got` what they encapsulated (to us).
        let ((ct_low, ss_low), (ct_high, ss_high)) = if low_is_me {
            ((sent_ct, sent_ss), (got_ct, got_ss))
        } else {
            ((got_ct, got_ss), (sent_ct, sent_ss))
        };
        let root = combine(
            "duocord-pq-v2|root",
            shared.raw_secret_bytes(),
            &[ss_low, ss_high],
            &[pay_low, pay_high, ct_low, ct_high],
        )?;
        let low = Zeroizing::new(hkdf_expand::<32>(&root, b"duocord-pq-v2|low->high")?);
        let high = Zeroizing::new(hkdf_expand::<32>(&root, b"duocord-pq-v2|high->low")?);
        let (send, recv) = if low_is_me { (low, high) } else { (high, low) };
        self.send = Some(Chain {
            key: send,
            index: 0,
        });
        self.recv = Some(Chain {
            key: recv,
            index: 0,
        });
        // The ML-KEM secrets and ciphertexts are no longer needed.
        self.sent = None;
        self.got = None;
        self.done = true;
        Ok(())
    }

    pub fn encrypt(&mut self, value: &Value) -> Result<PqData, ChannelError> {
        let chain = self.send.as_mut().ok_or(ChannelError::NotEstablished)?;
        if chain.index >= MAX_INDEX {
            return Err(ChannelError::Exhausted);
        }
        let n = chain.index;
        let (mk, next) = Chain::step(&chain.key)?;
        chain.key = next;
        chain.index += 1;
        let ct = aead::encrypt(
            &mk[..],
            &frame_iv(n),
            &pad(value.to_string().as_bytes()),
            format!("pq|{n}").as_bytes(),
        )?;
        Ok(PqData {
            n,
            ct: codec::encode(&ct),
        })
    }

    /// Decrypt a frame. Frames only move forward; lost ones may be skipped (their keys are derived and dropped). The
    /// chain advances only if the frame is genuine, so a forged frame cannot push it out of step.
    pub fn decrypt(&mut self, frame: &PqData) -> Result<Value, ChannelError> {
        let chain = self.recv.as_mut().ok_or(ChannelError::NotEstablished)?;
        if frame.n < chain.index {
            return Err(ChannelError::Replay);
        }
        if frame.n - chain.index > MAX_SKIP {
            return Err(ChannelError::Decrypt);
        }
        let mut key = Zeroizing::new(*chain.key);
        for _ in chain.index..frame.n {
            key = Chain::step(&key)?.1;
        }
        let (mk, next) = Chain::step(&key)?;
        let ct = codec::decode(&frame.ct).ok_or(ChannelError::Decrypt)?;
        let padded = aead::decrypt(
            &mk[..],
            &frame_iv(frame.n),
            &ct,
            format!("pq|{}", frame.n).as_bytes(),
        )
        .map_err(|_| ChannelError::Decrypt)?;
        let value = unpad(&padded)
            .and_then(|p| serde_json::from_slice(p).ok())
            .ok_or(ChannelError::Decrypt)?;
        chain.key = next;
        chain.index = frame.n + 1;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
    use super::*;
    use crate::rng::SeededEntropy;

    fn pair() -> (PqChannel, PqChannel, Identity, Identity) {
        let mut rng = SeededEntropy::new("pqc");
        let a = Identity::generate(&mut rng).unwrap();
        let b = Identity::generate(&mut rng).unwrap();
        let (ua, ub) = (a.uid().unwrap().to_string(), b.uid().unwrap().to_string());
        let ca = PqChannel::new(&ua, &ub, b.sign_public(), &mut rng).unwrap();
        let cb = PqChannel::new(&ub, &ua, a.sign_public(), &mut rng).unwrap();
        (ca, cb, a, b)
    }

    fn connect(ca: &mut PqChannel, cb: &mut PqChannel, a: &Identity, b: &Identity) {
        let mut rng = SeededEntropy::new("hs");
        let (ha, hb) = (ca.hello(a), cb.hello(b));
        let ka = ca
            .on_hello(&PqHello::from_value(&hb.to_value()).unwrap(), &mut rng)
            .unwrap();
        let kb = cb
            .on_hello(&PqHello::from_value(&ha.to_value()).unwrap(), &mut rng)
            .unwrap();
        assert!(!ca.ready());
        ca.on_kem(&PqKem::from_value(&kb.to_value()).unwrap())
            .unwrap();
        cb.on_kem(&PqKem::from_value(&ka.to_value()).unwrap())
            .unwrap();
        assert!(ca.ready() && cb.ready());
    }

    #[test]
    fn both_sides_agree_and_frames_flow_both_ways() {
        let (mut ca, mut cb, a, b) = pair();
        connect(&mut ca, &mut cb, &a, &b);
        for i in 0..5 {
            let m = json!({ "kind": "message", "text": format!("hi {i}") });
            let f = ca.encrypt(&m).unwrap();
            assert_eq!(
                cb.decrypt(&PqData::from_value(&f.to_value()).unwrap())
                    .unwrap(),
                m
            );
            let back = cb.encrypt(&m).unwrap();
            assert_eq!(ca.decrypt(&back).unwrap(), m);
        }
    }

    #[test]
    fn replays_forgeries_and_reordering_are_refused_but_lost_frames_are_skipped() {
        let (mut ca, mut cb, a, b) = pair();
        connect(&mut ca, &mut cb, &a, &b);
        let f0 = ca.encrypt(&json!({ "n": 0 })).unwrap();
        let f1 = ca.encrypt(&json!({ "n": 1 })).unwrap();
        let f2 = ca.encrypt(&json!({ "n": 2 })).unwrap();
        // A forged frame far ahead fails and does not move the chain.
        let forged = PqData {
            n: f2.n + 10,
            ct: f2.ct.clone(),
        };
        assert!(cb.decrypt(&forged).is_err());
        // Frame 1 is lost: 0 then 2 still decrypt.
        assert_eq!(cb.decrypt(&f0).unwrap(), json!({ "n": 0 }));
        assert_eq!(cb.decrypt(&f2).unwrap(), json!({ "n": 2 }));
        // Late, replayed or reordered frames are refused.
        assert_eq!(cb.decrypt(&f1), Err(ChannelError::Replay));
        assert_eq!(cb.decrypt(&f2), Err(ChannelError::Replay));
        // A bit flipped: refused.
        let mut f3 = ca.encrypt(&json!({ "n": 3 })).unwrap();
        let mut raw = codec::decode(&f3.ct).unwrap();
        raw[3] ^= 1;
        f3.ct = codec::encode(&raw);
        assert!(cb.decrypt(&f3).is_err());
    }

    #[test]
    fn a_hello_not_signed_by_the_contact_is_refused() {
        let (mut ca, _, _, _) = pair();
        let mut rng = SeededEntropy::new("eve");
        let eve = Identity::generate(&mut rng).unwrap();
        let mut fake = PqChannel::new("eve", "x", eve.sign_public(), &mut rng).unwrap();
        let hello = fake.hello(&eve);
        assert_eq!(
            ca.on_hello(&hello, &mut rng).unwrap_err(),
            ChannelError::BadHandshake
        );
        // Swapping in another ML-KEM key breaks the signature too.
        let (mut ca2, cb2, _, b2) = pair();
        let mut h = cb2.hello(&b2);
        h.kem = fake.hello(&eve).kem;
        assert_eq!(
            ca2.on_hello(&h, &mut rng).unwrap_err(),
            ChannelError::BadHandshake
        );
        let _ = &mut fake;
    }

    #[test]
    fn a_tampered_ciphertext_leaves_the_two_sides_unable_to_talk() {
        let (mut ca, mut cb, a, b) = pair();
        let mut rng = SeededEntropy::new("t");
        let (ha, hb) = (ca.hello(&a), cb.hello(&b));
        let ka = ca.on_hello(&hb, &mut rng).unwrap();
        let mut kb = cb.on_hello(&ha, &mut rng).unwrap();
        let mut raw = codec::decode(&kb.ct).unwrap();
        raw[0] ^= 1;
        kb.ct = codec::encode(&raw);
        ca.on_kem(&kb).unwrap();
        cb.on_kem(&ka).unwrap();
        let f = ca.encrypt(&json!({ "x": 1 })).unwrap();
        assert!(cb.decrypt(&f).is_err());
    }

    #[test]
    fn padding_hides_short_lengths_and_round_trips() {
        assert_eq!(pad(b"").len(), 256);
        assert_eq!(pad(&[1; 255]).len(), 256);
        assert_eq!(pad(&[1; 256]).len(), 512);
        assert_eq!(pad(&[1; 5000]).len(), 8192);
        for len in [0usize, 1, 255, 256, 4095, 4096, 9000] {
            let data: Vec<u8> = (0..len).map(|i| (i % 251) as u8 + 1).collect();
            assert_eq!(unpad(&pad(&data)).unwrap(), &data[..]);
        }
        assert!(unpad(&[0, 0, 0]).is_none());
        assert!(unpad(&[1, 2, 0]).is_none());
    }
}
