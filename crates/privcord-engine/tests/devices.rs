//! Every install has its own device keys and a device list signed by its identity (syncengine.md §2, step 2).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::{identity::Identity, rng::SeededEntropy};
use privcord_engine::{Core, Ports};
use privcord_ports::testing::{
    FakeClock, MemorySecureStore, MemoryStorage, RecordingNotifier, RecordingTransport,
};
use std::sync::Arc;

fn core(seed: &str, storage: &Arc<MemoryStorage>, secure: &Arc<MemorySecureStore>) -> Core {
    Core::new(Ports {
        storage: storage.clone(),
        secure: secure.clone(),
        transport: RecordingTransport::new(),
        clock: FakeClock::at(1_000),
        notifier: RecordingNotifier::new(),
        entropy: Box::new(SeededEntropy::new(seed)),
    })
    .unwrap()
}

#[test]
fn an_install_becomes_the_first_device_of_its_account_and_stays_it() {
    let (storage, secure) = (MemoryStorage::new(), MemorySecureStore::new());
    let mut a = core("a", &storage, &secure);
    assert!(a.this_device_id().is_none());
    let phrase = a.create_identity().unwrap();
    let account = Identity::from_phrase(&phrase, "").unwrap();

    let list = a.device_list().unwrap().clone();
    list.verify(&account.sign_public(), &account.dh_public())
        .unwrap();
    assert_eq!(list.account, a.own_uid().unwrap().to_string());
    assert_eq!(list.active().count(), 1);
    let id = a.this_device_id().unwrap().to_owned();
    assert!(list.get(&id).is_some());
    // The device is not the account: its id is not the uid.
    assert_ne!(id, list.account);

    // A restart keeps the same device and list.
    drop(a);
    let again = core("a2", &storage, &secure);
    assert_eq!(again.this_device_id(), Some(id.as_str()));
    assert_eq!(again.device_list(), Some(&list));
}

#[test]
fn restoring_the_same_account_on_another_install_makes_a_new_device() {
    let (s1, k1) = (MemoryStorage::new(), MemorySecureStore::new());
    let mut phone = core("phone", &s1, &k1);
    let phrase = phone.create_identity().unwrap();
    let (s2, k2) = (MemoryStorage::new(), MemorySecureStore::new());
    let mut laptop = core("laptop", &s2, &k2);
    laptop.recover_identity(&phrase, "").unwrap();
    assert_eq!(phone.own_uid(), laptop.own_uid());
    assert_ne!(phone.this_device_id(), laptop.this_device_id());
}
