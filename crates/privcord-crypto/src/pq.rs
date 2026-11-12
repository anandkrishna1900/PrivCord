//! Post-quantum building blocks: ML-KEM-768 (FIPS 203) and the hybrid combiner that joins it with a P-256 ECDH secret.
//!
//! Every key agreement in protocol v2 is hybrid: the result is safe while EITHER the elliptic curve OR the lattice
//! problem holds. The combiner feeds both secrets, plus everything both sides saw (the transcript), into HKDF-SHA-256,
//! so a secret from one exchange can never be replayed into another.
//!
//! Randomness comes from our own [`Entropy`] (as everywhere in this crate): ML-KEM is driven through its deterministic
//! entry points with fresh 32-byte seeds.

use crate::{error::CryptoError, kdf::hkdf_sha256, rng::random_array, rng::Entropy};
use ml_kem::{
    array::Array, kem::Decapsulate, EncapsulateDeterministic, EncodedSizeUser, KemCore, MlKem768,
};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

type Dk = <MlKem768 as KemCore>::DecapsulationKey;
type Ek = <MlKem768 as KemCore>::EncapsulationKey;

/// Size of an ML-KEM-768 public (encapsulation) key.
pub const KEM_PUBLIC_BYTES: usize = 1184;
/// Size of an ML-KEM-768 ciphertext.
pub const KEM_CIPHERTEXT_BYTES: usize = 1088;
/// Size of the private key as we store it: the two 32-byte seeds it is made from.
pub const KEM_SEED_BYTES: usize = 64;

/// An ML-KEM-768 key pair. Kept as its 64-byte seed (wiped on drop), from which the key is rebuilt when needed.
pub struct KemKeyPair {
    seed: Zeroizing<[u8; KEM_SEED_BYTES]>,
    public: Vec<u8>,
}

impl std::fmt::Debug for KemKeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KemKeyPair").finish_non_exhaustive()
    }
}

fn keys_from_seed(seed: &[u8; KEM_SEED_BYTES]) -> (Dk, Ek) {
    let mut d = [0u8; 32];
    let mut z = [0u8; 32];
    d.copy_from_slice(&seed[..32]);
    z.copy_from_slice(&seed[32..]);
    let keys = MlKem768::generate_deterministic(&Array::from(d), &Array::from(z));
    zeroize::Zeroize::zeroize(&mut d);
    zeroize::Zeroize::zeroize(&mut z);
    keys
}

impl KemKeyPair {
    pub fn generate(entropy: &mut dyn Entropy) -> Result<Self, CryptoError> {
        let seed = Zeroizing::new(random_array::<KEM_SEED_BYTES>(entropy)?);
        Ok(Self::from_seed(&seed))
    }

    /// Rebuild a stored key pair.
    pub fn from_seed(seed: &[u8; KEM_SEED_BYTES]) -> Self {
        let (_, ek) = keys_from_seed(seed);
        Self {
            seed: Zeroizing::new(*seed),
            public: ek.as_bytes().to_vec(),
        }
    }

    pub fn seed(&self) -> &[u8; KEM_SEED_BYTES] {
        &self.seed
    }

    pub fn public(&self) -> &[u8] {
        &self.public
    }

    /// The shared secret inside a ciphertext made for our public key. ML-KEM never fails here: a tampered ciphertext
    /// gives a pseudorandom secret (implicit rejection), which then fails the AEAD that uses it.
    pub fn decapsulate(&self, ciphertext: &[u8]) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
        if ciphertext.len() != KEM_CIPHERTEXT_BYTES {
            return Err(CryptoError::Invalid);
        }
        let ct = Array::try_from(ciphertext).map_err(|_| CryptoError::Invalid)?;
        let (dk, _) = keys_from_seed(&self.seed);
        let ss = dk.decapsulate(&ct).map_err(|()| CryptoError::Invalid)?;
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(&ss);
        Ok(out)
    }
}

