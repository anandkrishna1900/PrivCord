//! The legacy handshake against a transcript the TypeScript implementation produced (`docs/peerauth-vectors.json`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::{
    identity::{verify_signature, Identity},
    peer_auth::{auth_challenge, AuthError, Expected, Hello, PeerAuth},
};
use privcord_domain::codec;
use serde_json::{json, Value};

fn vectors() -> Value {
    let root = env!("CARGO_MANIFEST_DIR");
    serde_json::from_str(
        &std::fs::read_to_string(format!("{root}/../../docs/peerauth-vectors.json")).unwrap(),
    )
    .unwrap()
}

fn expected(id: &Identity) -> Expected {
    Expected {
        uid: id.uid().unwrap().to_string(),
        sign: id.sign_public(),
        dh: id.dh_public(),
    }
}

struct Side {
    id: Identity,
    auth: PeerAuth,
}

fn side(v: &Value, who: &str, other: &str) -> Side {
    let id = Identity::from_phrase(v[who]["phrase"].as_str().unwrap(), "").unwrap();
    let peer = Identity::from_phrase(v[other]["phrase"].as_str().unwrap(), "").unwrap();
    let auth = PeerAuth::with_nonce(
        v["context"].as_str().unwrap(),
        id.uid().unwrap().as_str(),
        v[who]["deviceId"].as_str().unwrap(),
        expected(&peer),
        v[who]["nonce"].as_str().unwrap().to_owned(),
    );
    Side { id, auth }
}

#[test]
fn rust_completes_a_handshake_with_frames_the_typescript_side_made() {
    let v = vectors();
    let mut ann = side(&v, "ann", "bob");
    let f = &v["frames"];

    // Our hello has the same content as TypeScript's (same keys, uid, device, nonce, proof verifies).
    let ours = ann.auth.hello(&ann.id).unwrap();
    for k in [
        "v",
        "kind",
        "uid",
        "deviceId",
        "publicKeyJwk",
        "dhJwk",
        "nonce",
    ] {
        assert_eq!(ours[k], f["annHello"][k], "hello field {k}");
    }
    assert!(Hello::parse(&ours).is_some());

    // Bob's TypeScript hello: accepted, and we answer with an auth_proof.
    let out = ann.auth.on_frame(&ann.id, &f["bobHello"]).unwrap().unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["kind"], "auth_proof");
    // Our proof verifies against the very challenge TypeScript builds for us.
    let challenge = auth_challenge(
        "duo",
        v["ann"]["uid"].as_str().unwrap(),
        "device-ann",
        v["ann"]["nonce"].as_str().unwrap(),
        v["bob"]["nonce"].as_str().unwrap(),
    );
    assert_eq!(challenge, v["challenges"]["ann"].as_str().unwrap());
    assert!(verify_signature(
        &ann.id.sign_public(),
        &codec::decode(out[0]["signature"].as_str().unwrap()).unwrap(),
        challenge.as_bytes()
    ));

    // Bob's TypeScript proof verifies in Rust and is answered with auth_ok; his ok completes the handshake.
    assert!(!ann.auth.authenticated());
    let out = ann.auth.on_frame(&ann.id, &f["bobProof"]).unwrap().unwrap();
    assert_eq!(out, vec![f["annOk"].clone()]);
    assert!(
        !ann.auth.authenticated(),
        "not yet: the peer has not acknowledged us"
    );
    ann.auth.on_frame(&ann.id, &f["bobOk"]).unwrap();
    assert!(ann.auth.authenticated());
    assert_eq!(ann.auth.peer().unwrap().device_id, "device-bob");
}

#[test]
fn two_rust_sides_complete_a_handshake_in_either_order() {
    let v = vectors();
    let (mut a, mut b) = (side(&v, "ann", "bob"), side(&v, "bob", "ann"));
    let (ha, hb) = (a.auth.hello(&a.id).unwrap(), b.auth.hello(&b.id).unwrap());
    let pa = a.auth.on_frame(&a.id, &hb).unwrap().unwrap();
    let pb = b.auth.on_frame(&b.id, &ha).unwrap().unwrap();
    // Cross the proofs, then the acknowledgements.
    let oka = a.auth.on_frame(&a.id, &pb[0]).unwrap().unwrap();
    let okb = b.auth.on_frame(&b.id, &pa[0]).unwrap().unwrap();
    a.auth.on_frame(&a.id, &okb[0]).unwrap();
    b.auth.on_frame(&b.id, &oka[0]).unwrap();
    assert!(a.auth.authenticated() && b.auth.authenticated());
}

