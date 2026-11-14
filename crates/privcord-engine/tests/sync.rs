//! Two installs of one account (a phone and a laptop restored from the same recovery phrase) keep each other up to date
//! through the account's self-mailbox on a relay, even when they are never online at the same time
//! (docs/design/syncengine.md, step 4).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::rng::SeededEntropy;
use privcord_domain::{privacy::ContactTrust, MessageId, UserId};
use privcord_engine::{Core, Ports};
use privcord_ports::testing::{
    FakeClock, MemorySecureStore, MemoryStorage, RecordingNotifier, RecordingTransport, SignalOp,
};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

/// A relay that keeps everything posted (store and forward): a device that subscribes later gets what is there.
#[derive(Default)]
struct Relay {
    boxes: HashMap<String, Vec<String>>,
}

struct Device {
    core: Core,
    transport: Arc<RecordingTransport>,
    subscribed: BTreeSet<String>,
    /// How far each mailbox has been delivered to this device.
    read: HashMap<String, usize>,
}

impl Device {
    fn new(seed: &str, clock: &Arc<FakeClock>) -> Self {
        Self::on(seed, clock, MemoryStorage::new(), MemorySecureStore::new())
    }

    /// An install on existing storage (the app started again).
    fn on(
        seed: &str,
        clock: &Arc<FakeClock>,
        storage: Arc<MemoryStorage>,
        secure: Arc<MemorySecureStore>,
    ) -> Self {
        let transport = RecordingTransport::new();
        transport.set_signaling(true);
        let core = Core::new(Ports {
            storage,
            secure,
            transport: transport.clone(),
            clock: clock.clone(),
            notifier: RecordingNotifier::new(),
            entropy: Box::new(SeededEntropy::new(seed)),
        })
        .unwrap();
        Self {
            core,
            transport,
            subscribed: BTreeSet::new(),
            read: HashMap::new(),
        }
    }

    /// The device is online for a moment: it ticks, posts, and reads what is waiting for it.
    fn online(&mut self, relay: &mut Relay) {
        for _ in 0..4 {
            self.core.tick();
            for op in self.transport.drain_signals() {
                match op {
                    SignalOp::Subscribe(m) => {
                        self.subscribed.insert(m);
                    }
                    SignalOp::Put { mailbox, blob, .. } => {
                        relay.boxes.entry(mailbox).or_default().push(blob)
                    }
                    _ => {}
                }
            }
            for m in self.subscribed.clone() {
                let all = relay.boxes.get(&m).cloned().unwrap_or_default();
                let from = self.read.get(&m).copied().unwrap_or(0);
                for blob in &all[from..] {
                    self.core.signal_blob(&m, blob);
                }
                self.read.insert(m, all.len());
            }
        }
    }

    fn texts(&self) -> Vec<String> {
        let mut t: Vec<String> = self
            .core
            .snapshot()
            .messages
            .into_iter()
            .flat_map(|(_, v)| v)
            .map(|m| m.text)
            .collect();
        t.sort();
        t
    }

    fn message_id(&self, text: &str) -> MessageId {
        self.core
            .snapshot()
            .messages
            .into_iter()
            .flat_map(|(_, v)| v)
            .find(|m| m.text == text)
            .map(|m| m.message_id)
            .unwrap()
    }
}

fn friend(clock: &Arc<FakeClock>) -> (String, UserId) {
    let mut f = Device::new("friend", clock);
    f.core.create_identity().unwrap();
    (
        f.core.own_card(Some("Fran")).unwrap(),
        f.core.own_uid().unwrap().clone(),
    )
}

