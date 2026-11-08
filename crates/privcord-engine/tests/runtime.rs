//! The real engine runtime: one thread per engine, bounded command queues, timers, and a clean shutdown.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::rng::OsEntropy;
use privcord_domain::{
    message::DeliveryState,
    privacy::ContactTrust,
    state::{ConnectionPath, ConnectionState},
    ConversationId, UserId,
};
use privcord_engine::{EngineEvent, EngineHandle, ErrorCode, Ports};
use privcord_ports::{
    testing::{MemorySecureStore, MemoryStorage, RecordingNotifier},
    Clock, Transport, TransportError,
};
use std::{
    sync::{Arc, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct SystemClock;
impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap()
    }
}

/// Hands frames straight to the other engine, like a perfect link.
#[derive(Default)]
struct Wire {
    to: OnceLock<Arc<EngineHandle>>,
    me: OnceLock<UserId>,
}

impl Transport for Wire {
    fn send(&self, _peer: &UserId, frame: &str) -> Result<(), TransportError> {
        let (to, me) = (
            self.to.get().ok_or(TransportError::NotConnected)?,
            self.me.get().ok_or(TransportError::NotConnected)?,
        );
        to.frame_received(me, frame.to_owned())
            .map_err(|_| TransportError::Refused)
    }
}

fn ports(wire: Arc<Wire>) -> Ports {
    Ports {
        storage: MemoryStorage::new(),
        secure: MemorySecureStore::new(),
        transport: wire,
        clock: Arc::new(SystemClock),
        notifier: RecordingNotifier::new(),
        entropy: Box::new(OsEntropy),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_running_engines_talk_and_shut_down_cleanly() {
    let (wa, wb) = (Arc::new(Wire::default()), Arc::new(Wire::default()));
    let (a, mut a_events) = EngineHandle::start(ports(wa.clone())).unwrap();
    let (b, mut b_events) = EngineHandle::start(ports(wb.clone())).unwrap();
    let (a, b) = (Arc::new(a), Arc::new(b));

    a.create_identity().await.unwrap();
    b.create_identity().await.unwrap();
    let au = a.snapshot().await.unwrap().own_uid.unwrap();
    let bu = b.snapshot().await.unwrap().own_uid.unwrap();
    wa.to.set(b.clone()).unwrap();
    wa.me.set(au.clone()).unwrap();
    wb.to.set(a.clone()).unwrap();
    wb.me.set(bu.clone()).unwrap();

    a.add_contact(
        &b.own_card(Some("Bob")).await.unwrap(),
        ContactTrust::Verified,
    )
    .await
    .unwrap();
    b.add_contact(
        &a.own_card(Some("Alice")).await.unwrap(),
        ContactTrust::Verified,
    )
    .await
    .unwrap();
    a.link_up(&bu, ConnectionPath::DirectLan).await.unwrap();
    b.link_up(&au, ConnectionPath::DirectLan).await.unwrap();

    let connected = |h: Arc<EngineHandle>, who: UserId| async move {
        matches!(
            h.snapshot()
                .await
                .unwrap()
                .contacts
                .iter()
                .find(|c| c.uid == who)
                .map(|c| c.connection),
            Some(ConnectionState::Connected { .. })
        )
    };
    for _ in 0..200 {
        if connected(a.clone(), bu.clone()).await && connected(b.clone(), au.clone()).await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        connected(a.clone(), bu.clone()).await,
        "handshake completed"
    );

    let id = a
        .send_message(&bu, "across two real engines", None)
        .await
        .unwrap();
    let mut delivered = false;
    for _ in 0..200 {
        let snap = a.snapshot().await.unwrap();
        delivered = snap
            .messages
            .iter()
            .flat_map(|(_, v)| v)
            .any(|m| m.message_id == id && m.delivery_state == DeliveryState::Delivered);
        if delivered {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if !delivered {
        eprintln!(
            "A: {:?}\nB: {:?}",
            a.snapshot().await.unwrap(),
            b.snapshot().await.unwrap()
        );
    }
    assert!(delivered);
    let got = b.snapshot().await.unwrap();
    assert_eq!(
        got.messages
            .iter()
            .find(|(c, _)| c == &ConversationId::Direct(au.clone()))
            .unwrap()
            .1[0]
            .text,
        "across two real engines"
    );

    // Shutdown joins the thread; commands afterwards are refused; the stream ends with ShutDown.
    a.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
    assert_eq!(a.snapshot().await.unwrap_err(), ErrorCode::ShuttingDown);
    assert_eq!(
        a.send_message(&bu, "late", None).await.unwrap_err(),
        ErrorCode::ShuttingDown
    );
    let mut last = None;
    while let Ok((_, e)) = a_events.try_recv() {
        last = Some(e);
    }
    assert_eq!(last, Some(EngineEvent::ShutDown));
    b.shutdown().await.unwrap();
    let mut b_last = None;
    while let Ok((_, e)) = b_events.try_recv() {
        b_last = Some(e);
    }
    assert_eq!(b_last, Some(EngineEvent::ShutDown));
}

#[tokio::test]
async fn a_flood_of_commands_is_rejected_not_buffered_without_bound() {
    let (h, _events) = EngineHandle::start(ports(Arc::new(Wire::default()))).unwrap();
    h.create_identity().await.unwrap();
    // Queue far more fire-and-forget frames than the queue holds, without letting the engine run in between.
    let me = h.snapshot().await.unwrap().own_uid.unwrap();
    let mut busy = 0;
    for _ in 0..5000 {
        if h.frame_received(&me, "{}".into()) == Err(ErrorCode::Busy) {
            busy += 1;
        }
    }
    assert!(busy > 0, "a bounded queue must push back");
    h.shutdown().await.unwrap();
}

#[test]
fn dropping_the_handle_stops_the_engine_thread() {
    let (h, _events) = EngineHandle::start(ports(Arc::new(Wire::default()))).unwrap();
    drop(h); // must return: the thread is told to stop and joined
}
