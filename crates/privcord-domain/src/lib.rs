//! Pure PrivCord rules and types.
//!
//! Nothing here touches an operating system, a network, a database, a UI, or a cryptographic provider. Everything is
//! deterministic, so the same inputs give the same outputs on every platform. Behaviour mirrors the TypeScript
//! protocol package (`packages/protocol`) that this crate replaces, and is checked against its test vectors
//! (`docs/*-vectors.json`) in `tests/`.

pub mod background;
pub mod ble;
pub mod blob;
pub mod channel;
pub mod codec;
pub mod diagnosis;
pub mod error;
pub mod files;
pub mod ids;
pub mod killswitch;
pub mod limits;
pub mod link_policy;
pub mod mesh;
pub mod message;
pub mod network;
pub mod ordering;
pub mod pairing;
pub mod peer;
pub mod privacy;
pub mod signaling;
pub mod social;
pub mod state;
pub mod text;

pub use error::DomainError;
pub use ids::{ConversationId, GroupId, MessageId, UserId};
