//! Signaling and mailboxes over public Nostr relays (`nostr.ts`, `NostrTransport.kt`): one socket per relay, the same
//! subscription on each, events signed with a throwaway key, and only valid, unexpired, unseen events become blobs.

use super::{Action, Event, Out, PutRequest, SignalingStatus};
use privcord_crypto::{
    nostr::{accept_relay_message, event_frame, make_event, req_frame},
    rng::Entropy,
    CryptoError,
};
use privcord_domain::signaling::{socket_backoff_ms, SeenSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Link {
    Down,
    Connecting,
    Open,
}

#[derive(Debug)]
struct Relay {
    url: String,
    link: Link,
    attempt: u32,
    retry_at: Option<i64>,
}

#[derive(Debug)]
pub struct NostrTransport {
    relays: Vec<Relay>,
    mailbox: Option<String>,
    stopped: bool,
    seen: SeenSet,
    sub_id: String,
}

impl NostrTransport {
    pub fn new(urls: &[String], sub_id: &str) -> Self {
        Self {
            relays: urls
                .iter()
                .map(|u| Relay {
                    url: u.clone(),
                    link: Link::Down,
                    attempt: 0,
                    retry_at: None,
                })
                .collect(),
            mailbox: None,
            stopped: true,
            seen: SeenSet::default(),
            sub_id: sub_id.to_owned(),
        }
    }

    pub fn status(&self) -> SignalingStatus {
        if self.stopped {
            return SignalingStatus::Idle;
        }
        if self.relays.iter().any(|r| r.link == Link::Open) {
            SignalingStatus::Online
        } else if self.relays.iter().any(|r| r.link == Link::Connecting) {
            SignalingStatus::Connecting
        } else {
            SignalingStatus::Error
        }
    }

    pub fn start(&mut self, mailbox: &str) -> Out {
        self.mailbox = Some(mailbox.to_owned());
        self.stopped = false;
        let mut out = Out::default();
        for r in &mut self.relays {
            r.link = Link::Connecting;
            out.actions.push(Action::Connect { url: r.url.clone() });
        }
        out
    }

    fn relay_mut(&mut self, url: &str) -> Option<&mut Relay> {
        self.relays.iter_mut().find(|r| r.url == url)
    }

    /// A relay's socket opened: ask for what arrived in the last two minutes.
    pub fn opened(&mut self, url: &str, now_secs: i64) -> Out {
        let (sub, mailbox) = (
            self.sub_id.clone(),
            self.mailbox.clone().unwrap_or_default(),
        );
        let Some(r) = self.relay_mut(url) else {
            return Out::default();
        };
        r.link = Link::Open;
        r.attempt = 0;
        Out {
            actions: vec![Action::Send {
                url: url.to_owned(),
                text: req_frame(&sub, &mailbox, now_secs - 120),
            }],
            events: vec![],
        }
    }

    pub fn closed(&mut self, url: &str, now_ms: i64) -> Out {
        let stopped = self.stopped;
        let Some(r) = self.relay_mut(url) else {
            return Out::default();
        };
        r.link = Link::Down;
        if !stopped {
            let delay = i64::try_from(socket_backoff_ms(r.attempt)).unwrap_or(i64::MAX);
            r.attempt = r.attempt.saturating_add(1);
            r.retry_at = Some(now_ms + delay);
        }
        Out::default()
    }

    /// A text frame from a relay: a blob if it passes every rule.
    pub fn message(&mut self, text: &str, now_secs: i64) -> Out {
        let Some(mailbox) = self.mailbox.clone() else {
            return Out::default();
        };
        match accept_relay_message(text, &self.sub_id, &mailbox, &mut self.seen, now_secs) {
            Some((blob, id)) => Out {
                actions: vec![],
                events: vec![Event::Blob {
                    blob: Box::new(blob),
                    id,
                }],
            },
            None => Out::default(),
        }
    }

    /// Publish to every open relay with a fresh throwaway key. Nostr has no acknowledgement we wait for: the put is taken
    /// when at least one relay was open.
    pub fn put(
        &mut self,
        req: PutRequest<'_>,
        now_secs: i64,
        entropy: &mut dyn Entropy,
    ) -> Result<Out, CryptoError> {
        let PutRequest {
            mailbox,
            blob,
            kind,
            ttl_sec,
            put_id,
        } = req;
        let open: Vec<String> = self
            .relays
            .iter()
            .filter(|r| r.link == Link::Open)
            .map(|r| r.url.clone())
            .collect();
        if open.is_empty() {
            return Ok(Out {
                actions: vec![],
                events: vec![Event::PutFailed {
                    put_id: put_id.to_owned(),
                    reason: "No Nostr relay is connected.".into(),
                }],
            });
        }
        let event = make_event(mailbox, blob, kind, ttl_sec, now_secs, entropy)?;
        let text = event_frame(&event);
        Ok(Out {
            actions: open
                .into_iter()
                .map(|url| Action::Send {
                    url,
                    text: text.clone(),
                })
                .collect(),
            events: vec![Event::PutOk {
                put_id: put_id.to_owned(),
            }],
        })
    }

    pub fn stop(&mut self) -> Out {
        self.stopped = true;
        let mut out = Out::default();
        for r in &mut self.relays {
            if r.link != Link::Down {
                out.actions.push(Action::Close { url: r.url.clone() });
            }
            r.link = Link::Down;
            r.retry_at = None;
        }
        out
    }

    /// Reconnect the relays whose backoff is over.
    pub fn tick(&mut self, now_ms: i64) -> Out {
        let mut out = Out::default();
        if self.stopped {
            return out;
        }
        for r in &mut self.relays {
            if r.link == Link::Down && r.retry_at.is_some_and(|t| t <= now_ms) {
                r.link = Link::Connecting;
                r.retry_at = None;
                out.actions.push(Action::Connect { url: r.url.clone() });
            }
        }
        out
    }
}
