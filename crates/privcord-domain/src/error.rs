use thiserror::Error;

/// Why a domain rule refused something. Messages are safe to show to a person.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DomainError {
    #[error("Message cannot be empty.")]
    EmptyMessage,
    #[error("Message exceeds the {limit} character limit.")]
    MessageTooLong { limit: usize },
    #[error("Invalid message identifier.")]
    InvalidMessageId,
    #[error("A sender is required.")]
    MissingSender,
    #[error("That file is empty.")]
    EmptyFile,
    #[error("Files can be at most {limit}.")]
    FileTooLarge { limit: String },
    #[error("Invalid identifier.")]
    InvalidId,
}
