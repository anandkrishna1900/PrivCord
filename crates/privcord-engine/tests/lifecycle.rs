//! Link lifetime, dialing, six-word invites, removing friends and emergency deletion, through the engine with fake
//! radios and a fake signaling service.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::rng::SeededEntropy;
use privcord_domain::{
    killswitch::{KillSwitchScope, StepStatus},
    privacy::ContactTrust,
    state::{ConnectionFailure, ConnectionPath, ConnectionState},
    ConversationId, MessageId, UserId,
};
use privcord_engine::{Core, EngineEvent, ErrorCode, EventStream, Ports};
use privcord_ports::{
    testing::{
        FakeClock, MemorySecureStore, MemoryStorage, RecordingNotifier, RecordingTransport,
        SignalOp,
    },
    SecureStore, Storage,
};
use std::sync::Arc;

struct Node {
    core: Core,
    transport: Arc<RecordingTransport>,
    storage: Arc<MemoryStorage>,
    secure: Arc<MemorySecureStore>,
    clock: Arc<FakeClock>,
    events: EventStream,
    uid: UserId,
}

fn node(seed: &str, clock: &Arc<FakeClock>) -> Node {
    let (storage, secure, transport) = (
        MemoryStorage::new(),
        MemorySecureStore::new(),
        RecordingTransport::new(),
    );
    let mut core = Core::new(Ports {
        storage: storage.clone(),
        secure: secure.clone(),
        transport: transport.clone(),
        clock: clock.clone(),
        notifier: RecordingNotifier::new(),
        entropy: Box::new(SeededEntropy::new(seed)),
    })
    .unwrap();
    let events = core.subscribe();
    core.create_identity().unwrap();
    let uid = core.own_uid().unwrap().clone();
    Node {
        core,
        transport,
        storage,
        secure,
        clock: clock.clone(),
        events,
        uid,
    }
}

fn befriend(a: &mut Node, b: &mut Node) {
    let (ac, bc) = (
        a.core.own_card(Some("A")).unwrap(),
        b.core.own_card(Some("B")).unwrap(),
    );
    a.core.add_contact(&bc, ContactTrust::Verified).unwrap();
    b.core.add_contact(&ac, ContactTrust::Verified).unwrap();
}

fn pump(a: &mut Node, b: &mut Node) {
    loop {
        let (fa, fb) = (a.transport.drain(), b.transport.drain());
        if fa.is_empty() && fb.is_empty() {
            return;
        }
        for (_, f) in fa {
            b.core.frame_received(&a.uid, &f);
        }
        for (_, f) in fb {
            a.core.frame_received(&b.uid, &f);
        }
    }
}

fn connect(a: &mut Node, b: &mut Node) {
    a.transport.set_connected(&b.uid, true);
    b.transport.set_connected(&a.uid, true);
    a.core.link_up(&b.uid, ConnectionPath::DirectLan).unwrap();
    b.core.link_up(&a.uid, ConnectionPath::DirectLan).unwrap();
    pump(a, b);
}

fn pass_time(a: &mut Node, b: &mut Node, ms: i64) {
    let mut left = ms;
    while left > 0 {
        let step = left.min(2_000);
        a.clock.advance(step);
        left -= step;
        a.core.tick();
        b.core.tick();
        pump(a, b);
    }
}

fn state_of(n: &Node, who: &UserId) -> ConnectionState {
    n.core
        .snapshot()
        .contacts
        .iter()
        .find(|c| &c.uid == who)
        .unwrap()
        .connection
}

fn drain_events(n: &mut Node) -> Vec<EngineEvent> {
    let mut out = Vec::new();
    while let Ok((_, e)) = n.events.try_recv() {
        out.push(e);
    }
    out
}

#[test]
fn pings_keep_a_quiet_link_alive_and_silence_kills_it() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    befriend(&mut a, &mut b);
    connect(&mut a, &mut b);
    assert!(matches!(
        state_of(&a, &b.uid),
        ConnectionState::Connected { .. }
    ));

    // A minute of nothing but heartbeats: still connected on both sides.
    pass_time(&mut a, &mut b, 60_000);
    assert!(matches!(
        state_of(&a, &b.uid),
        ConnectionState::Connected { .. }
    ));
    assert!(matches!(
        state_of(&b, &a.uid),
        ConnectionState::Connected { .. }
    ));
    assert!(a.transport.drain_closed().is_empty());

    // Bob goes silent (no pongs, no frames). Within the dead-link time Alice drops the link and asks for it to be closed.
    for _ in 0..8 {
        a.clock.advance(2_000);
        a.core.tick();
        a.transport.drain(); // her pings go nowhere
    }
    assert_eq!(
        state_of(&a, &b.uid),
        ConnectionState::Failed {
            reason: ConnectionFailure::Timeout
        }
    );
    assert_eq!(a.transport.drain_closed(), [b.uid.clone()]);
}

