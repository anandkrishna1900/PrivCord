//! Connection state and the paths a connection can take (`states.ts`, `connectionPath.ts`).

use serde::{Deserialize, Serialize};

/// Which kind of address each end used, as the WebRTC stack reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CandidateType {
    Host,
    Srflx,
    Prflx,
    Relay,
    Unknown,
}

/// How a link is really routed. Only ever decided from what the transport reports, never from configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionPath {
    DirectLan,
    DirectNat,
    Relayed,
    Bluetooth,
    Unknown,
}

impl ConnectionPath {
    /// Short text for the connection badge.
    pub fn label(self) -> &'static str {
        match self {
            Self::DirectLan => "Direct, same network",
            Self::DirectNat => "Direct, peer to peer",
            Self::Relayed => "Relayed through TURN",
            Self::Bluetooth => "Bluetooth, no internet",
            Self::Unknown => "Unknown path",
        }
    }

    pub fn detail(self) -> &'static str {
        match self {
            Self::DirectLan => "Connected straight to the other device on the same network.",
            Self::DirectNat => {
                "Connected straight to the other device across the internet (NAT traversed). No server carries your messages."
            }
            Self::Relayed => {
                "Traffic passes through a TURN server. It is still end-to-end encrypted, but it is not a direct connection."
            }
            Self::Bluetooth => "Connected over Bluetooth LE within radio range. No internet or server is involved.",
            Self::Unknown => "The browser did not report the selected connection path.",
        }
    }

    pub fn classify(local: CandidateType, remote: CandidateType) -> Self {
        use CandidateType::{Host, Relay, Unknown};
        match (local, remote) {
            (Unknown, _) | (_, Unknown) => Self::Unknown,
            (Relay, _) | (_, Relay) => Self::Relayed,
            (Host, Host) => Self::DirectLan,
            _ => Self::DirectNat,
        }
    }
}

/// Why a connection attempt ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionFailure {
    AuthenticationFailed,
    Timeout,
    Refused,
    TransportClosed,
    Unreachable,
}

/// The state of the link to one person. A transport that drops does not destroy identity or session state: it only
/// moves this machine to `Reconnecting` or `Offline`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConnectionState {
    Offline,
    Connecting,
    Connected { path: ConnectionPath },
    Reconnecting { attempt: u32 },
    Failed { reason: ConnectionFailure },
}

impl ConnectionState {
    pub fn is_connected(self) -> bool {
        matches!(self, Self::Connected { .. })
    }

    /// Every allowed move. Anything else is a bug in the caller and returns `None`.
    pub fn on(self, event: ConnectionEvent) -> Option<Self> {
        use ConnectionEvent as E;
        use ConnectionState as S;
        match (self, event) {
            (S::Offline | S::Failed { .. }, E::Dial) => Some(S::Connecting),
            (S::Connecting | S::Reconnecting { .. }, E::Established(path)) => {
                Some(S::Connected { path })
            }
            (S::Connecting, E::Failed(reason)) | (S::Reconnecting { .. }, E::Failed(reason)) => {
                Some(S::Failed { reason })
            }
            (S::Connecting, E::Closed) => Some(S::Offline),
            (S::Connected { .. }, E::Closed) => Some(S::Reconnecting { attempt: 1 }),
            (S::Reconnecting { attempt }, E::Retry) => Some(S::Reconnecting {
                attempt: attempt.saturating_add(1),
            }),
            (
                S::Failed { .. } | S::Reconnecting { .. } | S::Connecting | S::Connected { .. },
                E::GiveUp,
            ) => Some(S::Offline),
            (S::Connected { .. }, E::PathChanged(path)) => Some(S::Connected { path }),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionEvent {
    Dial,
    Established(ConnectionPath),
    PathChanged(ConnectionPath),
    Failed(ConnectionFailure),
    Closed,
    Retry,
    GiveUp,
}

/// The five states the chat header can show (`states.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConnectionMode {
    P2pConnected,
    Connecting,
    Reconnecting,
    OfflineQueued,
    ConnectionFailed,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ConnectionInputs {
    pub p2p_connected: bool,
    pub connecting: bool,
    pub reconnecting: bool,
    pub failed: bool,
}

impl ConnectionMode {
    pub fn derive(i: ConnectionInputs) -> Self {
        if i.p2p_connected {
            Self::P2pConnected
        } else if i.connecting {
            Self::Connecting
        } else if i.reconnecting {
            Self::Reconnecting
        } else if i.failed {
            Self::ConnectionFailed
        } else {
            Self::OfflineQueued
        }
    }
}

impl From<ConnectionState> for ConnectionMode {
    fn from(s: ConnectionState) -> Self {
        match s {
            ConnectionState::Connected { .. } => Self::P2pConnected,
            ConnectionState::Connecting => Self::Connecting,
            ConnectionState::Reconnecting { .. } => Self::Reconnecting,
            ConnectionState::Failed { .. } => Self::ConnectionFailed,
            ConnectionState::Offline => Self::OfflineQueued,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_paths_like_the_typescript_version() {
        use CandidateType::*;
        assert_eq!(
            ConnectionPath::classify(Host, Host),
            ConnectionPath::DirectLan
        );
        assert_eq!(
            ConnectionPath::classify(Host, Srflx),
            ConnectionPath::DirectNat
        );
        assert_eq!(
            ConnectionPath::classify(Prflx, Host),
            ConnectionPath::DirectNat
        );
        assert_eq!(
            ConnectionPath::classify(Relay, Host),
            ConnectionPath::Relayed
        );
        assert_eq!(
            ConnectionPath::classify(Host, Relay),
            ConnectionPath::Relayed
        );
        assert_eq!(
            ConnectionPath::classify(Unknown, Relay),
            ConnectionPath::Unknown
        );
    }

    #[test]
    fn a_dropped_transport_reconnects_instead_of_forgetting() {
        let s = ConnectionState::Offline
            .on(ConnectionEvent::Dial)
            .and_then(|s| s.on(ConnectionEvent::Established(ConnectionPath::DirectNat)))
            .and_then(|s| s.on(ConnectionEvent::Closed))
            .and_then(|s| s.on(ConnectionEvent::Retry));
        assert_eq!(s, Some(ConnectionState::Reconnecting { attempt: 2 }));
    }

    #[test]
    fn invalid_moves_are_refused() {
        assert_eq!(ConnectionState::Offline.on(ConnectionEvent::Closed), None);
        assert_eq!(
            ConnectionState::Offline.on(ConnectionEvent::Established(ConnectionPath::Bluetooth)),
            None
        );
    }

    #[test]
    fn mode_priority_matches_typescript() {
        let all = ConnectionInputs {
            p2p_connected: true,
            connecting: true,
            reconnecting: true,
            failed: true,
        };
        assert_eq!(ConnectionMode::derive(all), ConnectionMode::P2pConnected);
        assert_eq!(
            ConnectionMode::derive(ConnectionInputs::default()),
            ConnectionMode::OfflineQueued
        );
    }
}