#[test]
fn phone_and_laptop_catch_up_with_each_other_without_ever_being_online_together() {
    let clock = FakeClock::at(1_700_000_000_000);
    let mut relay = Relay::default();
    let mut phone = Device::new("phone", &clock);
    let phrase = phone.core.create_identity().unwrap();
    let mut laptop = Device::new("laptop", &clock);
    laptop.core.recover_identity(&phrase, "").unwrap();

    // The two learn of each other through the relay, each online on its own: the restored laptop says hello, the
    // phone (which posts nothing while it is alone) hears it and answers, and the laptop reads the answer.
    phone.online(&mut relay);
    laptop.online(&mut relay);
    phone.online(&mut relay);
    laptop.online(&mut relay);
    assert_eq!(phone.core.sync_devices().len(), 1);
    assert_eq!(laptop.core.sync_devices().len(), 1);
    // The two device lists (each install started its own) were merged and signed with the account key: one list,
    // both devices, the same on both.
    let (pl, ll) = (
        phone.core.device_list().unwrap().clone(),
        laptop.core.device_list().unwrap().clone(),
    );
    assert_eq!(pl.active().count(), 2);
    // More rounds do not keep re-signing: the list settles.
    for _ in 0..3 {
        phone.online(&mut relay);
        laptop.online(&mut relay);
    }
    assert_eq!(
        phone.core.device_list().unwrap().version,
        laptop.core.device_list().unwrap().version
    );
    assert_eq!(
        phone.core.device_list().unwrap().version,
        pl.version.max(ll.version),
        "no merge loop"
    );
    assert_eq!(
        pl.active().map(|d| d.id.clone()).collect::<Vec<_>>(),
        ll.active().map(|d| d.id.clone()).collect::<Vec<_>>()
    );

    // On the phone: a new friend and two messages. Then the phone goes away.
    let (card, fran) = friend(&clock);
    phone
        .core
        .add_contact(&card, ContactTrust::Verified)
        .unwrap();
    phone
        .core
        .send_message(&fran, "hi from the phone", None)
        .unwrap();
    phone
        .core
        .send_message(&fran, "second from the phone", None)
        .unwrap();
    clock.advance(5_000);
    phone.online(&mut relay);

    // Later, only the laptop: it has the friend and both messages, and adds its own and a reaction.
    clock.advance(3_600_000);
    laptop.online(&mut relay);
    assert!(
        laptop
            .core
            .snapshot()
            .contacts
            .iter()
            .any(|c| c.uid == fran),
        "the friend came over"
    );
    assert_eq!(
        laptop.texts(),
        ["hi from the phone", "second from the phone"]
    );
    laptop
        .core
        .send_message(&fran, "from the laptop", None)
        .unwrap();
    let first = laptop.message_id("hi from the phone");
    laptop.core.react(&first, "👍").unwrap();
    laptop.online(&mut relay);

    // Later still, only the phone: it has everything the laptop did.
    clock.advance(3_600_000);
    phone.online(&mut relay);
    assert_eq!(
        phone.texts(),
        [
            "from the laptop",
            "hi from the phone",
            "second from the phone"
        ]
    );
    let reactions = phone.core.snapshot().reactions;
    assert!(
        reactions
            .iter()
            .any(|(id, r)| id == &first && r.iter().any(|(_, e)| e == "👍")),
        "the laptop's reaction is on the phone"
    );
    assert_eq!(
        phone.core.sync_fingerprint(),
        laptop.core.sync_fingerprint()
    );

    // The laptop's copies of the phone's messages are not queued to the friend again: only its own message is.
    let laptop_queue: Vec<MessageId> = laptop
        .core
        .snapshot()
        .deliveries
        .into_iter()
        .map(|d| d.message_id)
        .collect();
    assert_eq!(laptop_queue, vec![laptop.message_id("from the laptop")]);

    // A delete on the phone reaches the laptop.
    let second = phone.message_id("second from the phone");
    phone.core.delete_message(&second, true).unwrap();
    phone.online(&mut relay);
    laptop.online(&mut relay);
    assert!(laptop.core.snapshot().deleted.contains(&second));
    assert_eq!(
        phone.core.sync_fingerprint(),
        laptop.core.sync_fingerprint()
    );
}

#[test]
fn a_single_install_posts_only_a_short_hello_and_a_stranger_cannot_read_it() {
    let clock = FakeClock::at(1_700_000_000_000);
    let mut relay = Relay::default();
    let mut alone = Device::new("alone", &clock);
    alone.core.create_identity().unwrap();
    let (card, fran) = friend(&clock);
    alone
        .core
        .add_contact(&card, ContactTrust::Verified)
        .unwrap();
    for i in 0..5 {
        alone
            .core
            .send_message(&fran, &format!("m{i}"), None)
            .unwrap();
    }
    alone.online(&mut relay);
    // Only hellos: nobody else is there to read entries.
    let posted: usize = relay.boxes.values().map(Vec::len).sum();
    assert!(posted <= 2, "posted {posted}");

    let mut stranger = Device::new("stranger", &clock);
    stranger.core.create_identity().unwrap();
    stranger.online(&mut relay);
    // A different account listens on different mailboxes.
    assert!(stranger.subscribed.is_disjoint(&alone.subscribed));
    for (m, blobs) in &relay.boxes {
        for b in blobs {
            stranger.core.signal_blob(m, b);
        }
    }
    assert!(stranger.texts().is_empty());
    assert!(stranger.core.sync_devices().is_empty());
}