#[test]
fn dials_are_requested_with_backoff_a_few_at_a_time_and_stop_when_connected() {
    let clock = FakeClock::at(1_700_000_000_000);
    let mut me = node("me", &clock);
    let mut others: Vec<Node> = (0..5)
        .map(|i| node(&format!("friend-{i}"), &clock))
        .collect();
    for o in &mut others {
        befriend(&mut me, o);
    }
    drain_events(&mut me);
    me.core.tick();
    let dials: Vec<(UserId, bool)> = drain_events(&mut me)
        .into_iter()
        .filter_map(|e| match e {
            EngineEvent::DialRequested { peer, initiator } => Some((peer, initiator)),
            _ => None,
        })
        .collect();
    assert_eq!(dials.len(), 3, "at most three dials at once");
    for (peer, initiator) in &dials {
        assert_eq!(
            *initiator,
            me.uid.as_str() < peer.as_str(),
            "the lower uid sends the offer"
        );
    }
    // Right away: nothing more (the three are in progress, the other two wait for a slot).
    me.core.tick();
    assert!(drain_events(&mut me)
        .iter()
        .all(|e| !matches!(e, EngineEvent::DialRequested { .. })));
    // After the grace period the other two get their turn; the first three back off (10 s after their first try).
    me.clock.advance(9_000);
    me.core.tick();
    let second: Vec<UserId> = drain_events(&mut me)
        .into_iter()
        .filter_map(|e| match e {
            EngineEvent::DialRequested { peer, .. } => Some(peer),
            _ => None,
        })
        .collect();
    assert_eq!(second.len(), 2);
    assert!(second.iter().all(|p| !dials.iter().any(|(d, _)| d == p)));
}

#[test]
fn six_word_invites_pair_two_people_through_a_signaling_service() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    assert_eq!(a.core.create_invite().unwrap_err(), ErrorCode::NoSignaling);
    a.transport.set_signaling(true);
    b.transport.set_signaling(true);

    let (words, expires) = a.core.create_invite().unwrap();
    assert_eq!(words.split(' ').count(), 6);
    assert_eq!(expires, clock.now_ms_for_test() + 15 * 60 * 1000);
    assert_eq!(
        a.core.create_invite().unwrap().0,
        words,
        "an open invite is reused"
    );
    let ops = a.transport.drain_signals();
    let mailbox = ops
        .iter()
        .find_map(|o| match o {
            SignalOp::Subscribe(m) => Some(m.clone()),
            _ => None,
        })
        .unwrap();
    let live: Vec<_> = ops
        .iter()
        .filter_map(|o| match o {
            SignalOp::Put {
                blob,
                kind,
                ttl_sec,
                ..
            } => Some((blob.clone(), *kind, *ttl_sec)),
            _ => None,
        })
        .collect();
    assert_eq!(
        live.len(),
        1,
        "live copy only: nothing is stored unless the person allows it"
    );
    assert_eq!(live[0].2, 120);

    // Bob types the words: the search listens on the same mailbox; Alice's card arrives; he sees who it is.
    assert_eq!(b.core.preview_invite(&words).unwrap(), None);
    assert!(b.core.snapshot().lookup_pending);
    assert!(b
        .transport
        .drain_signals()
        .contains(&SignalOp::Subscribe(mailbox.clone())));
    b.core.signal_blob(&mailbox, &live[0].0);
    b.core.signal_blob(&mailbox, &live[0].0); // a second service delivers the same blob: ignored
    let found: Vec<_> = drain_events(&mut b)
        .into_iter()
        .filter(|e| matches!(e, EngineEvent::InviteFound { .. }))
        .collect();
    assert_eq!(found.len(), 1);
    assert!(
        matches!(&found[0], EngineEvent::InviteFound { uid, name, .. } if *uid == a.uid && *name == format!("Friend {}", &a.uid.as_str()[..8]))
    );
    assert!(!b.core.snapshot().lookup_pending);

    // He accepts: Alice is a verified friend, and his own card goes back to the mailbox.
    assert_eq!(b.core.accept_invite(&words).unwrap(), a.uid);
    let reply: Vec<_> = b
        .transport
        .drain_signals()
        .into_iter()
        .filter_map(|o| match o {
            SignalOp::Put { blob, .. } => Some(blob),
            _ => None,
        })
        .collect();
    assert_eq!(reply.len(), 1);
    assert_eq!(
        b.core.snapshot().answer.map(|a| a.status),
        Some(privcord_engine::AnswerStatus::Sent)
    );
    assert!(b.core.snapshot().contacts.iter().any(|c| c.uid == a.uid));

    // Alice sees a request, with the safety number both sides will see, and accepts it.
    a.core.signal_blob(&mailbox, &reply[0]);
    let req = a.core.snapshot().requests;
    assert_eq!(req.len(), 1);
    assert_eq!(req[0].uid, b.uid);
    let bob_sees = b.core.snapshot().contacts[0].safety_number.clone();
    assert_eq!(req[0].safety_number, bob_sees);
    assert_eq!(a.core.accept_request(&b.uid).unwrap(), b.uid);
    assert!(a.core.snapshot().requests.is_empty());
    assert!(a.core.snapshot().contacts.iter().all(|c| c.can_message));

    // Words that nobody published cannot be accepted without a successful search.
    assert_eq!(
        b.core.accept_invite("apple river tiger moon cloud seven"),
        Err(ErrorCode::InviteNotFound)
    );
    // And a full card works without any service.
    let c = node("carol", &clock);
    let card = c.core.own_card(Some("Carol")).unwrap();
    let preview = b.core.preview_invite(&card).unwrap().unwrap();
    assert_eq!((preview.name.as_str(), preview.already), ("Carol", false));
    assert_eq!(
        b.core.preview_invite(&b.core.own_card(None).unwrap()),
        Err(ErrorCode::OwnInvite)
    );
    assert_eq!(
        b.core.preview_invite("not an invite"),
        Err(ErrorCode::InvalidInvite)
    );
}

