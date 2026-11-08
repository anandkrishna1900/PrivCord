use thiserror::Error;

/// Why a cryptographic operation failed. Messages never contain key material or plaintext.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CryptoError {
    #[error("Invalid recovery phrase.")]
    InvalidPhrase,
    #[error("Malformed key.")]
    InvalidKey,
    #[error("Encryption rejected the inputs.")]
    Encrypt,
    #[error("Could not decrypt.")]
    Decrypt,
    #[error("Payload too large to seal.")]
    TooLarge,
    #[error("Unsupported value for canonical JSON.")]
    Canonical,
    #[error("Use at least {0} characters.")]
    WeakPassphrase(usize),
    #[error("Message cannot be empty.")]
    EmptyMessage,
    #[error("The system could not provide random numbers.")]
    Random,
    #[error("Invalid input.")]
    Invalid,
    /// A refusal from the double-ratchet / prekey layer, with a fixed, content-free reason.
    #[error("{0}")]
    E2ee(&'static str),
}
