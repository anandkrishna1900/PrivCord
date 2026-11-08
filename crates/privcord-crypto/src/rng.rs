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

/// Adapter so the elliptic-curve crates can draw from an [`Entropy`].
pub(crate) struct RngAdapter<'a>(pub &'a mut dyn Entropy);

impl rand_core::RngCore for RngAdapter<'_> {
    fn next_u32(&mut self) -> u32 {
        let mut b = [0u8; 4];
        self.fill_bytes(&mut b);
        u32::from_le_bytes(b)
    }
    fn next_u64(&mut self) -> u64 {
        let mut b = [0u8; 8];
        self.fill_bytes(&mut b);
        u64::from_le_bytes(b)
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        // The trait cannot report failure; a failing system generator is unrecoverable, so output stays zero and the
        // curve crate rejects the all-zero scalar. Callers check `try_fill_bytes` first where it matters.
        if self.0.fill(dest).is_err() {
            dest.fill(0);
        }
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core::Error> {
        self.0.fill(dest).map_err(rand_core::Error::new)
    }
}
impl rand_core::CryptoRng for RngAdapter<'_> {}

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
