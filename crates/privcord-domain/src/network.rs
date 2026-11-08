//! Network settings and the shareable relay line (`connectivity/networkConfig.ts`, `turnShare.ts`).

use crate::{
    codec,
    text::{js_trim, utf16_len},
};
use serde_json::Value;

pub const DEFAULT_STUN_URLS: [&str; 2] = [
    "stun:stun.l.google.com:19302",
    "stun:stun.cloudflare.com:3478",
];
pub const DEFAULT_NOSTR_RELAYS: [&str; 3] = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TransportMode {
    #[default]
    Automatic,
    BluetoothOnly,
    InternetOnly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnServer {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignalingConfig {
    Nostr { relays: Vec<String> },
    Relay { url: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkConfig {
    pub stun: Vec<String>,
    pub turn: Vec<TurnServer>,
    pub signaling: Vec<SignalingConfig>,
    /// Hold sealed messages on relays while the contact is offline. Off by default.
    pub store_forward: bool,
    /// Use only TURN (hides your IP from the peer; needs a TURN server).
    pub force_relay: bool,
    pub bluetooth: bool,
    pub transport_mode: TransportMode,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            stun: DEFAULT_STUN_URLS.iter().map(|s| (*s).to_owned()).collect(),
            turn: vec![],
            signaling: vec![SignalingConfig::Nostr {
                relays: DEFAULT_NOSTR_RELAYS
                    .iter()
                    .map(|s| (*s).to_owned())
                    .collect(),
            }],
            store_forward: false,
            force_relay: false,
            bluetooth: true,
            transport_mode: TransportMode::Automatic,
        }
    }
}

fn str_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .filter(|s| !js_trim(s).is_empty() && utf16_len(s) <= 512)
                .map(|s| js_trim(s).to_owned())
                .collect()
        })
        .unwrap_or_default()
}

pub fn is_ws_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|u| u.scheme() == "wss" || u.scheme() == "ws")
}

/// `scheme:rest` with no whitespace, and the scheme is one of `schemes`.
pub fn is_ice_url(value: &str, schemes: &[&str]) -> bool {
    let v = js_trim(value);
    let Some((scheme, rest)) = v.split_once(':') else {
        return false;
    };
    !scheme.is_empty()
        && scheme.chars().all(|c| c.is_ascii_alphabetic())
        && !rest.is_empty()
        && !rest.chars().any(crate::text::is_js_whitespace)
        && schemes.iter().any(|s| s.eq_ignore_ascii_case(scheme))
}

impl NetworkConfig {
    /// Tolerant: bad entries are dropped, unreadable text falls back to defaults.
    pub fn parse(raw: Option<&str>) -> Self {
        let Some(raw) = raw.filter(|r| !r.is_empty()) else {
            return Self::default();
        };
        let Ok(Value::Object(p)) = serde_json::from_str::<Value>(raw) else {
            return Self::default();
        };

        let turn = p
            .get("turn")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|t| {
                        let o = t.as_object()?;
                        let urls: Vec<String> = str_list(o.get("urls"))
                            .into_iter()
                            .filter(|u| is_ice_url(u, &["turn", "turns"]))
                            .collect();
                        let username = o.get("username")?.as_str()?.to_owned();
                        let credential = o.get("credential")?.as_str()?.to_owned();
                        (!urls.is_empty()).then_some(TurnServer {
                            urls,
                            username,
                            credential,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let signaling = match p.get("signaling").and_then(Value::as_array) {
            None => Self::default().signaling,
            Some(a) => a
                .iter()
                .filter_map(|s| {
                    let o = s.as_object()?;
                    match o.get("kind")?.as_str()? {
                        "nostr" => {
                            let relays: Vec<String> = str_list(o.get("relays"))
                                .into_iter()
                                .filter(|r| is_ws_url(r))
                                .collect();
                            (!relays.is_empty()).then_some(SignalingConfig::Nostr { relays })
                        }
                        "relay" => {
                            let url = o.get("url")?.as_str()?;
                            (!js_trim(url).is_empty() && utf16_len(url) <= 512 && is_ws_url(url))
                                .then(|| SignalingConfig::Relay {
                                    url: js_trim(url).to_owned(),
                                })
                        }
                        _ => None,
                    }
                })
                .collect(),
        };

        let transport_mode = match p.get("transportMode").and_then(Value::as_str) {
            Some("BLUETOOTH_ONLY") => TransportMode::BluetoothOnly,
            Some("INTERNET_ONLY") => TransportMode::InternetOnly,
            _ => TransportMode::Automatic,
        };

        let stun = match p.get("stun") {
            Some(v) if v.is_array() => str_list(Some(v))
                .into_iter()
                .filter(|u| is_ice_url(u, &["stun", "stuns"]))
                .collect(),
            _ => Self::default().stun,
        };

        Self {
            stun,
            turn,
            signaling,
            store_forward: p.get("storeForward") == Some(&Value::Bool(true)),
            force_relay: p.get("forceRelay") == Some(&Value::Bool(true)),
            bluetooth: p.get("bluetooth") != Some(&Value::Bool(false)),
            transport_mode,
        }
    }
}

/// Prefix of the one-line relay setup string.
pub const TURN_SHARE_PREFIX: &str = "PRIVCORD-TURN1:";

/// Parse a relay setup line. `None` for anything that is not a well-formed share string.
pub fn parse_turn_share(text: &str) -> Option<TurnServer> {
    let t = js_trim(text);
    if !t.starts_with(TURN_SHARE_PREFIX) || utf16_len(t) > 2000 {
        return None;
    }
    let bytes = codec::decode(&t[TURN_SHARE_PREFIX.len()..])?;
    let o: Value = serde_json::from_slice(&bytes).ok()?;
    let arr = o.get("u")?.as_array()?;
    let name = o.get("n")?.as_str()?;
    let cred = o.get("c")?.as_str()?;
    if name.is_empty() || cred.is_empty() {
        return None;
    }
    let urls: Vec<String> = arr
        .iter()
        .filter_map(Value::as_str)
        .filter(|u| is_ice_url(u, &["turn", "turns"]))
        .map(str::to_owned)
        .collect();
    if urls.is_empty() || urls.len() != arr.len() || urls.len() > 6 {
        return None;
    }
    Some(TurnServer {
        urls,
        username: name.to_owned(),
        credential: cred.to_owned(),
    })
}

pub fn encode_turn_share(turn: &TurnServer) -> String {
    // A struct, not a map, so the keys keep the order (u, n, c) that the TypeScript encoder writes.
    #[derive(serde::Serialize)]
    struct Line<'a> {
        u: &'a [String],
        n: &'a str,
        c: &'a str,
    }
    let json = serde_json::to_string(&Line {
        u: &turn.urls,
        n: &turn.username,
        c: &turn.credential,
    })
    .unwrap_or_default();
    format!("{TURN_SHARE_PREFIX}{}", codec::encode(json.as_bytes()))
}