trait ClockExt {
    fn now_ms_for_test(&self) -> i64;
}
impl ClockExt for Arc<FakeClock> {
    fn now_ms_for_test(&self) -> i64 {
        use privcord_ports::Clock;
        self.now_ms()
    }
}

#[test]
fn an_open_invite_is_republished_expires_and_a_failed_answer_can_be_retried() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    a.transport.set_signaling(true);
    b.transport.set_signaling(true);
    a.core.set_store_forward(true).unwrap();
    let (words, _) = a.core.create_invite().unwrap();
    let puts = |n: &Node| {
        n.transport
            .drain_signals()
            .into_iter()
            .filter_map(|o| match o {
                SignalOp::Put {
                    kind,
                    ttl_sec,
                    blob,
                    mailbox,
                } => Some((kind, ttl_sec, blob, mailbox)),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let first = puts(&a);
    assert_eq!(
        first.len(),
        2,
        "with store-and-forward on, a stored copy as well"
    );
    assert_eq!(first[1].1, 900);

    a.clock.advance(3_000);
    a.core.tick();
    assert!(puts(&a).is_empty(), "not yet");
    a.clock.advance(2_000);
    a.core.tick();
    assert_eq!(puts(&a).len(), 2, "republished after 4 s");

    // Bob finds the invite but the service fails when he answers: the answer is marked failed, and retrying works.
    let (_, _, blob, mailbox) = first[0].clone();
    assert_eq!(b.core.preview_invite(&words).unwrap(), None);
    b.core.signal_blob(&mailbox, &blob);
    b.transport.set_signal_fails(true);
    b.core.accept_invite(&words).unwrap();
    assert_eq!(
        b.core.snapshot().answer.map(|x| x.status),
        Some(privcord_engine::AnswerStatus::Failed)
    );
    b.transport.set_signal_fails(false);
    b.core.retry_answer().unwrap();
    assert_eq!(
        b.core.snapshot().answer.map(|x| x.status),
        Some(privcord_engine::AnswerStatus::Sent)
    );
    b.core.clear_answer();
    assert!(b.core.snapshot().answer.is_none());

    // The invite lapses after 15 minutes, and the service is told to stop listening.
    for _ in 0..120 {
        a.clock.advance(8_000);
        a.core.tick();
    }
    assert!(a.core.snapshot().invite.is_none());
    assert!(a
        .transport
        .drain_signals()
        .contains(&SignalOp::Unsubscribe(mailbox)));
}

#[test]
fn a_search_that_finds_nothing_gives_up_after_forty_seconds() {
    let clock = FakeClock::at(1_700_000_000_000);
    let mut b = node("bob", &clock);
    b.transport.set_signaling(true);
    drain_events(&mut b);
    assert_eq!(
        b.core
            .preview_invite("apple river tiger moon cloud seven")
            .unwrap(),
        None
    );
    b.clock.advance(39_000);
    b.core.tick();
    assert!(b.core.snapshot().lookup_pending);
    b.clock.advance(2_000);
    b.core.tick();
    assert!(!b.core.snapshot().lookup_pending);
    assert!(drain_events(&mut b)
        .iter()
        .any(|e| matches!(e, EngineEvent::InviteLookupFailed)));
}

#[test]
fn removing_a_friend_forgets_them_and_their_chat_but_not_while_they_share_a_group() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b, mut c) = (
        node("alice", &clock),
        node("bob", &clock),
        node("carol", &clock),
    );
    befriend(&mut a, &mut b);
    befriend(&mut a, &mut c);
    a.core.send_message(&b.uid, "hi bob", None).unwrap();
    a.core.send_message(&c.uid, "hi carol", None).unwrap();
    let gid = a.core.create_group("Trip", &[b.uid.clone()]).unwrap();
    assert_eq!(a.core.remove_contact(&b.uid), Err(ErrorCode::StillInGroup));
    a.core.remove_group_member(&gid, &b.uid).unwrap();
    a.core.remove_contact(&b.uid).unwrap();
    let snap = a.core.snapshot();
    assert!(snap.contacts.iter().all(|x| x.uid != b.uid));
    assert_eq!(snap.messages.len(), 1, "only Carol's chat remains");
    assert_eq!(a.storage.messages().unwrap().len(), 1);
    assert_eq!(
        a.storage.outbox().unwrap().len(),
        1,
        "Bob's queued message is gone too"
    );
    assert_eq!(
        a.core.remove_contact(&b.uid),
        Err(ErrorCode::UnknownContact)
    );
    // Restart: still gone.
    let again = Core::new(Ports {
        storage: a.storage.clone(),
        secure: a.secure.clone(),
        transport: RecordingTransport::new(),
        clock: clock.clone(),
        notifier: RecordingNotifier::new(),
        entropy: Box::new(SeededEntropy::new("again")),
    })
    .unwrap();
    assert!(again.snapshot().contacts.iter().all(|x| x.uid != b.uid));
}

