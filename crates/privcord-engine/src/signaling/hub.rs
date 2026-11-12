//! All configured signaling services at once (`hub.ts`): the first copy of a blob wins, a put succeeds if any service took
//! it, and the status is the best of them.

use super::{
    nostr::NostrTransport, relay::RelayClient, Action, Event, Out, PutRequest, SignalingStatus,
};
use privcord_crypto::{rng::Entropy, CryptoError};
use privcord_domain::signaling::{aggregate_status, SeenSet};
use std::collections::BTreeMap;

#[derive(Debug)]
pub enum Service {
    Relay(RelayClient),
    Nostr(NostrTransport),
}

impl Service {
    fn status(&self) -> SignalingStatus {
        match self {
            Self::Relay(r) => r.status(),
            Self::Nostr(n) => n.status(),
        }
    }
}

/// Where the hub is in a put it has fanned out.
#[derive(Debug)]
struct Fan {
    waiting: usize,
    first_failure: Option<String>,
    done: bool,
}

#[derive(Debug)]
pub struct SignalingHub {
    services: Vec<Service>,
    seen: SeenSet,
    fans: BTreeMap<String, Fan>,
}

impl SignalingHub {
    pub fn new(services: Vec<Service>) -> Self {
        Self {
            services,
            seen: SeenSet::default(),
            fans: BTreeMap::new(),
        }
    }

    pub fn enabled(&self) -> bool {
        !self.services.is_empty()
    }

    pub fn status(&self) -> SignalingStatus {
        let states: Vec<SignalingStatus> = self.services.iter().map(Service::status).collect();
        aggregate_status(&states)
    }

    pub fn start(&mut self, mailbox: &str) -> Out {
        let mut out = Out::default();
        for s in &mut self.services {
            out.extend(match s {
                Service::Relay(r) => r.start(mailbox),
                Service::Nostr(n) => n.start(mailbox),
            });
        }
        out
    }

    /// Publish through every service. The outcome arrives as one event: `PutOk` as soon as any service took it, or
    /// `PutFailed` (with the first reason) when none did.
    pub fn put(
        &mut self,
        req: PutRequest<'_>,
        now_ms: i64,
        entropy: &mut dyn Entropy,
    ) -> Result<Out, CryptoError> {
        let put_id = req.put_id;
        if self.services.is_empty() {
            return Ok(Out {
                actions: vec![],
                events: vec![Event::PutFailed {
                    put_id: put_id.to_owned(),
                    reason: "No signaling is configured.".into(),
                }],
            });
        }
        self.fans.insert(
            put_id.to_owned(),
            Fan {
                waiting: self.services.len(),
                first_failure: None,
                done: false,
            },
        );
        let mut raw = Out::default();
        for s in &mut self.services {
            match s {
                Service::Relay(r) => raw.extend(r.put(req, now_ms)),
                Service::Nostr(n) => raw.extend(n.put(req, now_ms / 1000, entropy)?),
            }
        }
        Ok(self.fold(raw))
    }

    pub fn remove(&mut self, mailbox: &str, id: &str) -> Out {
        let mut out = Out::default();
        for s in &mut self.services {
            if let Service::Relay(r) = s {
                out.extend(r.remove(mailbox, id));
            }
        }
        out
    }

    /// The adapter opened a socket.
    pub fn socket_opened(&mut self, url: &str, now_ms: i64) -> Out {
        let mut raw = Out::default();
        for s in &mut self.services {
            match s {
                Service::Relay(r) if r.url() == url => raw.extend(r.opened()),
                Service::Nostr(n) => raw.extend(n.opened(url, now_ms / 1000)),
                Service::Relay(_) => {}
            }
        }
        self.fold(raw)
    }

    pub fn socket_closed(&mut self, url: &str, now_ms: i64) -> Out {
        let mut raw = Out::default();
        for s in &mut self.services {
            match s {
                Service::Relay(r) if r.url() == url => raw.extend(r.closed(now_ms)),
                Service::Nostr(n) => raw.extend(n.closed(url, now_ms)),
                Service::Relay(_) => {}
            }
        }
        self.fold(raw)
    }

    pub fn socket_message(&mut self, url: &str, text: &str, now_ms: i64) -> Out {
        let mut raw = Out::default();
        for s in &mut self.services {
            match s {
                Service::Relay(r) if r.url() == url => raw.extend(r.message(text)),
                Service::Nostr(n) => raw.extend(n.message(text, now_ms / 1000)),
                Service::Relay(_) => {}
            }
        }
        self.fold(raw)
    }

    pub fn tick(&mut self, now_ms: i64) -> Out {
        let mut raw = Out::default();
        for s in &mut self.services {
            match s {
                Service::Relay(r) => raw.extend(r.tick(now_ms)),
                Service::Nostr(n) => raw.extend(n.tick(now_ms)),
            }
        }
        self.fold(raw)
    }

    pub fn stop(&mut self) -> Out {
        let mut raw = Out::default();
        for s in &mut self.services {
            match s {
                Service::Relay(r) => raw.extend(r.stop()),
                Service::Nostr(n) => raw.extend(n.stop()),
            }
        }
        self.fold(raw)
    }

    /// Turn per-service news into the hub's: de-duplicate blobs, and fold put results into one answer each.
    fn fold(&mut self, raw: Out) -> Out {
        let mut out = Out {
            actions: raw.actions,
            events: Vec::new(),
        };
        for e in raw.events {
            match e {
                Event::Blob { blob, id } => {
                    if self
                        .seen
                        .first_time(&privcord_crypto::seal::replay_id(&blob))
                    {
                        out.events.push(Event::Blob { blob, id });
                    }
                }
                Event::PutOk { put_id } => {
                    if let Some(f) = self.fans.get_mut(&put_id) {
                        f.waiting = f.waiting.saturating_sub(1);
                        if !f.done {
                            f.done = true;
                            out.events.push(Event::PutOk {
                                put_id: put_id.clone(),
                            });
                        }
                        if f.waiting == 0 {
                            self.fans.remove(&put_id);
                        }
                    }
                }
                Event::PutFailed { put_id, reason } => {
                    if let Some(f) = self.fans.get_mut(&put_id) {
                        f.waiting = f.waiting.saturating_sub(1);
                        f.first_failure.get_or_insert(reason);
                        if f.waiting == 0 {
                            if !f.done {
                                let reason = f
                                    .first_failure
                                    .take()
                                    .unwrap_or_else(|| "Signaling failed.".into());
                                out.events.push(Event::PutFailed {
                                    put_id: put_id.clone(),
                                    reason,
                                });
                            }
                            self.fans.remove(&put_id);
                        }
                    }
                }
            }
        }
        out
    }

    /// Every distinct socket the hub wants open (for the adapter's bookkeeping).
    pub fn urls(&self) -> Vec<String> {
        let mut v = Vec::new();
        for s in &self.services {
            match s {
                Service::Relay(r) => v.push(r.url().to_owned()),
                Service::Nostr(_) => {}
            }
        }
        v
    }
}

impl Action {
    /// The socket this action is about.
    pub fn url(&self) -> &str {
        match self {
            Self::Connect { url } | Self::Send { url, .. } | Self::Close { url } => url,
        }
    }
}
