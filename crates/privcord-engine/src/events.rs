//! Ordered event delivery with bounded queues.
//!
//! Each subscriber has a bounded queue. A subscriber that stops reading never blocks the engine: when its queue is full,
//! new events are dropped for it and counted. Nothing is lost silently: the reader gets `Lagged { missed }` in order as
//! soon as there is room, or when it has drained everything, and the event numbers (which rise by one) show the gap.
//! After `Lagged` the UI asks for a snapshot instead of replaying history.

use crate::api::EngineEvent;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc::{sync_channel, Receiver, RecvError, RecvTimeoutError, SyncSender, TryRecvError, TrySendError},
    Arc,
};
use std::time::Duration;

pub const SUBSCRIBER_QUEUE: usize = 256;

struct Subscriber {
    tx: SyncSender<(u64, EngineEvent)>,
    missed: Arc<AtomicU64>,
}

#[derive(Default)]
pub struct EventHub {
    seq: u64,
    subscribers: Vec<Subscriber>,
}

/// One subscriber's view of the event stream.
#[derive(Debug)]
pub struct EventStream {
    rx: Receiver<(u64, EngineEvent)>,
    missed: Arc<AtomicU64>,
    last_seq: u64,
}

impl EventStream {
    fn lagged(&mut self) -> Option<(u64, EngineEvent)> {
        let missed = self.missed.swap(0, Ordering::SeqCst);
        (missed > 0).then(|| (self.last_seq, EngineEvent::Lagged { missed }))
    }

    pub fn try_recv(&mut self) -> Result<(u64, EngineEvent), TryRecvError> {
        match self.rx.try_recv() {
            Ok(item) => {
                self.last_seq = item.0;
                Ok(item)
            }
            Err(e) => self.lagged().ok_or(e),
        }
    }

    pub fn recv(&mut self) -> Result<(u64, EngineEvent), RecvError> {
        match self.rx.recv() {
            Ok(item) => {
                self.last_seq = item.0;
                Ok(item)
            }
            Err(e) => self.lagged().ok_or(e),
        }
    }

    pub fn recv_timeout(&mut self, timeout: Duration) -> Result<(u64, EngineEvent), RecvTimeoutError> {
        match self.rx.recv_timeout(timeout) {
            Ok(item) => {
                self.last_seq = item.0;
                Ok(item)
            }
            Err(e) => self.lagged().ok_or(e),
        }
    }
}

impl std::fmt::Debug for EventHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventHub").field("seq", &self.seq).field("subscribers", &self.subscribers.len()).finish()
    }
}

impl EventHub {
    pub fn subscribe(&mut self) -> EventStream {
        let (tx, rx) = sync_channel(SUBSCRIBER_QUEUE);
        let missed = Arc::new(AtomicU64::new(0));
        self.subscribers.push(Subscriber { tx, missed: missed.clone() });
        EventStream { rx, missed, last_seq: self.seq }
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn publish(&mut self, event: EngineEvent) {
        self.seq += 1;
        let seq = self.seq;
        self.subscribers.retain_mut(|s| {
            // If this subscriber fell behind and there is room again, say so first so the marker stays in order.
            let pending = s.missed.load(Ordering::SeqCst);
            if pending > 0 {
                match s.tx.try_send((seq, EngineEvent::Lagged { missed: pending })) {
                    Ok(()) => {
                        s.missed.fetch_sub(pending.min(s.missed.load(Ordering::SeqCst)), Ordering::SeqCst);
                    }
                    Err(TrySendError::Full(_)) => {
                        s.missed.fetch_add(1, Ordering::SeqCst);
                        return true;
                    }
                    Err(TrySendError::Disconnected(_)) => return false,
                }
            }
            match s.tx.try_send((seq, event.clone())) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) => {
                    s.missed.fetch_add(1, Ordering::SeqCst);
                    true
                }
                Err(TrySendError::Disconnected(_)) => false,
            }
        });
    }
}