#[test]
fn emergency_deletion_erases_everything_reports_truthfully_and_continues_after_a_failure() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    befriend(&mut a, &mut b);
    connect(&mut a, &mut b);
    a.core.send_message(&b.uid, "secret", None).unwrap();
    a.core
        .send_file(
            &b.uid,
            "f.bin",
            "application/octet-stream",
            vec![1; 100],
            None,
        )
        .unwrap();
    pump(&mut a, &mut b);
    a.core.join_channel("town").unwrap();
    let (chat_before, files_before) = (a.storage.messages().unwrap().len(), 1);
    assert!(chat_before >= 2 && files_before == 1);

    // One chat only: its messages and files go, the link is closed with "delete session", the contact stays.
    let report = a
        .core
        .kill_switch_conversation(ConversationId::Direct(b.uid.clone()), true);
    assert!(report.summarize().complete, "{report:?}");
    assert_eq!(report.steps.len(), 3);
    assert!(a.storage.messages().unwrap().is_empty());
    assert!(a.core.snapshot().contacts.iter().any(|x| x.uid == b.uid));
    assert_eq!(a.transport.drain_closed(), [b.uid.clone()]);

    // Everything, with the database failing on one step: the report says partial and names the step.
    a.core.send_message(&b.uid, "another", None).unwrap();
    // Applies in a run: each step saves its report, so the 4th is the messages step (after network, services, transfers).
    a.storage.fail_apply_at(4);
    let first = a.core.kill_switch_app();
    let s = first.summarize();
    assert!(s.partial && !s.complete, "{first:?}");
    assert_eq!(s.failed_step_ids.len(), 1);
    assert_eq!(first.scope, KillSwitchScope::Application);
    // Saved after every step, so a crash would have left this visible; running it again continues and completes.
    assert!(a.core.last_kill_switch_report().is_some());
    let second = a.core.kill_switch_app();
    assert!(second.summarize().complete, "{second:?}");
    assert_eq!(
        second
            .steps
            .iter()
            .filter(|x| x.status == StepStatus::Failed)
            .count(),
        0
    );
    assert!(a.core.own_uid().is_none() && a.secure.load_identity().unwrap().is_none());
    assert!(a.storage.contacts().unwrap().is_empty());
    assert!(a.storage.messages().unwrap().is_empty());
    assert!(a.storage.outbox().unwrap().is_empty());
    assert!(a.storage.kv("channels.v1").unwrap().is_none());
    assert!(a.core.snapshot().contacts.is_empty() && a.core.snapshot().channels.is_empty());
    // And the app starts over: a new identity can be made.
    assert!(a.core.create_identity().is_ok());
    // The identity step is the only one that touches the keychain; skipped steps are named, never hidden.
    assert!(second
        .steps
        .iter()
        .any(|x| x.step_id == "services.stop" && x.status == StepStatus::Skipped));
}

fn put_blobs(n: &Node) -> Vec<(String, String, privcord_domain::signaling::PutKind)> {
    n.transport
        .drain_signals()
        .into_iter()
        .filter_map(|o| match o {
            SignalOp::Put {
                mailbox,
                blob,
                kind,
                ..
            } => Some((mailbox, blob, kind)),
            _ => None,
        })
        .collect()
}

#[test]
fn connection_setup_travels_sealed_and_only_the_right_side_acts_on_it() {
    use privcord_domain::signaling::PutKind;
    use privcord_engine::SignalMessage;
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    befriend(&mut a, &mut b);
    a.transport.set_signaling(true);
    b.transport.set_signaling(true);
    // The lower uid is the one that offers.
    let (offerer, answerer) = if a.uid.as_str() < b.uid.as_str() {
        (&mut a, &mut b)
    } else {
        (&mut b, &mut a)
    };
    offerer.core.tick();
    answerer.core.tick();
    // Each side listens on its own mailbox once signaling is up.
    assert!(offerer
        .transport
        .drain_signals()
        .iter()
        .any(|o| matches!(o, SignalOp::Subscribe(_))));
    answerer.transport.drain_signals();
    drain_events(answerer);

    offerer
        .core
        .send_signal(&answerer.uid, &SignalMessage::Offer("v=0 offer".into()))
        .unwrap();
    let puts = put_blobs(offerer);
    assert_eq!(puts.len(), 1);
    assert_eq!(puts[0].2, PutKind::Sig);
    // The mailbox is the answerer's, and the service sees only an encrypted blob.
    assert!(!puts[0].1.contains("v=0"));
    answerer.core.signal_blob(&puts[0].0, &puts[0].1);
    answerer.core.signal_blob(&puts[0].0, &puts[0].1); // a second service: ignored
    let got: Vec<_> = drain_events(answerer)
        .into_iter()
        .filter_map(|e| match e {
            EngineEvent::SignalReceived { peer, message } => Some((peer, message)),
            _ => None,
        })
        .collect();
    assert_eq!(
        got,
        [(
            offerer.uid.clone(),
            SignalMessage::Offer("v=0 offer".into())
        )]
    );

    // The answer goes back and only the offerer acts on it; an offer sent to the offerer is ignored.
    answerer
        .core
        .send_signal(&offerer.uid, &SignalMessage::Answer("v=0 answer".into()))
        .unwrap();
    let back = put_blobs(answerer);
    offerer.core.signal_blob(&back[0].0, &back[0].1);
    assert!(drain_events(offerer).iter().any(|e| matches!(e, EngineEvent::SignalReceived { message: SignalMessage::Answer(s), .. } if s == "v=0 answer")));
    answerer
        .core
        .send_signal(&offerer.uid, &SignalMessage::Offer("wrong way".into()))
        .unwrap();
    let wrong = put_blobs(answerer);
    offerer.core.signal_blob(&wrong[0].0, &wrong[0].1);
    assert!(drain_events(offerer)
        .iter()
        .all(|e| !matches!(e, EngineEvent::SignalReceived { .. })));

    // A blob from somebody we do not know, or one aimed at someone else, does nothing.
    let stranger = node("zed", &clock);
    let _ = stranger;
    answerer.core.signal_blob(&back[0].0, "not a blob");
    // Without any service and without a mutual contact there is no way to send.
    answerer.transport.set_signaling(false);
    assert_eq!(
        answerer
            .core
            .send_signal(&offerer.uid, &SignalMessage::Ready),
        Err(ErrorCode::NoRoute)
    );
}

