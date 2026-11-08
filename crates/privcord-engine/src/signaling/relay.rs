//! A client for the self-hosted relay (`relayClient.ts`; the server is `relay/server.js`).

use super::{Action, Event, Out, PutRequest, SignalingStatus, PUT_TIMEOUT_MS};
use privcord_domain::{
    blob::SealedBlob,
    signaling::{relay, socket_backoff_ms},
};
use std::collections::BTreeMap;

#[derive(Debug)]
pub struct RelayClient {
    url: String,
    mailbox: Option<String>,
    status: SignalingStatus,
    attempt: u32,
    retry_at: Option<i64>,
    stopped: bool,
    connected: bool,
    /// The newest timestamp the relay told us about, so a reconnect asks only for what is newer.
    last_seen: i64,
    /// Puts waiting for `ok` or `err`, with their deadline.
    pending: BTreeMap<String, i64>,
}

impl RelayClient {
    pub fn new(url: &str) -> Self {
        Self {
            url: url.to_owned(),
            mailbox: None,
            status: SignalingStatus::Idle,
            attempt: 0,
            retry_at: None,
            stopped: true,
            connected: false,
            last_seen: 0,
            pending: BTreeMap::new(),
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn status(&self) -> SignalingStatus {
        self.status
    }

    /// Listen on a mailbox: connect now.
    pub fn start(&mut self, mailbox: &str) -> Out {
        self.mailbox = Some(mailbox.to_owned());
        self.stopped = false;
        self.connect()
    }

    fn connect(&mut self) -> Out {
        if self.stopped {
            return Out::default();
        }
        self.status = SignalingStatus::Connecting;
        self.retry_at = None;
        Out {
            actions: vec![Action::Connect {
                url: self.url.clone(),
            }],
            events: vec![],
        }
    }

    /// The socket opened: subscribe from the newest point we know.
    pub fn opened(&mut self) -> Out {
        self.attempt = 0;
        self.connected = true;
        self.status = SignalingStatus::Online;
        let mailbox = self.mailbox.clone().unwrap_or_default();
        Out {
            actions: vec![Action::Send {
                url: self.url.clone(),
                text: relay::sub_frame(&mailbox, self.last_seen),
            }],
            events: vec![],
        }
    }

    /// The socket failed to open or dropped.
    pub fn closed(&mut self, now: i64) -> Out {
        self.connected = false;
        self.status = if self.stopped {
            SignalingStatus::Idle
        } else {
            SignalingStatus::Error
        };
        let mut out = self.fail_all("Relay connection closed.");
        if !self.stopped {
            let delay = socket_backoff_ms(self.attempt);
            self.attempt = self.attempt.saturating_add(1);
            self.retry_at = Some(now + i64::try_from(delay).unwrap_or(i64::MAX));
        }
        out.events.shrink_to_fit();
        out
    }

    /// A text frame from the relay.
    pub fn message(&mut self, text: &str) -> Out {
        use relay::Incoming;
        let mut out = Out::default();
        match relay::parse_incoming(text) {
            Some(Incoming::Event { id, blob, ts }) => {
                if let Some(ts) = ts {
                    self.last_seen = self.last_seen.max(ts);
                }
                if let Some(blob) = SealedBlob::decode(&blob) {
                    out.events.push(Event::Blob {
                        blob: Box::new(blob),
                        id,
                    });
                }
            }
            Some(Incoming::Ok { id }) if self.pending.remove(&id).is_some() => {
                out.events.push(Event::PutOk { put_id: id });
            }
            Some(Incoming::Err { id, reason }) if self.pending.remove(&id).is_some() => {
                out.events.push(Event::PutFailed { put_id: id, reason });
            }
            _ => {}
        }
        out
    }

    /// Publish a blob. `put_id` is the id the relay will answer with; the result arrives as an event.
    pub fn put(&mut self, req: PutRequest<'_>, now: i64) -> Out {
        let PutRequest {
            mailbox,
            blob,
            kind,
            ttl_sec,
            put_id,
        } = req;
        if !self.connected {
            return Out {
                actions: vec![],
                events: vec![Event::PutFailed {
                    put_id: put_id.to_owned(),
                    reason: "Relay is not connected.".into(),
                }],
            };
        }
        self.pending.insert(put_id.to_owned(), now + PUT_TIMEOUT_MS);
        Out {
            actions: vec![Action::Send {
                url: self.url.clone(),
                text: relay::put_frame(mailbox, put_id, &blob.encode(), ttl_sec, kind.as_str()),
            }],
            events: vec![],
        }
    }

    /// Tell the relay a stored item was handled.
    pub fn remove(&mut self, mailbox: &str, id: &str) -> Out {
        if !self.connected {
            return Out::default();
        }
        Out {
            actions: vec![Action::Send {
                url: self.url.clone(),
                text: relay::del_frame(mailbox, id),
            }],
            events: vec![],
        }
    }

    pub fn stop(&mut self) -> Out {
        self.stopped = true;
        self.retry_at = None;
        let mut out = self.fail_all("Stopped.");
        if self.connected || self.status != SignalingStatus::Idle {
            out.actions.push(Action::Close {
                url: self.url.clone(),
            });
        }
        self.connected = false;
        self.status = SignalingStatus::Idle;
        out
    }

    /// Time passes: reconnect when the backoff is over, and give up on puts the relay never answered.
    pub fn tick(&mut self, now: i64) -> Out {
        let mut out = Out::default();
        let expired: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, deadline)| **deadline <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            self.pending.remove(&id);
            out.events.push(Event::PutFailed {
                put_id: id,
                reason: "Relay did not answer.".into(),
            });
        }
        if self.retry_at.is_some_and(|t| t <= now) && !self.stopped {
            out.extend(self.connect());
        }
        out
    }

    fn fail_all(&mut self, reason: &str) -> Out {
        let events = std::mem::take(&mut self.pending)
            .into_keys()
            .map(|put_id| Event::PutFailed {
                put_id,
                reason: reason.to_owned(),
            })
            .collect();
        Out {
            actions: vec![],
            events,
        }
    }
}
