//! Who connects out, how often, and when a silent link counts as dead (`LinkPolicy.kt`, `Liveness.kt`, `peerLink.ts`).

use crate::pairing::reconnect_delay_ms;
use std::collections::HashSet;

/// While a link is authenticated each side pings this often and answers every ping with a pong.
pub const PING_INTERVAL_MS: i64 = 4_000;
/// No frame at all (any frame counts as proof of life) for this long means the link is lost.
pub const DEAD_LINK_MS: i64 = 14_000;
pub const MAX_LINKS: usize = 30;
pub const MAX_CONNECTING: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LivenessTick {
    Ping,
    Lost,
}

/// Tracks when anything last arrived and says what to do on each tick.
#[derive(Debug, Clone, Copy)]
pub struct LivenessMonitor {
    last_inbound_at: i64,
}

impl LivenessMonitor {
    pub fn new(now: i64) -> Self {
        Self {
            last_inbound_at: now,
        }
    }
    /// Call for every inbound frame, whatever it is.
    pub fn on_inbound(&mut self, now: i64) {
        self.last_inbound_at = now;
    }
    pub fn tick(&self, now: i64) -> LivenessTick {
        if now - self.last_inbound_at > DEAD_LINK_MS {
            LivenessTick::Lost
        } else {
            LivenessTick::Ping
        }
    }
}

/// Initiator rule per pair: the lower uid sends the offer, the other side only announces that it is online.
pub fn is_initiator(self_uid: &str, peer_uid: &str) -> bool {
    self_uid < peer_uid
}

/// What the scheduler needs to know about one contact's link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkInfo {
    pub uid: String,
    pub ready: bool,
    pub connecting: bool,
    /// Last time we tried to reach them (0 = never).
    pub last_attempt_at: i64,
    /// How many tries in a row failed.
    pub attempts: u32,
    pub dialable: bool,
}

/// Which contacts to reach out to now: at most `max_connecting` attempts at once, never more than `max_links` open, each
/// contact backs off on its own (5 s doubling to 120 s) and the longest-waiting goes first so nobody starves.
pub fn due_links(
    links: &[LinkInfo],
    now: i64,
    max_connecting: usize,
    max_links: usize,
) -> Vec<String> {
    let open = links.iter().filter(|l| l.ready).count();
    let connecting = links.iter().filter(|l| l.connecting).count();
    // Slots left: bounded by the connecting limit and by the open-link cap.
    let slots = max_connecting
        .saturating_sub(connecting)
        .min(max_links.saturating_sub(open + connecting));
    let mut candidates: Vec<&LinkInfo> = links
        .iter()
        .filter(|l| {
            l.dialable
                && !l.ready
                && !l.connecting
                && (now - l.last_attempt_at) as f64
                    >= reconnect_delay_ms(f64::from(l.attempts), None, None)
        })
        .collect();
    candidates.sort_by_key(|l| l.last_attempt_at); // stable, like Kotlin's sortedBy
    let out: Vec<String> = candidates
        .into_iter()
        .take(slots)
        .map(|l| l.uid.clone())
        .collect();
    out
}

/// Accept an offer a contact sent us? Not beyond the soft link cap.
pub fn accept_incoming(open_links: usize, max_links: usize) -> bool {
    open_links < max_links
}

/// "Delivered to 3 of 5": group state from how many recipients are still pending.
pub fn group_delivery_detail(total: usize, pending: usize) -> (usize, usize) {
    (total.saturating_sub(pending).min(total), total)
}

/// Group messages that arrived before we knew the group or the sender: held briefly, then dropped.
#[derive(Debug)]
pub struct PendingGroupBuffer<T> {
    hold_ms: i64,
    capacity: usize,
    entries: Vec<(String, String, T, i64)>,
}

impl<T> Default for PendingGroupBuffer<T> {
    fn default() -> Self {
        Self::new(60_000, 200)
    }
}

impl<T> PendingGroupBuffer<T> {
    pub fn new(hold_ms: i64, capacity: usize) -> Self {
        Self {
            hold_ms,
            capacity,
            entries: Vec::new(),
        }
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    /// False if the buffer is full: the message is dropped and the sender retries because no ack goes out.
    pub fn hold(&mut self, group_id: &str, from: &str, item: T, now: i64) -> bool {
        if self.entries.len() >= self.capacity {
            return false;
        }
        self.entries
            .push((group_id.to_owned(), from.to_owned(), item, now));
        true
    }
    /// Remove and return what `ready` now accepts; expired entries are discarded.
    pub fn release(
        &mut self,
        now: i64,
        ready: impl Fn(&str, &str) -> bool,
    ) -> Vec<(String, String, T)> {
        let hold = self.hold_ms;
        self.entries.retain(|e| now - e.3 <= hold);
        let mut out = Vec::new();
        let mut keep = Vec::new();
        for e in std::mem::take(&mut self.entries) {
            if ready(&e.0, &e.1) {
                out.push((e.0, e.1, e.2));
            } else {
                keep.push(e);
            }
        }
        self.entries = keep;
        out
    }
    pub fn expire(&mut self, now: i64) -> usize {
        let before = self.entries.len();
        let hold = self.hold_ms;
        self.entries.retain(|e| now - e.3 <= hold);
        before - self.entries.len()
    }
}

/// Which contacts hold a open link we should not dial again (a convenience for adapters).
pub fn open_uids(links: &[LinkInfo]) -> HashSet<&str> {
    links
        .iter()
        .filter(|l| l.ready)
        .map(|l| l.uid.as_str())
        .collect()
}