#[test]
fn a_message_for_an_offline_friend_waits_on_the_relay_only_when_allowed_and_is_acknowledged_sealed()
{
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    befriend(&mut a, &mut b);
    a.transport.set_signaling(true);
    b.transport.set_signaling(true);
    let id = a.core.send_message(&b.uid, "see you at 9", None).unwrap();
    a.core.tick();
    assert!(
        put_blobs(&a).is_empty(),
        "store-and-forward is off: nothing leaves the device"
    );

    a.core.set_store_forward(true).unwrap();
    a.core.tick();
    let sent = put_blobs(&a);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].2, privcord_domain::signaling::PutKind::Msg);
    assert!(!sent[0].1.contains("see you"), "the relay sees ciphertext");
    let status = |n: &Node| {
        n.core
            .snapshot()
            .messages
            .iter()
            .flat_map(|(_, v)| v.iter())
            .find(|m| m.message_id == id)
            .unwrap()
            .delivery_state
    };
    assert_eq!(status(&a), privcord_domain::message::DeliveryState::Sent);
    a.core.tick();
    assert!(put_blobs(&a).is_empty(), "handed over once, not every tick");

    // Bob gets it through the service, stores it as a relay message, and answers with a sealed receipt.
    b.core.signal_blob(&sent[0].0, &sent[0].1);
    let m = b
        .core
        .snapshot()
        .messages
        .into_iter()
        .flat_map(|(_, v)| v)
        .next()
        .unwrap();
    assert_eq!(
        (m.text.as_str(), m.transport),
        (
            "see you at 9",
            privcord_domain::message::TransportKind::Relay
        )
    );
    let receipt = put_blobs(&b);
    assert_eq!(receipt.len(), 1);
    a.core.signal_blob(&receipt[0].0, &receipt[0].1);
    assert_eq!(
        status(&a),
        privcord_domain::message::DeliveryState::Delivered
    );
    assert_eq!(a.core.snapshot().queued, 0);
}

#[test]
fn without_the_internet_a_contact_in_the_middle_hands_connection_setup_on() {
    use privcord_engine::SignalMessage;
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b, mut c) = (
        node("alice", &clock),
        node("bob", &clock),
        node("carol", &clock),
    );
    befriend(&mut a, &mut b);
    befriend(&mut a, &mut c);
    befriend(&mut b, &mut c);
    // Carol is linked to both; Alice and Bob have no direct link and no signaling service.
    connect(&mut a, &mut c);
    connect(&mut b, &mut c);
    drain_events(&mut b);
    a.core.send_signal(&b.uid, &SignalMessage::Ready).unwrap();
    // Deliver every frame to whoever it is addressed to, until quiet (Carol sits between the other two).
    loop {
        let mut moved = false;
        let uids = [a.uid.clone(), b.uid.clone(), c.uid.clone()];
        let nodes = [&mut a, &mut b, &mut c];
        let mut inflight = Vec::new();
        for (i, n) in nodes.iter().enumerate() {
            for (to, f) in n.transport.drain() {
                inflight.push((i, to, f));
            }
        }
        let [a2, b2, c2] = nodes;
        for (from, to, f) in inflight {
            moved = true;
            let target = if to == uids[0] {
                &mut *a2
            } else if to == uids[1] {
                &mut *b2
            } else {
                &mut *c2
            };
            target.core.frame_received(&uids[from], &f);
        }
        if !moved {
            break;
        }
    }
    assert!(drain_events(&mut b).iter().any(|e| matches!(e, EngineEvent::SignalReceived { peer, message: SignalMessage::Ready } if *peer == a.uid)));
}

#[test]
fn resetting_the_dial_backoff_dials_again_at_the_next_tick_instead_of_waiting() {
    let clock = FakeClock::at(1_700_000_000_000);
    let mut me = node("me", &clock);
    let mut friend = node("friend", &clock);
    befriend(&mut me, &mut friend);
    let dials = |n: &mut Node| {
        drain_events(n)
            .into_iter()
            .filter(|e| matches!(e, EngineEvent::DialRequested { .. }))
            .count()
    };
    drain_events(&mut me);
    me.core.tick();
    assert_eq!(dials(&mut me), 1, "the first dial is immediate");
    // The first try failed (say, signaling was not up yet). After the 8 s grace the 5 s back-off has passed...
    me.clock.advance(1_000);
    me.core.tick();
    assert_eq!(
        dials(&mut me),
        0,
        "while that try is still in progress nothing more is asked"
    );
    // ...but a reset makes the very next tick dial again, with no waiting.
    me.core.reset_dial_backoff(None);
    me.core.tick();
    assert_eq!(dials(&mut me), 1);
}

