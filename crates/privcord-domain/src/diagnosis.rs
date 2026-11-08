//! "Why isn't it connecting?" in plain language (`connectivity/diagnosis.ts`). Pure: the apps only gather facts.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalingStatus {
    Online,
    Connecting,
    Idle,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CandidateCounts {
    pub host: u32,
    pub srflx: u32,
    pub relay: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionFacts {
    pub signaling: SignalingStatus,
    /// How many times we tried this friend since they last connected.
    pub attempts: u32,
    /// Saw an offer, an answer or a "ready" from them during this attempt.
    pub saw_peer_reply: bool,
    pub local_candidates: Option<CandidateCounts>,
    pub ice_state: Option<String>,
    pub has_turn: bool,
    pub store_forward: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosisAction {
    EnableStoreForward,
    AddTurn,
    OpenConnectionSettings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosisCode {
    NoSignaling,
    SignalingDown,
    NoAnswer,
    NoPublicAddress,
    BlockedNetworks,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnosis {
    pub code: DiagnosisCode,
    pub message: String,
    pub actions: Vec<DiagnosisAction>,
}

/// `None` while it is still early or nothing is wrong.
pub fn diagnose_connection(f: &ConnectionFacts, friend: &str) -> Option<Diagnosis> {
    use DiagnosisAction::{AddTurn, EnableStoreForward, OpenConnectionSettings};
    match f.signaling {
        SignalingStatus::Idle => {
            return Some(Diagnosis {
                code: DiagnosisCode::NoSignaling,
                message: "No connection service is set up, so phones across the internet cannot find each other. Turn one on in Settings > Connection.".into(),
                actions: vec![OpenConnectionSettings],
            });
        }
        SignalingStatus::Error | SignalingStatus::Connecting => {
            if f.attempts < 1 {
                return None;
            }
            return Some(Diagnosis {
                code: DiagnosisCode::SignalingDown,
                message: "Can't reach the connection service (the relays). Check your internet, or add another relay in Settings > Connection.".into(),
                actions: vec![OpenConnectionSettings],
            });
        }
        SignalingStatus::Online => {}
    }
    if f.attempts < 2 {
        return None;
    }
    let failed = matches!(f.ice_state.as_deref(), Some("failed" | "disconnected"));
    let fallback = if f.store_forward {
        vec![]
    } else {
        vec![EnableStoreForward]
    };
    let with_fallback = |first: DiagnosisAction| {
        let mut v = vec![first];
        v.extend(fallback.iter().copied());
        v
    };
    if let Some(c) = f.local_candidates {
        if c.srflx == 0 && c.relay == 0 && !f.has_turn && c.host > 0 {
            return Some(Diagnosis {
                code: DiagnosisCode::NoPublicAddress,
                message: format!("This phone could not find its public address (the address lookup is blocked on this network), so a direct link to {friend} is not possible. A TURN server fixes this."),
                actions: with_fallback(AddTurn),
            });
        }
    }
    if failed || (f.saw_peer_reply && f.attempts >= 3) {
        return Some(Diagnosis {
            code: DiagnosisCode::BlockedNetworks,
            message: format!("{friend} answered, but the two networks would not let a direct link through. This is common on mobile data. A TURN server fixes it, and with store-and-forward on, messages still arrive through the relays in the meantime."),
            actions: with_fallback(AddTurn),
        });
    }
    if !f.saw_peer_reply {
        return Some(Diagnosis {
            code: DiagnosisCode::NoAnswer,
            message: format!("{friend} has not answered. Make sure PrivCord is open on their device and that they are online."),
            actions: fallback,
        });
    }
    None
}

/// Counts the address kinds in an SDP blob (host, srflx = found by STUN, relay = TURN).
pub fn count_sdp_candidates(sdp: &str) -> CandidateCounts {
    let mut out = CandidateCounts::default();
    for line in sdp.split(['\r', '\n']) {
        if let Some(rest) = line.strip_prefix("a=candidate:") {
            let words: Vec<&str> = rest.split_whitespace().collect();
            if let Some(i) = words.iter().position(|w| *w == "typ") {
                match words.get(i + 1).copied() {
                    Some("host") => out.host += 1,
                    Some("srflx") => out.srflx += 1,
                    Some("relay") => out.relay += 1,
                    _ => {}
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> ConnectionFacts {
        ConnectionFacts {
            signaling: SignalingStatus::Online,
            attempts: 3,
            saw_peer_reply: true,
            local_candidates: Some(CandidateCounts {
                host: 2,
                srflx: 1,
                relay: 0,
            }),
            ice_state: None,
            has_turn: false,
            store_forward: false,
        }
    }

    #[test]
    fn quiet_when_early() {
        assert_eq!(
            diagnose_connection(
                &ConnectionFacts {
                    attempts: 1,
                    ..base()
                },
                "Ben"
            ),
            None
        );
        assert_eq!(
            diagnose_connection(
                &ConnectionFacts {
                    attempts: 0,
                    signaling: SignalingStatus::Error,
                    ..base()
                },
                "Ben"
            ),
            None
        );
    }

    #[test]
    fn same_table_as_typescript() {
        let d = |f: ConnectionFacts| diagnose_connection(&f, "Ben").map(|d| d.code);
        assert_eq!(
            d(ConnectionFacts {
                signaling: SignalingStatus::Idle,
                ..base()
            }),
            Some(DiagnosisCode::NoSignaling)
        );
        assert_eq!(
            d(ConnectionFacts {
                signaling: SignalingStatus::Error,
                attempts: 1,
                ..base()
            }),
            Some(DiagnosisCode::SignalingDown)
        );
        assert_eq!(
            d(ConnectionFacts {
                saw_peer_reply: false,
                ..base()
            }),
            Some(DiagnosisCode::NoAnswer)
        );
        assert_eq!(
            d(ConnectionFacts {
                local_candidates: Some(CandidateCounts {
                    host: 2,
                    srflx: 0,
                    relay: 0
                }),
                ..base()
            }),
            Some(DiagnosisCode::NoPublicAddress)
        );
        assert_eq!(
            d(ConnectionFacts {
                ice_state: Some("failed".into()),
                ..base()
            }),
            Some(DiagnosisCode::BlockedNetworks)
        );
        // With a TURN server configured the "no public address" story is not told.
        assert_eq!(
            d(ConnectionFacts {
                has_turn: true,
                saw_peer_reply: false,
                local_candidates: Some(CandidateCounts {
                    host: 2,
                    srflx: 0,
                    relay: 0
                }),
                ..base()
            }),
            Some(DiagnosisCode::NoAnswer)
        );
    }

    #[test]
    fn store_forward_is_only_offered_while_off() {
        let on = diagnose_connection(
            &ConnectionFacts {
                saw_peer_reply: false,
                store_forward: true,
                ..base()
            },
            "Ben",
        );
        assert_eq!(on.map(|d| d.actions), Some(vec![]));
        let off = diagnose_connection(
            &ConnectionFacts {
                saw_peer_reply: false,
                ..base()
            },
            "Ben",
        );
        assert_eq!(
            off.map(|d| d.actions),
            Some(vec![DiagnosisAction::EnableStoreForward])
        );
    }

    #[test]
    fn counts_candidates() {
        let sdp = "a=candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host generation 0\r\na=candidate:2 1 udp 1686052607 49.36.1.2 50000 typ srflx raddr 192.168.1.5 rport 50000\r\na=candidate:3 1 udp 41885439 13.1.1.1 3478 typ relay raddr 0.0.0.0 rport 0\r\na=candidate:4 1 udp 2122194687 10.0.0.2 50001 typ host";
        assert_eq!(
            count_sdp_candidates(sdp),
            CandidateCounts {
                host: 2,
                srflx: 1,
                relay: 1
            }
        );
        assert_eq!(count_sdp_candidates("v=0"), CandidateCounts::default());
    }
}