/// Encapsulate to someone's ML-KEM public key: returns (ciphertext to send, shared secret to keep).
pub fn kem_encapsulate(
    public: &[u8],
    entropy: &mut dyn Entropy,
) -> Result<(Vec<u8>, Zeroizing<[u8; 32]>), CryptoError> {
    if public.len() != KEM_PUBLIC_BYTES {
        return Err(CryptoError::InvalidKey);
    }
    let encoded = Array::try_from(public).map_err(|_| CryptoError::InvalidKey)?;
    let ek = Ek::from_bytes(&encoded);
    // FIPS 203 input check: the key must re-encode to exactly the bytes we were given.
    if ek.as_bytes().as_slice() != public {
        return Err(CryptoError::InvalidKey);
    }
    let m = Zeroizing::new(random_array::<32>(entropy)?);
    let (ct, ss) = ek
        .encapsulate_deterministic(&Array::from(*m))
        .map_err(|()| CryptoError::Invalid)?;
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(&ss);
    Ok((ct.to_vec(), out))
}

/// The hybrid combiner: one 32-byte key from an ECDH secret and one or more ML-KEM secrets, bound to `label` and to the
/// transcript (every public value both sides saw, in an order both sides agree on).
pub fn combine(
    label: &str,
    ecdh: &[u8],
    kem_secrets: &[&[u8; 32]],
    transcript: &[&[u8]],
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let mut ikm = Zeroizing::new(Vec::with_capacity(ecdh.len() + 32 * kem_secrets.len()));
    ikm.extend_from_slice(ecdh);
    for s in kem_secrets {
        ikm.extend_from_slice(&s[..]);
    }
    let mut h = Sha256::new();
    for part in transcript {
        // Length-prefixed, so two different transcripts can never hash the same.
        h.update((part.len() as u64).to_be_bytes());
        h.update(part);
    }
    let salt = h.finalize();
    Ok(Zeroizing::new(hkdf_sha256::<32>(
        &ikm,
        &salt,
        label.as_bytes(),
    )?))
}

/// SHA-256 of a public key, for signatures and transcripts (shorter than the key itself).
pub fn fingerprint(public: &[u8]) -> [u8; 32] {
    Sha256::digest(public).into()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use crate::rng::SeededEntropy;

    #[test]
    fn encapsulation_round_trips_and_tampering_gives_a_different_secret() {
        let mut rng = SeededEntropy::new("kem");
        let bob = KemKeyPair::generate(&mut rng).unwrap();
        assert_eq!(bob.public().len(), KEM_PUBLIC_BYTES);
        let (ct, ss) = kem_encapsulate(bob.public(), &mut rng).unwrap();
        assert_eq!(ct.len(), KEM_CIPHERTEXT_BYTES);
        assert_eq!(*bob.decapsulate(&ct).unwrap(), *ss);
        // Rebuilt from its stored seed, the key still opens it.
        assert_eq!(
            *KemKeyPair::from_seed(bob.seed()).decapsulate(&ct).unwrap(),
            *ss
        );
        let mut bad = ct.clone();
        bad[10] ^= 1;
        assert_ne!(*bob.decapsulate(&bad).unwrap(), *ss);
        assert!(bob.decapsulate(&ct[..100]).is_err());
        assert!(kem_encapsulate(&bob.public()[..100], &mut rng).is_err());
    }

    #[test]
    fn the_combiner_depends_on_every_input() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let base = combine("l", b"ecdh", &[&a], &[b"t1", b"t2"]).unwrap();
        assert_ne!(
            *base,
            *combine("l2", b"ecdh", &[&a], &[b"t1", b"t2"]).unwrap()
        );
        assert_ne!(
            *base,
            *combine("l", b"ecdX", &[&a], &[b"t1", b"t2"]).unwrap()
        );
        assert_ne!(
            *base,
            *combine("l", b"ecdh", &[&b], &[b"t1", b"t2"]).unwrap()
        );
        assert_ne!(
            *base,
            *combine("l", b"ecdh", &[&a], &[b"t1t", b"2"]).unwrap()
        );
        assert_eq!(
            *base,
            *combine("l", b"ecdh", &[&a], &[b"t1", b"t2"]).unwrap()
        );
    }
}