#[test]
fn replayed_offers_and_answers_to_replaced_offers_are_ignored_and_a_quiet_link_gives_way() {
    use privcord_engine::SignalMessage;
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    befriend(&mut a, &mut b);
    a.transport.set_signaling(true);
    b.transport.set_signaling(true);
    let (offerer, answerer) = if a.uid.as_str() < b.uid.as_str() {
        (&mut a, &mut b)
    } else {
        (&mut b, &mut a)
    };
    let offers = |n: &mut Node| -> Vec<String> {
        drain_events(n)
            .into_iter()
            .filter_map(|e| match e {
                EngineEvent::SignalReceived {
                    message: SignalMessage::Offer(s),
                    ..
                } => Some(s),
                _ => None,
            })
            .collect()
    };
    let answers = |n: &mut Node| -> Vec<String> {
        drain_events(n)
            .into_iter()
            .filter_map(|e| match e {
                EngineEvent::SignalReceived {
                    message: SignalMessage::Answer(s),
                    ..
                } => Some(s),
                _ => None,
            })
            .collect()
    };
    drain_events(answerer);

    // Two attempts; the relay hands them over newest first (as after a reconnect replay out of order).
    offerer
        .core
        .send_signal(&answerer.uid, &SignalMessage::Offer("first".into()))
        .unwrap();
    let first = put_blobs(offerer).remove(0);
    clock.advance(20_000);
    offerer
        .core
        .send_signal(&answerer.uid, &SignalMessage::Offer("second".into()))
        .unwrap();
    let second = put_blobs(offerer).remove(0);
    answerer.core.signal_blob(&second.0, &second.1);
    answerer.core.signal_blob(&first.0, &first.1);
    assert_eq!(
        offers(answerer),
        ["second"],
        "the older offer, arriving late, is dropped"
    );

    // The answer names the offer it answers, so the offerer applies it.
    answerer
        .core
        .send_signal(&offerer.uid, &SignalMessage::Answer("for second".into()))
        .unwrap();
    let good = put_blobs(answerer).remove(0);
    // An answer to the first offer (made before the second arrived) is ignored by the offerer.
    offerer
        .core
        .send_signal(&answerer.uid, &SignalMessage::Offer("third".into()))
        .unwrap();
    put_blobs(offerer);
    offerer.core.signal_blob(&good.0, &good.1);
    assert!(
        answers(offerer).is_empty(),
        "an answer to a replaced offer is not applied"
    );

    // Linked and talking: a new offer is stale and ignored. Once the link is silent, the offer replaces it.
    connect(offerer, answerer);
    drain_events(answerer);
    clock.advance(1_000);
    offerer
        .core
        .send_signal(&answerer.uid, &SignalMessage::Offer("while up".into()))
        .unwrap();
    let up = put_blobs(offerer).remove(0);
    answerer.core.signal_blob(&up.0, &up.1);
    assert!(
        offers(answerer).is_empty(),
        "a live link is not torn down by an offer"
    );
    clock.advance(7_000);
    offerer
        .core
        .send_signal(&answerer.uid, &SignalMessage::Offer("after silence".into()))
        .unwrap();
    let late = put_blobs(offerer).remove(0);
    answerer.core.signal_blob(&late.0, &late.1);
    assert_eq!(offers(answerer), ["after silence"]);
    assert!(
        answerer.transport.drain_closed().contains(&offerer.uid),
        "the silent link was closed"
    );
    assert!(!matches!(
        state_of(answerer, &offerer.uid),
        ConnectionState::Connected { .. }
    ));
}

#[test]
fn adding_someone_from_their_qr_code_asks_them_to_add_us_back() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    a.transport.set_signaling(true);
    b.transport.set_signaling(true);
    // Alice scans Bob's QR code (his card). Bob does not know her yet.
    let bob_card = b.core.own_card(Some("Bob")).unwrap();
    assert_eq!(a.core.accept_invite(&bob_card).unwrap(), b.uid);
    let bob_mailbox = privcord_crypto::seal::mailbox_for(b.uid.as_str());
    let sent = put_blobs(&a);
    let hello: Vec<_> = sent.iter().filter(|(m, _, _)| *m == bob_mailbox).collect();
    assert!(!hello.is_empty(), "a request goes to Bob's mailbox");

    // Bob's phone gets it: Alice waits as a request he can accept with one tap.
    drain_events(&mut b);
    for (m, blob, _) in &hello {
        b.core.signal_blob(m, blob);
    }
    assert!(b.core.snapshot().requests.iter().any(|r| r.uid == a.uid));
    assert!(drain_events(&mut b)
        .iter()
        .any(|e| matches!(e, EngineEvent::InviteRequest { uid } if *uid == a.uid)));
    assert_eq!(b.core.accept_request(&a.uid).unwrap(), a.uid);
    assert!(b.core.snapshot().requests.is_empty());
    assert!(b.core.snapshot().contacts.iter().any(|c| c.uid == a.uid));

    // While they have not connected, Alice asks again every minute, and stops after half an hour.
    clock.advance(60_000);
    a.core.tick();
    assert!(put_blobs(&a).iter().any(|(m, _, _)| *m == bob_mailbox));
    clock.advance(31 * 60_000);
    a.core.tick();
    put_blobs(&a);
    clock.advance(60_000);
    a.core.tick();
    assert!(!put_blobs(&a).iter().any(|(m, _, _)| *m == bob_mailbox));
}

