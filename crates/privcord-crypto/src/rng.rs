//! Randomness. Production uses the operating system's generator; tests can inject a fixed stream so results
//! are reproducible. Nothing else may create randomness (a weak source must not be reachable from a release build).

use crate::error::CryptoError;

/// A source of random bytes.
pub trait Entropy {
    fn fill(&mut self, dest: &mut [u8]) -> Result<(), CryptoError>;
}

/// The operating system's cryptographically secure generator.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsEntropy;

impl Entropy for OsEntropy {
    fn fill(&mut self, dest: &mut [u8]) -> Result<(), CryptoError> {
        getrandom::getrandom(dest).map_err(|_| CryptoError::Random)
    }
}

/// A fresh P-256 private key drawn from `entropy`. Rejection sampling: 32 random bytes are a valid key unless they are
/// zero or not below the curve order, which happens with probability about 2^-32, so a retry is practically never needed.
pub fn random_secret_key(entropy: &mut dyn Entropy) -> Result<p256::SecretKey, CryptoError> {
    for _ in 0..16 {
        let mut bytes = zeroize::Zeroizing::new([0u8; 32]);
        entropy.fill(&mut *bytes)?;
        if let Ok(key) = p256::SecretKey::from_slice(&*bytes) {
            return Ok(key);
        }
    }
    Err(CryptoError::Random)
}

/// Random bytes as a fixed-size array.
pub fn random_array<const N: usize>(entropy: &mut dyn Entropy) -> Result<[u8; N], CryptoError> {
    let mut out = [0u8; N];
    entropy.fill(&mut out)?;
    Ok(out)
}

/// A repeatable stream for tests: SHA-256 in counter mode over a seed. Not for production.
#[cfg(any(test, feature = "test-support"))]
#[derive(Debug, Clone)]
pub struct SeededEntropy {
    seed: Vec<u8>,
    counter: u64,
    buffer: Vec<u8>,
}

#[cfg(any(test, feature = "test-support"))]
impl SeededEntropy {
    pub fn new(seed: &str) -> Self {
        Self {
            seed: seed.as_bytes().to_vec(),
            counter: 0,
            buffer: Vec::new(),
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
impl Entropy for SeededEntropy {
    fn fill(&mut self, dest: &mut [u8]) -> Result<(), CryptoError> {
        use sha2::{Digest, Sha256};
        for byte in dest.iter_mut() {
            if self.buffer.is_empty() {
                let mut h = Sha256::new();
                h.update(&self.seed);
                h.update(self.counter.to_be_bytes());
                self.counter += 1;
                self.buffer = h.finalize().to_vec();
                self.buffer.reverse();
            }
            *byte = self.buffer.pop().unwrap_or(0);
        }
        Ok(())
    }
}
