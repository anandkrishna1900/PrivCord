//! The real engine, fed what a stranger can send without being a contact: sealed blobs on our mailbox (from a relay),
//! Bluetooth mesh frames, and frames on a link that has not authenticated yet. It must neither panic nor accept them.
#![no_main]
use libfuzzer_sys::fuzz_target;
use privcord_crypto::rng::SeededEntropy;
use privcord_domain::{state::ConnectionPath, UserId};
use privcord_engine::{Core, Ports};
use privcord_ports::testing::{
    FakeClock, MemorySecureStore, MemoryStorage, RecordingNotifier, RecordingTransport,
};
use std::cell::RefCell;

thread_local! {
    // One engine for the whole run (making an identity is slow); state carried between inputs only adds coverage.
    static ENGINE: RefCell<(Core, String)> = RefCell::new({
        let mut core = Core::new(Ports {
            storage: MemoryStorage::new(),
            secure: MemorySecureStore::new(),
            transport: RecordingTransport::new(),
            clock: FakeClock::at(1_700_000_000_000),
            notifier: RecordingNotifier::new(),
            entropy: Box::new(SeededEntropy::new("fuzz")),
        })
        .expect("engine");
        core.create_identity().expect("identity");
        let mailbox = privcord_crypto::seal::mailbox_for(core.own_uid().expect("uid").as_str());
        (core, mailbox)
    });
}

fuzz_target!(|data: &[u8]| {
    let Some((&op, rest)) = data.split_first() else {
        return;
    };
    let text = String::from_utf8_lossy(rest);
    ENGINE.with(|cell| {
        let (core, mailbox) = &mut *cell.borrow_mut();
        let contacts = core.snapshot().contacts.len();
        match op % 4 {
            0 => core.signal_blob(mailbox, &text),
            1 => {
                let _ = core.mesh_link_up("fuzz-link");
                core.mesh_frame("fuzz-link", &text);
            }
            2 => {
                let stranger = UserId::new("f".repeat(64)).expect("uid");
                let _ = core.link_up(&stranger, ConnectionPath::DirectLan);
                core.frame_received(&stranger, &text);
            }
            _ => {
                // A blob wrapped the way relays deliver it, so the decoder gets past the envelope more often.
                core.signal_blob(mailbox, &format!("{{\"v\":1,{text}}}"));
            }
        }
        // Nothing a stranger sends may make them a contact.
        assert_eq!(
            core.snapshot().contacts.len(),
            contacts,
            "a stranger became a contact"
        );
    });
});
