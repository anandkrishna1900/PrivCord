//! The signaling clients without their sockets (`signaling/relayClient.ts`, `nostr.ts`, `hub.ts`, `Signaling.kt` and the
//! Kotlin transports): connection state, backoff, subscriptions, put acknowledgements and timeouts, de-duplication across
//! several services, and the rules for which messages become blobs.
//!
//! Nothing here opens a socket or reads a clock. An adapter owns the WebSockets: it tells a client what happened
//! (`opened`, `message`, `closed`, `tick`) and carries out the [`Action`]s that come back (connect, send, close). That
//! leaves the platform only the part that has to be platform code.

pub mod hub;
pub mod nostr;
pub mod relay;

use privcord_domain::blob::SealedBlob;
pub use privcord_domain::signaling::SignalingStatus;

/// Something the adapter must do with a socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Open a WebSocket to `url` (and report `opened`, `message`, `closed`).
    Connect {
        url: String,
    },
    Send {
        url: String,
        text: String,
    },
    Close {
        url: String,
    },
}

/// Something a client tells its owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A blob for the mailbox, with the service's id for it (used to remove it).
    Blob {
        blob: Box<SealedBlob>,
        id: String,
    },
    /// A put the owner asked for was taken.
    PutOk {
        put_id: String,
    },
    PutFailed {
        put_id: String,
        reason: String,
    },
}

/// What a call returns: sockets to drive, and news.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Out {
    pub actions: Vec<Action>,
    pub events: Vec<Event>,
}

impl Out {
    pub(crate) fn extend(&mut self, other: Out) {
        self.actions.extend(other.actions);
        self.events.extend(other.events);
    }
}

/// One blob to publish.
#[derive(Debug, Clone, Copy)]
pub struct PutRequest<'a> {
    pub mailbox: &'a str,
    pub blob: &'a SealedBlob,
    pub kind: privcord_domain::signaling::PutKind,
    pub ttl_sec: u32,
    /// The id the relay answers with, and the one the result event carries.
    pub put_id: &'a str,
}

/// How long the relay has to answer a put.
pub const PUT_TIMEOUT_MS: i64 = 8_000;