#[test]
fn every_way_to_cheat_is_refused() {
    let v = vectors();
    let f = &v["frames"];
    let phrases = |w: &str| v[w]["phrase"].as_str().unwrap().to_owned();
    let mut ann = side(&v, "ann", "bob");

    // Not the pinned contact: a stranger's hello, or the right uid with someone else's keys.
    let stranger = Identity::from_phrase(
        "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
        "",
    )
    .unwrap();
    let s = PeerAuth::with_nonce(
        "duo",
        stranger.uid().unwrap().as_str(),
        "d",
        expected(&stranger),
        "c3".repeat(24),
    );
    let evil_hello = s.hello(&stranger).unwrap();
    assert_eq!(
        ann.auth.on_frame(&ann.id, &evil_hello).unwrap_err(),
        AuthError::NotTheContact
    );
    let mut swapped = f["bobHello"].clone();
    swapped["publicKeyJwk"] = evil_hello["publicKeyJwk"].clone();
    assert_eq!(
        ann.auth.on_frame(&ann.id, &swapped).unwrap_err(),
        AuthError::NotTheContact
    );

    // A peer that claims to be us.
    let mut self_peer = PeerAuth::with_nonce(
        "duo",
        v["ann"]["uid"].as_str().unwrap(),
        "d",
        expected(&Identity::from_phrase(&phrases("ann"), "").unwrap()),
        "d4".repeat(24),
    );
    assert_eq!(
        self_peer.on_frame(&ann.id, &f["annHello"]).unwrap_err(),
        AuthError::OwnIdentity
    );

    // A hello whose identity proof does not match its keys.
    let mut forged = f["bobHello"].clone();
    forged["identityProof"] = f["annHello"]["identityProof"].clone();
    assert_eq!(
        ann.auth.on_frame(&ann.id, &forged).unwrap_err(),
        AuthError::BadIdentity
    );

    // Proof before hello, wrong signature, wrong uid, an acknowledgement from nobody.
    let mut fresh = side(&v, "ann", "bob");
    assert_eq!(
        fresh.auth.on_frame(&fresh.id, &f["bobProof"]).unwrap_err(),
        AuthError::OutOfOrder
    );
    assert_eq!(
        fresh.auth.on_frame(&fresh.id, &f["bobOk"]).unwrap_err(),
        AuthError::WrongAck
    );
    fresh.auth.on_frame(&fresh.id, &f["bobHello"]).unwrap();
    let mut bad_sig = f["bobProof"].clone();
    bad_sig["signature"] = f["annProof"]["signature"].clone();
    assert_eq!(
        fresh.auth.on_frame(&fresh.id, &bad_sig).unwrap_err(),
        AuthError::BadProof
    );
    let mut wrong_uid = f["bobProof"].clone();
    wrong_uid["uid"] = "someone".into();
    assert_eq!(
        fresh.auth.on_frame(&fresh.id, &wrong_uid).unwrap_err(),
        AuthError::OutOfOrder
    );
    assert_eq!(
        fresh
            .auth
            .on_frame(
                &fresh.id,
                &json!({ "v": 1, "kind": "auth_ok", "uid": "nobody" })
            )
            .unwrap_err(),
        AuthError::WrongAck
    );
    // A proof made for a different conversation context does not verify.
    let mut other_ctx = PeerAuth::with_nonce(
        "other-context",
        v["ann"]["uid"].as_str().unwrap(),
        "device-ann",
        expected(&Identity::from_phrase(&phrases("bob"), "").unwrap()),
        v["ann"]["nonce"].as_str().unwrap().to_owned(),
    );
    other_ctx.on_frame(&ann.id, &f["bobHello"]).unwrap();
    assert_eq!(
        other_ctx.on_frame(&ann.id, &f["bobProof"]).unwrap_err(),
        AuthError::BadProof
    );
    assert!(!fresh.auth.authenticated());
    // Frames that are not handshake frames are left for the caller; malformed hellos are ignored.
    assert!(fresh
        .auth
        .on_frame(&fresh.id, &json!({ "v": 1, "kind": "message" }))
        .unwrap()
        .is_none());
    for r in v["rejected"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["frame"]["kind"] == "hello")
    {
        assert!(Hello::parse(&r["frame"]).is_none(), "{}", r["label"]);
    }
}
