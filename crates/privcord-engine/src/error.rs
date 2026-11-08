use thiserror::Error;

/// Stable, redacted error codes for the public API (SEC-10). Nothing here carries content, keys or paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Error)]
pub enum ErrorCode {
    #[error("There is no identity yet.")]
    NoIdentity,
    #[error("An identity already exists on this device.")]
    IdentityExists,
    #[error("That recovery phrase is not valid.")]
    InvalidPhrase,
    #[error("That contact card is not valid.")]
    InvalidCard,
    #[error("That is your own contact card.")]
    OwnCard,
    #[error("You have no such contact.")]
    UnknownContact,
    #[error("Message cannot be empty.")]
    EmptyMessage,
    #[error("Message is too long.")]
    MessageTooLong,
    #[error("This person is only reachable through a group; direct messages are off.")]
    DirectNotAllowed,
    #[error("No such message.")]
    UnknownMessage,
    #[error("You are not in that group.")]
    NoSuchGroup,
    #[error("That group change is not allowed.")]
    GroupRefused,
    #[error("The group is full.")]
    GroupFull,
    #[error("Storage failed; nothing was changed.")]
    Storage,
    #[error("Secure storage failed.")]
    SecureStorage,
    #[error("Cryptography failed.")]
    Crypto,
    #[error("The engine is shutting down.")]
    ShuttingDown,
    #[error("The engine is busy; try again.")]
    Busy,
}

impl From<privcord_ports::StorageError> for ErrorCode {
    fn from(_: privcord_ports::StorageError) -> Self {
        Self::Storage
    }
}
impl From<privcord_ports::SecureStoreError> for ErrorCode {
    fn from(_: privcord_ports::SecureStoreError) -> Self {
        Self::SecureStorage
    }
}
impl From<privcord_crypto::CryptoError> for ErrorCode {
    fn from(_: privcord_crypto::CryptoError) -> Self {
        Self::Crypto
    }
}
