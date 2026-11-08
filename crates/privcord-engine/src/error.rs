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
    #[error("That file is empty, too large or not valid.")]
    BadFile,
    #[error("That is not a valid channel name.")]
    BadChannel,
    #[error("You have not joined that channel.")]
    NotJoined,
    #[error("Six-word invites need a connection service (Settings, Connection). The QR code and the full invite text work without one.")]
    NoSignaling,
    #[error("That does not look like a PrivCord invite. Check the words, or ask your friend to share it again.")]
    InvalidInvite,
    #[error("Could not find that invite. Check the words, make sure your friend still has the invite open, and that you are both online.")]
    InviteNotFound,
    #[error("That is your own invite. Send it to a friend instead.")]
    OwnInvite,
    #[error("Leave the groups you share first, then you can remove this friend.")]
    StillInGroup,
    #[error("No way to reach them right now.")]
    NoRoute,
    #[error("That is not one of the reactions.")]
    BadReaction,
    #[error("Use at least 8 characters for the backup passphrase.")]
    WeakPassphrase,
    #[error("That did not open. Check the passphrase and that this is a PrivCord backup file.")]
    BackupUnreadable,
    #[error("That backup belongs to a different identity.")]
    BackupNotYours,
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
