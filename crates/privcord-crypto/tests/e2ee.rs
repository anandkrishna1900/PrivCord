//! X3DH, the Double Ratchet, envelopes and group messages against what the TypeScript produced
//! (`docs/e2ee-vectors.json`, made by `packages/protocol/scripts/gen-e2ee-vectors.ts`), and on their own.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::{
    e2ee::{
        accept_initial_envelope, create_bundle, create_one_time_prekey, create_signed_prekey,
        decrypt_envelope, encrypt_to_envelope, envelope_digest, initiate_session, restore_session,
        serialize_session, validate_bundle, validate_envelope, x3dh::PrekeyIntro, DuoEnvelope,
        DuoSession, EcdhKeypair, GroupEncryptedMessage, GroupSessionManager, OneTimePrekey,
        PrekeyInventory, SignedPrekey, MAX_SKIP,
    },
    identity::Identity,
    rng::SeededEntropy,
    CryptoError,
};
use serde_json::Value;

fn vectors() -> Value {
    let root = env!("CARGO_MANIFEST_DIR");
    serde_json::from_str(
        &std::fs::read_to_string(format!("{root}/../../docs/e2ee-vectors.json")).unwrap(),
    )
    .unwrap()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

struct Inventory {
    signed: SignedPrekey,
    one_time: Option<OneTimePrekey>,
}
impl PrekeyInventory for Inventory {
    fn signed_prekey(&self, id: i64) -> Option<&SignedPrekey> {
        (self.signed.id == id).then_some(&self.signed)
    }
    fn one_time_prekey(&self, id: i64) -> Option<&OneTimePrekey> {
        self.one_time.as_ref().filter(|o| o.id == id)
    }
}

fn ts_inventory(v: &Value) -> Inventory {
    let s = &v["prekeys"]["signed"];
    let o = &v["prekeys"]["oneTime"];
    Inventory {
        signed: SignedPrekey {
            id: s["id"].as_i64().unwrap(),
            key: EcdhKeypair::from_value(&s["key"]).unwrap(),
            signature: s["signature"].as_str().unwrap().to_owned(),
            created_at: s["createdAt"].as_i64().unwrap(),
        },
        one_time: Some(OneTimePrekey {
            id: o["id"].as_i64().unwrap(),
            key: EcdhKeypair::from_value(&o["key"]).unwrap(),
        }),
    }
}

fn identity(v: &Value, who: &str) -> Identity {
    Identity::from_phrase(v[who]["phrase"].as_str().unwrap(), "").unwrap()
}

#[test]
fn bundle_validation_gives_the_typescript_verdicts_and_messages() {
    let v = vectors();
    for case in v["bundleCases"].as_array().unwrap() {
        let got = validate_bundle(&case["bundle"]);
        let want = &case["result"];
        let name = &case["name"];
        if want["ok"].as_bool().unwrap() {
            assert!(got.is_ok(), "{name}: {got:?}");
        } else {
            assert_eq!(got.unwrap_err(), want["error"].as_str().unwrap(), "{name}");
        }
    }
}

#[test]
fn the_responder_derives_the_secret_the_typescript_initiator_derived() {
    let v = vectors();
    let bob = identity(&v, "bob");
    let inv = ts_inventory(&v);
    let intro = PrekeyIntro::from_value(&v["x3dh"]["intro"]).unwrap();
    let x = privcord_crypto::e2ee::respond_x3dh(&bob, &intro, &inv.signed, inv.one_time.as_ref())
        .unwrap();
    assert_eq!(
        x.root_key.to_vec(),
        unhex(v["x3dh"]["rootKeyHex"].as_str().unwrap())
    );
    assert_eq!(
        x.associated_data.to_vec(),
        unhex(v["x3dh"]["associatedDataHex"].as_str().unwrap())
    );
    // And the TypeScript responder agrees with its own initiator, the associated data is the documented digest.
    assert_eq!(v["x3dh"]["rootKeyHex"], v["x3dh"]["responderRootKeyHex"]);
    let ann = identity(&v, "alice");
    assert_eq!(
        privcord_crypto::e2ee::associated_data_for(&ann.dh_public(), &bob.dh_public()).to_vec(),
        unhex(v["x3dh"]["adDirect"].as_str().unwrap())
    );
    // A wrong prekey id is refused.
    let mut wrong = intro.clone();
    wrong.signed_prekey_id += 1;
    assert!(privcord_crypto::e2ee::respond_x3dh(&bob, &wrong, &inv.signed, None).is_err());
}

fn envelope(v: &Value) -> DuoEnvelope {
    validate_envelope(v).expect("a valid envelope")
}

fn run(session: &mut DuoSession, deliveries: &[Value], rng: &mut SeededEntropy) {
    for d in deliveries {
        let env = envelope(&d["envelope"]);
        let got = decrypt_envelope(session, &env, rng);
        match d["expect"].as_str() {
            Some(text) => assert_eq!(
                String::from_utf8(got.unwrap()).unwrap(),
                text,
                "{}",
                d["note"]
            ),
            None => assert!(got.is_err(), "{}", d["note"]),
        }
    }
}

#[test]
fn typescript_made_conversations_are_read_by_rust_in_every_scenario() {
    let v = vectors();
    let mut rng = SeededEntropy::new("e2ee-test");
    for sc in v["scenarios"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        let mut session = match sc["start"].as_str().unwrap() {
            "accept" => {
                let bob = identity(&v, "bob");
                let first = envelope(&sc["first"]);
                let accepted =
                    accept_initial_envelope(&bob, &ts_inventory(&v), &first, &mut rng).unwrap();
                assert_eq!(
                    String::from_utf8(accepted.payload.clone()).unwrap(),
                    sc["firstExpect"].as_str().unwrap(),
                    "{name}"
                );
                assert_eq!(accepted.consumed_signed_prekey_id, 7);
                assert_eq!(accepted.consumed_one_time_prekey_id, Some(101));
                accepted.session
            }
            _ => restore_session(&sc["snapshot"]).unwrap(),
        };
        run(&mut session, sc["deliveries"].as_array().unwrap(), &mut rng);
    }
}

#[test]
fn envelope_shapes_and_digests_match_typescript() {
    let v = vectors();
    for case in v["envelopeCases"].as_array().unwrap() {
        assert_eq!(
            validate_envelope(&case["envelope"]).is_some(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
    let first = envelope(&v["scenarios"][0]["first"]);
    let d = envelope_digest(
        &first.ctx,
        &first.header,
        &first.body,
        first.prekey.as_ref(),
    )
    .unwrap();
    assert_eq!(d, v["digests"]["firstExpect"].as_str().unwrap());
    assert_eq!(d, first.id);
    let other =
        envelope_digest("other", &first.header, &first.body, first.prekey.as_ref()).unwrap();
    assert_eq!(other, v["digests"]["other"].as_str().unwrap());
    // Our own envelope round-trips through its JSON.
    assert_eq!(validate_envelope(&first.to_value()).unwrap(), first);
}

#[test]
fn group_messages_match_typescript_and_refuse_tampering() {
    let v = vectors();
    let g = &v["group"];
    let key: [u8; 32] = unhex(g["epochKeyHex"].as_str().unwrap())
        .try_into()
        .unwrap();
    let mut m = GroupSessionManager::new();
    m.set_group("g-1", 3);
    m.set_epoch_key("g-1", 3, key);
    let msg = GroupEncryptedMessage::from_value(&g["message"]).unwrap();
    assert_eq!(m.decrypt(&msg).unwrap(), g["payload"]);
    let mut bad = msg.clone();
    bad.seq += 1;
    assert!(m.decrypt(&bad).is_err(), "sequence number is authenticated");
    let mut bad = msg.clone();
    bad.sender_uid = "someone-else".into();
    assert!(m.decrypt(&bad).is_err(), "sender is authenticated");
    let mut bad = msg;
    bad.epoch = 4;
    assert!(m.decrypt(&bad).is_err(), "unknown epoch has no key");
    // Our own encrypt is read by us, and an old epoch stays readable after a new one starts.
    let mut rng = SeededEntropy::new("group");
    let out = m
        .encrypt(
            "g-1",
            "uid-ann",
            1,
            &serde_json::json!({ "t": "hi" }),
            &mut rng,
        )
        .unwrap();
    assert_eq!(m.decrypt(&out).unwrap(), serde_json::json!({ "t": "hi" }));
    m.set_group("g-1", 4);
    assert!(
        m.encrypt("g-1", "uid-ann", 2, &serde_json::json!(1), &mut rng)
            .is_err(),
        "no key for the new epoch yet"
    );
    m.set_epoch_key(
        "g-1",
        4,
        GroupSessionManager::generate_epoch_secret(&mut rng).unwrap(),
    );
    let newer = m
        .encrypt("g-1", "uid-ann", 2, &serde_json::json!(1), &mut rng)
        .unwrap();
    assert_eq!(newer.epoch, 4);
    assert_eq!(m.decrypt(&out).unwrap(), serde_json::json!({ "t": "hi" }));
}

struct Peer {
    identity: Identity,
    inventory: Inventory,
}

fn peer(seed: &str, with_otk: bool) -> (Peer, Value) {
    let mut rng = SeededEntropy::new(seed);
    let identity = Identity::generate(&mut rng).unwrap();
    let signed = create_signed_prekey(&identity, 1, 1_700_000_000_000, &mut rng).unwrap();
    let one_time = with_otk.then(|| create_one_time_prekey(101, &mut rng).unwrap());
    let bundle = create_bundle(&identity, &signed, one_time.as_ref())
        .unwrap()
        .to_value();
    (
        Peer {
            identity,
            inventory: Inventory { signed, one_time },
        },
        bundle,
    )
}

fn session_pair(rng: &mut SeededEntropy, with_otk: bool) -> (DuoSession, DuoSession, Peer) {
    let alice = Identity::generate(rng).unwrap();
    let (bob, bundle) = peer("bob-peer", with_otk);
    let bundle = validate_bundle(&bundle).unwrap();
    let start = initiate_session(&alice, &bundle, "msg-0", b"intro", rng).unwrap();
    let accepted =
        accept_initial_envelope(&bob.identity, &bob.inventory, &start.envelope, rng).unwrap();
    assert_eq!(accepted.payload, b"intro");
    (start.session, accepted.session, bob)
}

#[test]
fn a_rust_conversation_works_both_ways_survives_a_restart_and_is_bound_to_its_context() {
    let mut rng = SeededEntropy::new("rust-conversation");
    for with_otk in [true, false] {
        let (mut a, mut b, _) = session_pair(&mut rng, with_otk);
        let m1 = encrypt_to_envelope(&mut a, "m-1", b"to bob", &mut rng).unwrap();
        assert_eq!(decrypt_envelope(&mut b, &m1, &mut rng).unwrap(), b"to bob");
        let r1 = encrypt_to_envelope(&mut b, "m-2", b"to alice", &mut rng).unwrap();
        assert_eq!(
            decrypt_envelope(&mut a, &r1, &mut rng).unwrap(),
            b"to alice"
        );
        // Restart both from their snapshots (through real JSON text) and carry on.
        let snap = |s: &DuoSession| {
            serde_json::from_str::<Value>(&serialize_session(s).to_string()).unwrap()
        };
        let (mut a, mut b) = (
            restore_session(&snap(&a)).unwrap(),
            restore_session(&snap(&b)).unwrap(),
        );
        let m2 = encrypt_to_envelope(&mut a, "m-3", b"after restart", &mut rng).unwrap();
        assert_eq!(
            decrypt_envelope(&mut b, &m2, &mut rng).unwrap(),
            b"after restart"
        );
        // Rewriting the context fails; so does a replay; and the session is still healthy afterwards.
        let m3 = encrypt_to_envelope(&mut a, "m-4", b"secret", &mut rng).unwrap();
        let mut rewritten = m3.clone();
        rewritten.ctx = "m-XXXX".into();
        assert!(decrypt_envelope(&mut b, &rewritten, &mut rng).is_err());
        assert_eq!(decrypt_envelope(&mut b, &m3, &mut rng).unwrap(), b"secret");
        assert!(
            decrypt_envelope(&mut b, &m3, &mut rng).is_err(),
            "a replay fails"
        );
        let m4 = encrypt_to_envelope(&mut a, "m-5", b"still alive", &mut rng).unwrap();
        assert_eq!(
            decrypt_envelope(&mut b, &m4, &mut rng).unwrap(),
            b"still alive"
        );
    }
}

#[test]
fn a_refused_message_changes_nothing_so_the_real_one_still_arrives() {
    let mut rng = SeededEntropy::new("atomic");
    let (mut a, mut b, _) = session_pair(&mut rng, true);
    // Alice and Bob exchange so the next message from Alice starts a new chain (needs a DH ratchet at Bob).
    let r = encrypt_to_envelope(&mut b, "r", b"hello", &mut rng).unwrap();
    decrypt_envelope(&mut a, &r, &mut rng).unwrap();
    let next = encrypt_to_envelope(&mut a, "n", b"new chain", &mut rng).unwrap();
    let before = serialize_session(&b).to_string();
    let mut flipped = next.clone();
    let i = flipped.body.len() - 2;
    flipped.body.replace_range(
        i..=i,
        if &flipped.body[i..=i] == "A" {
            "B"
        } else {
            "A"
        },
    );
    assert!(decrypt_envelope(&mut b, &flipped, &mut rng).is_err());
    assert_eq!(
        serialize_session(&b).to_string(),
        before,
        "the failed attempt left no trace"
    );
    assert_eq!(
        decrypt_envelope(&mut b, &next, &mut rng).unwrap(),
        b"new chain"
    );
}

#[test]
fn the_skip_window_holds_a_thousand_and_refuses_more() {
    let mut rng = SeededEntropy::new("skip");
    let (mut a, mut b, _) = session_pair(&mut rng, false);
    let envs: Vec<_> = (1..=MAX_SKIP + 2)
        .map(|i| {
            encrypt_to_envelope(
                &mut a,
                &format!("m-{i}"),
                format!("p{i}").as_bytes(),
                &mut rng,
            )
            .unwrap()
        })
        .collect();
    // Position MAX_SKIP + 1 is outside the window.
    assert!(decrypt_envelope(&mut b, &envs[MAX_SKIP as usize + 1], &mut rng).is_err());
    // The last one inside the window skips exactly MAX_SKIP and the earliest still decrypts afterwards.
    assert_eq!(
        decrypt_envelope(&mut b, &envs[MAX_SKIP as usize - 1], &mut rng).unwrap(),
        format!("p{MAX_SKIP}").as_bytes()
    );
    assert_eq!(decrypt_envelope(&mut b, &envs[0], &mut rng).unwrap(), b"p1");
}

#[test]
fn consumed_prekeys_bad_proofs_and_foreign_envelopes_are_refused() {
    let mut rng = SeededEntropy::new("refusals");
    let alice = Identity::generate(&mut rng).unwrap();
    let (mut bob, bundle) = peer("bob-refusals", true);
    let bundle = validate_bundle(&bundle).unwrap();
    let start = initiate_session(&alice, &bundle, "m", b"first", &mut rng).unwrap();
    accept_initial_envelope(&bob.identity, &bob.inventory, &start.envelope, &mut rng).unwrap();
    // The host removes the consumed prekeys; the same intro cannot start a second session.
    bob.inventory.signed.id = 99;
    assert!(
        accept_initial_envelope(&bob.identity, &bob.inventory, &start.envelope, &mut rng).is_err()
    );
    // A follow-up envelope is not a session start, and a session start is not a follow-up.
    let (mut a, mut b, bobp) = session_pair(&mut rng, true);
    let follow = encrypt_to_envelope(&mut a, "x", b"y", &mut rng).unwrap();
    assert!(accept_initial_envelope(&bobp.identity, &bobp.inventory, &follow, &mut rng).is_err());
    assert!(decrypt_envelope(&mut b, &start.envelope, &mut rng).is_err());
    // An intro whose identity proof is someone else's is refused.
    let mut forged = start.envelope.clone();
    let stranger = Identity::generate(&mut rng).unwrap();
    forged.prekey.as_mut().unwrap().sender_sign = stranger.sign_public();
    let (bob2, _) = peer("bob-refusals", true);
    assert!(accept_initial_envelope(&bob2.identity, &bob2.inventory, &forged, &mut rng).is_err());
    // A tampered bundle is rejected at initiation, whatever the caller checked.
    let mut tampered = bundle.clone();
    tampered.signed_prekey_dh.y.push('A');
    assert!(initiate_session(&alice, &tampered, "m", b"x", &mut rng).is_err());
    let _: CryptoError = CryptoError::Invalid;
}
