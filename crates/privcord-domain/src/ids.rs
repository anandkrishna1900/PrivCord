use crate::{error::DomainError, limits::MAX_CLIENT_MESSAGE_ID_LENGTH};
use serde::{Deserialize, Serialize};
use std::fmt;

macro_rules! opaque_id {
    ($(#[$m:meta])* $name:ident, $check:expr) => {
        $(#[$m])*
        #[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            /// Accepts only well-formed identifiers; the rule is the same one the wire parsers use.
            pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
                let value = value.into();
                if ($check)(&value) { Ok(Self(value)) } else { Err(DomainError::InvalidId) }
            }
            pub fn as_str(&self) -> &str { &self.0 }
        }
        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, concat!(stringify!($name), "({})"), self.0) }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
        }
        impl TryFrom<String> for $name {
            type Error = DomainError;
            fn try_from(v: String) -> Result<Self, DomainError> { Self::new(v) }
        }
        impl From<$name> for String {
            fn from(v: $name) -> String { v.0 }
        }
        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str { &self.0 }
        }
    };
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// A message or retry identifier: 1 to 64 UTF-16 code units.
pub(crate) fn valid_message_id(s: &str) -> bool {
    let n = utf16_len(s);
    n > 0 && n <= MAX_CLIENT_MESSAGE_ID_LENGTH
}

opaque_id!(
    /// Identifier of one message (also its de-duplication key).
    MessageId,
    |s: &String| valid_message_id(s)
);
opaque_id!(
    /// A person. For real identities this is the 64-hex fingerprint of their ECDH key; the domain treats it as opaque.
    UserId,
    |s: &String| !s.is_empty() && utf16_len(s) <= 128
);
opaque_id!(
    /// A group (64-hex hash of its creation event in practice).
    GroupId,
    |s: &String| !s.is_empty() && utf16_len(s) <= 128
);

/// The chat a message belongs to: a person, a group or a public channel. Keeps them from being mixed up.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ConversationId {
    Direct(UserId),
    Group(GroupId),
    Channel(String),
}

impl ConversationId {
    /// The string form stored and shown to adapters: a bare id for people and groups, `chan:<name>` for channels.
    pub fn storage_key(&self) -> String {
        match self {
            Self::Direct(u) => u.as_str().to_owned(),
            Self::Group(g) => g.as_str().to_owned(),
            Self::Channel(n) => format!("chan:{n}"),
        }
    }
}
