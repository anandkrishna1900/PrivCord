//! Timing baseline for the operations the PRD names (identity, encryption, decryption). Run in release mode:
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `cargo run --release -p privcord-crypto --features test-support --example bench`
//! Compare with `node docs/rust/tools/bench.mjs` (the TypeScript implementation, same operations, same machine).

use privcord_crypto::{
    identity::Identity,
    invite::derive_invite,
    rng::SeededEntropy,
    seal::{open, seal},
    secure_channel::SecureChannel,
};
use serde_json::json;
use std::time::Instant;

fn time<T>(label: &str, runs: u32, mut f: impl FnMut() -> T) {
    let _ = f();
    let start = Instant::now();
    for _ in 0..runs {
        std::hint::black_box(f());
    }
    let per = start.elapsed().as_secs_f64() * 1000.0 / f64::from(runs);
    println!("{label}: {per:.3} ms per op ({runs} runs)");
}

fn main() {
    let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    time(
        "identity from phrase (PBKDF2-512 x2048 + HKDF + 2 scalar mults)",
        20,
        || Identity::from_phrase(phrase, "").unwrap(),
    );
    let ann = Identity::from_phrase(phrase, "").unwrap();
    let bob = Identity::from_phrase(
        "legal winner thank year wave sausage worth useful legal winner thank yellow",
        "",
    )
    .unwrap();
    let (au, bu) = (ann.uid().unwrap(), bob.uid().unwrap());
    let payload = json!({ "t": "msg", "id": "m", "text": "hello hello hello hello hello hello hello hello", "at": 1_700_000_000_000_i64 });
    let mut rng = SeededEntropy::new("bench");
    time(
        "seal a message (ECDH + HKDF + AES-GCM + ECDSA sign)",
        200,
        || seal(&ann, &bu, &bob.dh_public(), &payload, &mut rng).unwrap(),
    );
    let blob = seal(&ann, &bu, &bob.dh_public(), &payload, &mut rng).unwrap();
    time(
        "open a message (verify + ECDH + HKDF + AES-GCM)",
        200,
        || open(&blob, &bu, &bob, &ann.sign_public(), &au).unwrap(),
    );
    let mut a = SecureChannel::new(au.as_str(), bu.as_str(), bob.sign_public(), &mut rng).unwrap();
    let mut b = SecureChannel::new(bu.as_str(), au.as_str(), ann.sign_public(), &mut rng).unwrap();
    let (ha, hb) = (a.hello(&ann).unwrap(), b.hello(&bob).unwrap());
    a.accept(&hb).unwrap();
    b.accept(&ha).unwrap();
    time("secure-channel frame encrypt + decrypt", 2000, || {
        let f = a.encrypt(&payload).unwrap();
        b.decrypt(&f).unwrap()
    });
    let words: Vec<String> = ["apple", "river", "tiger", "moon", "cloud", "seven"]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    time("derive invite (PBKDF2-256 x150000)", 5, || {
        derive_invite(&words).unwrap()
    });
}