#[test]
fn a_stranger_cannot_get_anything_but_a_genuine_request_through() {
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b, mut eve) = (
        node("alice", &clock),
        node("bob", &clock),
        node("eve", &clock),
    );
    for n in [&a, &b, &eve] {
        n.transport.set_signaling(true);
    }
    let bob_card = b.core.own_card(Some("Bob")).unwrap();
    let bob_mailbox = privcord_crypto::seal::mailbox_for(b.uid.as_str());
    // Eve adds Bob too, then tries to pass her request off as Alice's by swapping the sender.
    eve.core.accept_invite(&bob_card).unwrap();
    let alice_uid = a.uid.as_str().to_owned();
    for (m, blob, _) in put_blobs(&eve)
        .into_iter()
        .filter(|(m, _, _)| *m == bob_mailbox)
    {
        let forged = blob.replace(eve.uid.as_str(), &alice_uid);
        b.core.signal_blob(&m, &forged);
    }
    assert!(b.core.snapshot().requests.iter().all(|r| r.uid != a.uid));
    // A genuine one from Alice still works.
    a.core.accept_invite(&bob_card).unwrap();
    for (m, blob, _) in put_blobs(&a)
        .into_iter()
        .filter(|(m, _, _)| *m == bob_mailbox)
    {
        b.core.signal_blob(&m, &blob);
    }
    assert!(b.core.snapshot().requests.iter().any(|r| r.uid == a.uid));
}

#[test]
fn after_a_link_offline_messages_are_sealed_post_quantum_to_one_time_keys_and_v1_is_refused() {
    use privcord_domain::blob::SealedBlob;
    let clock = FakeClock::at(1_700_000_000_000);
    let (mut a, mut b) = (node("alice", &clock), node("bob", &clock));
    befriend(&mut a, &mut b);
    // One post-quantum link: the two hand each other their keys. Then Bob goes offline.
    connect(&mut a, &mut b);
    a.core.link_down(&b.uid);
    b.core.link_down(&a.uid);
    a.transport.set_connected(&b.uid, false);
    b.transport.set_connected(&a.uid, false);
    a.transport.set_signaling(true);
    b.transport.set_signaling(true);
    a.core.set_store_forward(true).unwrap();
    put_blobs(&a);

    let texts = ["first while away", "second while away"];
    let mut blobs = Vec::new();
    for t in texts {
        a.core.send_message(&b.uid, t, None).unwrap();
        a.core.tick();
        blobs.extend(
            put_blobs(&a)
                .into_iter()
                .filter(|(_, _, k)| *k == privcord_domain::signaling::PutKind::Msg),
        );
    }
    assert_eq!(blobs.len(), 2);
    let decoded: Vec<SealedBlob> = blobs
        .iter()
        .map(|(_, blob, _)| SealedBlob::decode(blob).unwrap())
        .collect();
    for (blob, t) in decoded.iter().zip(texts) {
        assert_eq!(blob.v, 2, "post-quantum sealed");
        assert!(blob.kem.is_some());
        assert!(!blobs.iter().any(|(_, raw, _)| raw.contains(t)));
    }
    assert_ne!(
        decoded[0].key, decoded[1].key,
        "each message has its own one-time key"
    );

    // Bob gets both through the service.
    for (m, blob, _) in &blobs {
        b.core.signal_blob(m, blob);
    }
    let got: Vec<String> = b
        .core
        .snapshot()
        .messages
        .into_iter()
        .flat_map(|(_, v)| v)
        .map(|m| m.text)
        .collect();
    assert_eq!(got, texts);

    // A classic (v1) blob from Alice is refused now that the two have exchanged keys: nobody can force the old protocol.
    let secrets = a.secure.load_identity().unwrap().unwrap();
    let mut stored = privcord_crypto::identity::StoredSecrets {
        sign: [0u8; 32],
        dh: [0u8; 32],
    };
    stored.sign.copy_from_slice(&secrets[..32]);
    stored.dh.copy_from_slice(&secrets[32..]);
    let alice = privcord_crypto::identity::Identity::from_stored(&stored).unwrap();
    let bob_card =
        privcord_crypto::card::ContactCard::decode(&b.core.own_card(None).unwrap()).unwrap();
    let old = privcord_crypto::seal::seal(
        &alice,
        &b.uid,
        &bob_card.card.dh,
        &serde_json::json!({ "t": "msg", "id": "old-1", "text": "v1 attempt", "at": 1 }),
        &mut privcord_crypto::rng::SeededEntropy::new("v1"),
    )
    .unwrap();
    b.core.signal_blob(
        &privcord_crypto::seal::mailbox_for(b.uid.as_str()),
        &old.encode(),
    );
    assert!(
        b.core
            .snapshot()
            .messages
            .into_iter()
            .flat_map(|(_, v)| v)
            .all(|m| m.text != "v1 attempt"),
        "the downgrade is refused"
    );
}

