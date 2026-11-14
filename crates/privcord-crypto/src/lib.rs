//! Cryptography for PrivCord.
//!
//! Every algorithm, parameter and encoding here is the one the existing TypeScript (`packages/protocol`) and Kotlin
//! (`apps/android`) code uses; nothing is changed or added. What is used: P-256 ECDSA/ECDH, HKDF-SHA-256,
//! AES-256-GCM, SHA-256, PBKDF2 (HMAC-SHA-256 and HMAC-SHA-512 through BIP-39), all from the RustCrypto crates.
//! Compatibility is checked against the TypeScript vectors in `docs/` (see `tests/`).
//!
//! Private keys stay inside [`identity::Identity`]; callers get operations (sign, agree), not key bytes. The one
//! exception is [`identity::Identity::export_for_storage`], meant only for the secure-storage adapter.
//!
//! Zeroisation is best-effort: it does not protect against memory dumps, compiler copies or hardware copies.

pub mod aead;
pub mod backup;
pub mod ble;
pub mod canonical;
pub mod card;
pub mod channel;
pub mod devices;
pub mod e2ee;
pub mod error;
pub mod group;
pub mod group_coordinator;
pub mod identity;
pub mod invite;
pub mod kdf;
pub mod nostr;
pub mod peer_auth;
pub mod pq;
pub mod pq_channel;
pub mod prekeys;
pub mod rng;
pub mod safety;
pub mod seal;
pub mod secure_channel;
pub mod selfbox;
pub mod synclog;
#[cfg(any(test, feature = "test-support"))]
pub mod vectors;

pub use error::CryptoError;
pub use identity::Identity;
pub use rng::{Entropy, OsEntropy};