#[test]
fn a_restarted_install_carries_on_its_log_without_reusing_a_number() {
    let clock = FakeClock::at(1_700_000_000_000);
    let mut relay = Relay::default();
    let mut phone = Device::new("phone", &clock);
    let phrase = phone.core.create_identity().unwrap();
    let (laptop_storage, laptop_secure) = (MemoryStorage::new(), MemorySecureStore::new());
    let mut laptop = Device::on(
        "laptop",
        &clock,
        laptop_storage.clone(),
        laptop_secure.clone(),
    );
    laptop.core.recover_identity(&phrase, "").unwrap();
    phone.online(&mut relay);
    laptop.online(&mut relay);
    phone.online(&mut relay);
    laptop.online(&mut relay);

    let (card, fran) = friend(&clock);
    laptop
        .core
        .add_contact(&card, ContactTrust::Verified)
        .unwrap();
    laptop
        .core
        .send_message(&fran, "before the restart", None)
        .unwrap();
    laptop.online(&mut relay);
    let device = laptop.core.this_device_id().unwrap().to_owned();
    drop(laptop);

    // The laptop app starts again (a different random seed: nothing may depend on luck).
    let mut laptop = Device::on("laptop-again", &clock, laptop_storage, laptop_secure);
    laptop.subscribed.clear();
    assert_eq!(laptop.core.this_device_id(), Some(device.as_str()));
    assert_eq!(
        laptop.core.sync_devices().len(),
        1,
        "it still knows the phone"
    );
    laptop
        .core
        .send_message(&fran, "after the restart", None)
        .unwrap();
    laptop.read = HashMap::new();
    laptop.online(&mut relay);

    phone.online(&mut relay);
    assert_eq!(phone.texts(), ["after the restart", "before the restart"]);
    assert_eq!(
        phone.core.sync_fingerprint(),
        laptop.core.sync_fingerprint()
    );
}

#[test]
fn history_from_before_sync_groups_and_read_marks_reach_a_restored_install() {
    let clock = FakeClock::at(1_700_000_000_000);
    let mut relay = Relay::default();
    let mut phone = Device::new("phone", &clock);
    let phrase = phone.core.create_identity().unwrap();
    let mut fran = Device::new("fran", &clock);
    fran.core.create_identity().unwrap();
    let fran_uid = fran.core.own_uid().unwrap().clone();
    let phone_card = phone.core.own_card(Some("Pat")).unwrap();
    let fran_card = fran.core.own_card(Some("Fran")).unwrap();
    phone
        .core
        .add_contact(&fran_card, ContactTrust::Verified)
        .unwrap();
    fran.core
        .add_contact(&phone_card, ContactTrust::Verified)
        .unwrap();

    // Fran writes while the phone is away; the relay keeps it (store and forward), the phone picks it up.
    fran.core.set_store_forward(true).unwrap();
    fran.core
        .send_message(phone.core.own_uid().unwrap(), "hello phone", None)
        .unwrap();
    fran.online(&mut relay);
    phone.online(&mut relay);
    assert_eq!(phone.texts(), ["hello phone"]);

    // The phone's history before any other device exists: a reply, a reaction, a group.
    phone.core.send_message(&fran_uid, "reply", None).unwrap();
    let hello = phone.message_id("hello phone");
    phone.core.react(&hello, "😂").unwrap();
    phone
        .core
        .create_group("Trip", std::slice::from_ref(&fran_uid))
        .unwrap();
    phone.online(&mut relay);

    // Much later a laptop is restored from the phrase and meets the phone through the relay.
    clock.advance(86_400_000);
    let mut laptop = Device::new("laptop", &clock);
    laptop.core.recover_identity(&phrase, "").unwrap();
    laptop.online(&mut relay);
    phone.online(&mut relay);
    laptop.online(&mut relay);

    let snap = laptop.core.snapshot();
    assert!(
        snap.contacts.iter().any(|c| c.uid == fran_uid),
        "the friend"
    );
    assert_eq!(laptop.texts(), ["hello phone", "reply"], "the messages");
    assert!(snap.groups.iter().any(|g| g.name == "Trip"), "the group");
    assert!(
        snap.reactions
            .iter()
            .any(|(id, r)| id == &hello && r.iter().any(|(_, e)| e == "😂")),
        "the reaction"
    );

    // Read on the laptop, read on the phone (and nothing new for Fran: the laptop already told her nothing twice).
    let unread = |d: &Device| {
        d.core
            .snapshot()
            .messages
            .into_iter()
            .flat_map(|(_, v)| v)
            .filter(|m| m.text == "hello phone" && m.read_at.is_none())
            .count()
    };
    assert_eq!(unread(&laptop), 1);
    laptop.core.mark_read(&fran_uid).unwrap();
    laptop.online(&mut relay);
    phone.online(&mut relay);
    assert_eq!(unread(&phone), 0, "read on the laptop, read on the phone");
    assert_eq!(
        phone.core.sync_fingerprint(),
        laptop.core.sync_fingerprint()
    );
}