#[test]
fn answers_to_our_words_cannot_flood_the_request_list() {
    use privcord_crypto::{
        identity::Identity,
        invite::{derive_invite, parse_invite_words, seal_invite, InviteKind},
    };
    let clock = FakeClock::at(1_700_000_000_000);
    let mut a = node("alice", &clock);
    a.transport.set_signaling(true);
    let (words, _) = a.core.create_invite().unwrap();
    let rv = derive_invite(&parse_invite_words(&words).unwrap()).unwrap();
    // Someone who learned the words answers under 25 throwaway identities.
    let mut entropy = SeededEntropy::new("flood");
    for _ in 0..25 {
        let id = Identity::generate(&mut entropy).unwrap();
        let blob = seal_invite(&rv, InviteKind::Reply, &id, None, &mut entropy).unwrap();
        a.core.signal_blob(&rv.mailbox, &blob.encode());
    }
    assert_eq!(a.core.snapshot().requests.len(), 20);
}

#[test]
fn a_card_that_pairs_a_friends_uid_with_another_signing_key_is_refused() {
    use privcord_crypto::{card::ContactCard, identity::Identity};
    let clock = FakeClock::at(1_700_000_000_000);
    let mut a = node("forge-a", &clock);
    let mut b = node("forge-b", &clock);
    befriend(&mut a, &mut b);
    // Eve signs Bob's public ECDH key with her own signing key. The card verifies, but the id comes from both keys,
    // so it is Eve's own id, not Bob's: she cannot pass for him anywhere.
    let eve = Identity::generate(&mut SeededEntropy::new("forge-eve")).unwrap();
    let bob = ContactCard::decode(&b.core.own_card(Some("B")).unwrap()).unwrap();
    let payload = privcord_crypto::identity::identity_proof_payload(&bob.card.dh).unwrap();
    let forged = ContactCard {
        sign: eve.sign_public(),
        dh: bob.card.dh.clone(),
        proof: privcord_domain::codec::encode(&eve.sign_message(&payload)),
        name: Some("B".into()),
    }
    .encode()
    .unwrap();
    let forged_uid = ContactCard::decode(&forged).unwrap().uid;
    assert_ne!(forged_uid, b.uid);
    // And Bob's id can only ever be held with Bob's own signing key.
    assert!(a.core.add_contact(&forged, ContactTrust::Verified).is_ok());
    assert!(a
        .core
        .add_contact(&b.core.own_card(Some("B")).unwrap(), ContactTrust::Verified)
        .is_ok());
    let snap = a.core.snapshot();
    assert!(snap.contacts.iter().any(|c| c.uid == b.uid));
}

#[test]
fn data_stored_under_v1_ids_moves_to_the_v2_ids_when_the_engine_starts() {
    use privcord_crypto::{card::ContactCard, identity::legacy_uid};
    use privcord_ports::{StorageOp, StoredContact, StoredMessage};
    let clock = FakeClock::at(1_700_000_000_000);
    let a = node("legacy-a", &clock);
    let b = node("legacy-b", &clock);
    let card = b.core.own_card(Some("B")).unwrap();
    let bob = ContactCard::decode(&card).unwrap();
    let (old_bob, old_me) = (
        legacy_uid(&bob.card.dh).unwrap(),
        legacy_uid(
            &ContactCard::decode(&a.core.own_card(None).unwrap())
                .unwrap()
                .card
                .dh,
        )
        .unwrap(),
    );
    // What an older version left behind: Bob, a chat with him and one of our messages, all under v1 ids.
    let msg = |id: &str, from: &UserId| StoredMessage {
        conversation: ConversationId::Direct(old_bob.clone()),
        message: privcord_domain::message::ChatMessage {
            message_id: MessageId::new(id).unwrap(),
            client_message_id: MessageId::new(id).unwrap(),
            sender_id: from.clone(),
            text: "hi".into(),
            client_created_at: 1,
            kind: privcord_domain::message::MessageKind::Text,
            transport: privcord_domain::message::TransportKind::P2p,
            delivery_state: privcord_domain::message::DeliveryState::Delivered,
            read_at: None,
            reply_to: None,
        },
    };
    a.storage
        .apply(&[
            StorageOp::PutContact(StoredContact {
                uid: old_bob.clone(),
                card,
                name: Some("B".into()),
                trust: ContactTrust::Verified,
                checked: false,
                introduced_by: None,
                created_at: 1,
            }),
            StorageOp::InsertMessage(msg("00000000-0000-4000-8000-000000000001", &old_bob)),
            StorageOp::InsertMessage(msg("00000000-0000-4000-8000-000000000002", &old_me)),
        ])
        .unwrap();
    let core = Core::new(Ports {
        storage: a.storage.clone(),
        secure: a.secure.clone(),
        transport: RecordingTransport::new(),
        clock: clock.clone(),
        notifier: RecordingNotifier::new(),
        entropy: Box::new(SeededEntropy::new("legacy-a2")),
    })
    .unwrap();
    let snap = core.snapshot();
    assert!(snap.contacts.iter().any(|c| c.uid == b.uid));
    let chat = &snap
        .messages
        .iter()
        .find(|(c, _)| *c == ConversationId::Direct(b.uid.clone()))
        .expect("the chat moved to Bob's v2 id")
        .1;
    assert_eq!(chat.len(), 2);
    assert!(chat.iter().any(|m| m.sender_id == a.uid));
    assert!(chat.iter().any(|m| m.sender_id == b.uid));
}
