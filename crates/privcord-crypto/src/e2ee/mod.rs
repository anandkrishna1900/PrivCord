//! The pairwise end-to-end layer of the TypeScript protocol (`packages/protocol/src/e2ee`): X3DH key agreement on
//! NIST P-256, the Double Ratchet, the transport-independent `DuoEnvelope`, and epoch-keyed group messages.
//!
//! The apps do not call this today (they use sealed blobs and the secure channel, see ADR-009), but the whole protocol
//! package is now rewritten here and checked against the TypeScript with shared vectors in both directions, so it can be
//! switched on without a second port.
//!
//! Deliberate differences from the TypeScript are listed in `docs/rust/COMPATIBILITY.md` (decrypting is atomic; a refused
//! message leaves the ratchet exactly as it was).

pub mod envelope;
pub mod group_crypto;
pub mod keys;
pub mod ratchet;
pub mod x3dh;

pub use envelope::{
    accept_initial_envelope, associated_data_for, decrypt_envelope, encrypt_to_envelope,
    envelope_digest, initiate_session, restore_session, serialize_session, validate_envelope,
    AcceptedSession, ContactIdentity, DuoEnvelope, DuoSession, PrekeyInventory, SessionStart,
};
pub use group_crypto::{GroupEncryptedMessage, GroupSessionManager};
pub use keys::EcdhKeypair;
pub use ratchet::{DoubleRatchet, EncryptResult, RatchetHeader, MAX_SKIP};
pub use x3dh::{
    create_bundle, create_one_time_prekey, create_signed_prekey, initiate_x3dh, respond_x3dh,
    validate_bundle, OneTimePrekey, PrekeyBundle, PrekeyIntro, SignedPrekey, X3dhInitiation,
    X3dhResult,
};
