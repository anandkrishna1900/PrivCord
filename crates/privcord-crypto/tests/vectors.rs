//! Differential tests: the Rust cryptography must reproduce what the TypeScript implementation produced
//! (`docs/android-vectors.json`, `docs/file-vectors.json`) and accept what it signed and sealed.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::{
    backup::{open_backup, seal_backup, BACKUP_PREFIX},
    canonical::canonical_json,
    card::ContactCard,
    channel::{derive_channel, open_channel_message, seal_channel_message},
    identity::{
        derive_key_material, derive_seed, generate_recovery_phrase, validate_recovery_phrase,
        verify_identity_proof, Identity, Purpose,
    },
    invite::{
        derive_invite, new_invite_words, open_invite, parse_invite_words, seal_invite, InviteKind,
    },
    rng::{Entropy, SeededEntropy},
    safety::derive_safety_number,
    seal::{mailbox_for, open, open_from_stranger, seal, signed_part, verify_blob_signature},
    CryptoError,
};
use privcord_domain::{blob::SealedBlob, codec};
use serde_json::{json, Value};

fn load(name: &str) -> Value {
    let root = env!("CARGO_MANIFEST_DIR");
    serde_json::from_str(&std::fs::read_to_string(format!("{root}/../../docs/{name}")).unwrap())
        .unwrap()
}

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
        .collect()
}

struct Fixed(Vec<u8>, usize);
impl Entropy for Fixed {
    fn fill(&mut self, dest: &mut [u8]) -> Result<(), CryptoError> {
        for b in dest {
            *b = self.0[self.1 % self.0.len()];
            self.1 += 1;
        }
        Ok(())
    }
}

#[test]
fn recovery_derivation_matches_typescript_for_every_vector() {
    let v = load("android-vectors.json");
    for r in v["recovery"].as_array().unwrap() {
        let (phrase, pass) = (
            r["phrase"].as_str().unwrap(),
            r["passphrase"].as_str().unwrap(),
        );
        let seed = derive_seed(phrase, pass).unwrap();
        assert_eq!(
            codec::hex(&*seed),
            r["seedHex"].as_str().unwrap(),
            "{phrase}"
        );
        assert_eq!(
            codec::hex(&*derive_key_material(&*seed, Purpose::IdentitySign).unwrap()),
            r["signMaterialHex"].as_str().unwrap()
        );
        assert_eq!(
            codec::hex(&*derive_key_material(&*seed, Purpose::IdentityAgreement).unwrap()),
            r["agreementMaterialHex"].as_str().unwrap()
        );

        let id = Identity::from_phrase(phrase, pass).unwrap();
        let (sign_pub, dh_pub) = (id.sign_public(), id.dh_public());
        assert_eq!(
            (sign_pub.x.as_str(), sign_pub.y.as_str()),
            (
                r["signPub"]["x"].as_str().unwrap(),
                r["signPub"]["y"].as_str().unwrap()
            )
        );
        assert_eq!(
            (dh_pub.x.as_str(), dh_pub.y.as_str()),
            (
                r["dhPub"]["x"].as_str().unwrap(),
                r["dhPub"]["y"].as_str().unwrap()
            )
        );
        let secrets = id.export_for_storage();
        assert_eq!(
            codec::encode(&secrets.sign),
            r["signPriv"]["d"].as_str().unwrap()
        );
        assert_eq!(
            codec::encode(&secrets.dh),
            r["dhPriv"]["d"].as_str().unwrap()
        );
        assert_eq!(id.uid().unwrap().as_str(), r["uid"].as_str().unwrap());
        assert_eq!(
            id.recovery_fingerprint(),
            r["recoveryFingerprint"].as_str().unwrap()
        );

        // The TypeScript proof verifies in Rust, and ours verifies against the same rule.
        assert!(verify_identity_proof(
            &sign_pub,
            &dh_pub,
            r["identityProof"].as_str().unwrap()
        ));
        assert!(verify_identity_proof(
            &sign_pub,
            &dh_pub,
            &id.identity_proof().unwrap()
        ));
        let other = Identity::generate(&mut SeededEntropy::new("other")).unwrap();
        assert!(!verify_identity_proof(
            &other.sign_public(),
            &dh_pub,
            r["identityProof"].as_str().unwrap()
        ));
    }
}

#[test]
fn phrase_generation_and_validation_match_typescript() {
    let v = load("android-vectors.json");
    for e in v["entropy"].as_array().unwrap() {
        let phrase =
            generate_recovery_phrase(&mut Fixed(hex_decode(e["entropyHex"].as_str().unwrap()), 0))
                .unwrap();
        assert_eq!(phrase.as_str(), e["mnemonic"].as_str().unwrap());
        assert!(validate_recovery_phrase(&phrase).is_ok());
    }
    for p in v["invalidPhrases"].as_array().unwrap() {
        assert_eq!(
            validate_recovery_phrase(p["phrase"].as_str().unwrap()).is_ok(),
            p["valid"].as_bool().unwrap()
        );
    }
    // Spacing rules agree with TypeScript: extra internal spaces are refused, surrounding space and case are not.
    let good = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    assert!(validate_recovery_phrase(&format!("  {}  ", good.to_uppercase())).is_ok());
    assert!(validate_recovery_phrase(&good.replacen(' ', "  ", 1)).is_err());
    assert!(validate_recovery_phrase("").is_err());
}

#[test]
fn contact_cards_match_typescript() {
    let v = load("android-vectors.json");
    for who in ["ann", "bob"] {
        let text = v["cards"][who]["encoded"].as_str().unwrap();
        let contact = ContactCard::decode(text).expect("TypeScript card decodes");
        assert_eq!(
            contact.uid.as_str(),
            v["cards"][who]["uid"].as_str().unwrap()
        );
        // Re-encoding gives the very same bytes: this pins canonical JSON, key order and the base64url form.
        assert_eq!(contact.card.encode().unwrap(), text);
    }
    assert_eq!(
        ContactCard::decode(v["cards"]["ann"]["encoded"].as_str().unwrap())
            .unwrap()
            .card
            .name
            .as_deref(),
        Some("Ann ✓")
    );
    // A card whose ECDH key was swapped for someone else's must not validate.
    assert!(ContactCard::decode(v["cards"]["forged"].as_str().unwrap()).is_none());
    assert!(ContactCard::decode("DUOID1:!!!").is_none());
    assert!(ContactCard::decode("nonsense").is_none());
}

fn people() -> (Identity, Identity, Identity) {
    let v = load("android-vectors.json");
    let r = v["recovery"].as_array().unwrap();
    let get = |i: usize| {
        Identity::from_phrase(
            r[i]["phrase"].as_str().unwrap(),
            r[i]["passphrase"].as_str().unwrap(),
        )
        .unwrap()
    };
    (get(0), get(2), get(3))
}

#[test]
fn uids_and_safety_number_match_typescript() {
    let v = load("android-vectors.json");
    let (ann, bob, cat) = people();
    assert_eq!(
        ann.uid().unwrap().as_str(),
        v["uids"]["ann"].as_str().unwrap()
    );
    assert_eq!(
        bob.uid().unwrap().as_str(),
        v["uids"]["bob"].as_str().unwrap()
    );
    assert_eq!(
        cat.uid().unwrap().as_str(),
        v["uids"]["cat"].as_str().unwrap()
    );
    let ab = derive_safety_number(&ann.sign_public(), &bob.sign_public()).unwrap();
    assert_eq!(ab, v["safety"]["ann_bob"].as_str().unwrap());
    assert_eq!(
        ab,
        derive_safety_number(&bob.sign_public(), &ann.sign_public()).unwrap(),
        "order must not matter"
    );
    let mut bad = ann.sign_public();
    bad.x = "short".into();
    assert!(derive_safety_number(&bad, &bob.sign_public()).is_err());
}

#[test]
fn sealed_blobs_from_typescript_open_in_rust_and_tampering_is_refused() {
    let v = load("android-vectors.json");
    let (ann, bob, _) = people();
    let (ann_uid, bob_uid) = (ann.uid().unwrap(), bob.uid().unwrap());
    for s in v["sealed"].as_array().unwrap() {
        let blob = SealedBlob::decode(s["wire"].as_str().unwrap()).expect("wire decodes");
        let (me, them, my_uid, their_uid) = if s["toUid"] == bob_uid.as_str() {
            (&bob, &ann, &bob_uid, &ann_uid)
        } else {
            (&ann, &bob, &ann_uid, &bob_uid)
        };
        let payload = open(&blob, my_uid, me, &them.sign_public(), their_uid).expect("opens");
        assert_eq!(payload, s["payload"], "{}", s["label"]);
        assert_eq!(mailbox_for(my_uid.as_str()), s["mailbox"].as_str().unwrap());
        // Re-encoding keeps the same bytes.
        assert_eq!(blob.encode(), s["wire"].as_str().unwrap());
        // Wrong recipient, wrong claimed sender, wrong key: all refused.
        assert!(open(&blob, their_uid, them, &me.sign_public(), my_uid).is_none());
        assert!(open(&blob, my_uid, me, &me.sign_public(), their_uid).is_none());
    }
    let flipped = SealedBlob::decode(v["flippedWire"].as_str().unwrap());
    if let Some(b) = flipped {
        assert!(open(&b, &bob_uid, &bob, &ann.sign_public(), &ann_uid).is_none());
    }
}

#[test]
fn a_rust_sealed_blob_round_trips_and_resists_every_kind_of_tampering() {
    let (ann, bob, _) = people();
    let (ann_uid, bob_uid) = (ann.uid().unwrap(), bob.uid().unwrap());
    let mut rng = SeededEntropy::new("seal");
    let payload =
        json!({ "t": "msg", "id": "m-1", "text": "héllo ✓ 😀", "at": 1_700_000_000_000_i64 });
    let blob = seal(&ann, &bob_uid, &bob.dh_public(), &payload, &mut rng).unwrap();
    assert_eq!(
        open(&blob, &bob_uid, &bob, &ann.sign_public(), &ann_uid),
        Some(payload)
    );
    assert!(verify_blob_signature(&blob, &ann.sign_public()));

    let mutate = |f: &dyn Fn(&mut SealedBlob)| {
        let mut b = blob.clone();
        f(&mut b);
        assert!(open(&b, &bob_uid, &bob, &ann.sign_public(), &ann_uid).is_none());
    };
    mutate(&|b| b.ct = flip(&b.ct));
    mutate(&|b| b.iv = flip(&b.iv));
    mutate(&|b| b.sig = flip(&b.sig));
    mutate(&|b| b.to = "someone-else".into());
    mutate(&|b| b.from = "someone-else".into());
    mutate(&|b| b.epk.x = flip(&b.epk.x));
    // A large payload is refused instead of producing a blob relays would drop.
    let huge = json!({ "pad": "x".repeat(70_000) });
    assert_eq!(
        seal(&ann, &bob_uid, &bob.dh_public(), &huge, &mut rng).unwrap_err(),
        CryptoError::TooLarge
    );
    // The signature covers the canonical JSON; a different byte changes it.
    assert_ne!(
        signed_part(&blob).unwrap(),
        signed_part(&SealedBlob {
            ct: "x".into(),
            ..blob.clone()
        })
        .unwrap()
    );
}

fn flip(s: &str) -> String {
    let mut b = codec::decode(s).unwrap_or_default();
    if let Some(first) = b.first_mut() {
        *first ^= 1;
    } else {
        b.push(1);
    }
    codec::encode(&b)
}

#[test]
fn canonical_json_matches_typescript() {
    let v = load("android-vectors.json");
    for c in v["canonical"].as_array().unwrap() {
        let input = c["json"].as_str().unwrap();
        match serde_json::from_str::<Value>(input) {
            Ok(parsed) => assert_eq!(
                canonical_json(&parsed).unwrap(),
                c["expected"].as_str().unwrap(),
                "{input}"
            ),
            // A lone surrogate cannot be held in a Rust string. TypeScript accepts it; Rust refuses it at parse time
            // (documented in docs/rust/COMPATIBILITY.md).
            Err(_) => assert!(
                input.contains("\\ud800"),
                "only the lone-surrogate vector may fail to parse: {input}"
            ),
        }
    }
    // A fractional number is refused rather than formatted differently from JavaScript.
    assert!(canonical_json(&json!({ "a": 1.5 })).is_err());
}

#[test]
fn channel_derivation_and_messages_match_typescript() {
    let f = load("file-vectors.json");
    let ch = &f["channel"];
    let keys = derive_channel(ch["name"].as_str().unwrap()).unwrap();
    assert_eq!(keys.mailbox, ch["mailbox"].as_str().unwrap());
    assert_eq!(keys.tag, ch["tag"].as_str().unwrap());
    let msg = open_channel_message(&keys, &ch["blob"]).expect("TypeScript channel message opens");
    assert_eq!(msg.text, ch["text"].as_str().unwrap());
    assert_eq!(msg.at, ch["at"].as_i64().unwrap());
    assert_eq!(msg.contact.uid.as_str(), ch["uid"].as_str().unwrap());
    // Another room's keys cannot open it, and a forged sender is refused.
    assert!(open_channel_message(&derive_channel("other").unwrap(), &ch["blob"]).is_none());
    let mut tampered = ch["blob"].clone();
    tampered["from"] = "0".repeat(64).into();
    assert!(open_channel_message(&keys, &tampered).is_none());

    // And Rust-made messages open in Rust, with the name carried.
    let (ann, _, _) = people();
    let blob = seal_channel_message(
        &keys,
        &ann,
        Some("Ann"),
        "  hi all  ",
        1_700_000_000_123,
        &mut SeededEntropy::new("ch"),
    )
    .unwrap();
    let opened = open_channel_message(&keys, &serde_json::to_value(&blob).unwrap()).unwrap();
    assert_eq!(
        (opened.text.as_str(), opened.contact.card.name.as_deref()),
        ("hi all", Some("Ann"))
    );
    assert!(
        seal_channel_message(&keys, &ann, None, "   ", 1, &mut SeededEntropy::new("x")).is_err()
    );
}

#[test]
fn invites_match_typescript() {
    let f = load("file-vectors.json");
    let inv = &f["invite"];
    let words: Vec<String> = inv["words"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap().to_owned())
        .collect();
    let rv = derive_invite(&words).unwrap();
    assert_eq!(rv.mailbox, inv["mailbox"].as_str().unwrap());
    let m = open_invite(&rv, &inv["blob"]).expect("TypeScript invite opens");
    assert_eq!(m.contact.uid.as_str(), inv["uid"].as_str().unwrap());
    assert_eq!(
        m.contact.card.name.as_deref(),
        Some(inv["name"].as_str().unwrap())
    );

    // Wrong words give a different mailbox and cannot open it.
    let mut wrong = words.clone();
    wrong[0] = "zebra".into();
    let other = derive_invite(&wrong).unwrap();
    assert_ne!(other.mailbox, rv.mailbox);
    assert!(open_invite(&other, &inv["blob"]).is_none());

    // Rust-made invites open, for both directions of the exchange.
    let (ann, bob, _) = people();
    let card = seal_invite(
        &rv,
        InviteKind::Card,
        &ann,
        Some("Ann"),
        &mut SeededEntropy::new("i1"),
    )
    .unwrap();
    let reply = seal_invite(
        &rv,
        InviteKind::Reply,
        &bob,
        None,
        &mut SeededEntropy::new("i2"),
    )
    .unwrap();
    assert_eq!(
        open_invite(&rv, &serde_json::to_value(&card).unwrap())
            .unwrap()
            .kind,
        InviteKind::Card
    );
    let r = open_invite(&rv, &serde_json::to_value(&reply).unwrap()).unwrap();
    assert_eq!(
        (r.kind, r.contact.uid),
        (InviteKind::Reply, bob.uid().unwrap())
    );
    // A blob claiming to be from someone else is refused.
    let mut forged = serde_json::to_value(&card).unwrap();
    forged["from"] = bob.uid().unwrap().to_string().into();
    assert!(open_invite(&rv, &forged).is_none());
}

#[test]
fn invite_words_parse_and_generate_like_typescript() {
    assert_eq!(
        parse_invite_words("Apple, river  tiger-moon cloud\nseven")
            .unwrap()
            .len(),
        6
    );
    assert!(parse_invite_words("apple river tiger moon cloud").is_none());
    assert!(parse_invite_words("apple river tiger moon cloud notaword").is_none());
    let words = new_invite_words(&mut SeededEntropy::new("w")).unwrap();
    assert_eq!(words.len(), 6);
    assert_eq!(parse_invite_words(&words.join(" ")).unwrap(), words);
    // 11 bits per word: two zero bytes give the first word of the list.
    assert_eq!(
        new_invite_words(&mut Fixed(vec![0], 0)).unwrap(),
        vec!["abandon"; 6]
    );
}

#[test]
fn backups_match_typescript() {
    let f = load("file-vectors.json");
    let b = &f["backup"];
    let text = b["text"].as_str().unwrap();
    assert!(text.starts_with(BACKUP_PREFIX));
    assert_eq!(
        open_backup(text, b["passphrase"].as_str().unwrap()).unwrap(),
        b["data"]
    );
    assert!(open_backup(text, "wrong passphrase").is_none());
    assert!(open_backup(&format!("{text}A"), b["passphrase"].as_str().unwrap()).is_none());

    let data = json!({ "v": 1, "uid": "u", "messages": ["héllo"] });
    let sealed = seal_backup(&data, "correct horse battery", &mut SeededEntropy::new("b")).unwrap();
    assert_eq!(
        open_backup(&sealed, "correct horse battery"),
        Some(data.clone())
    );
    // Passphrases are NFKC-normalised, so a composed and a decomposed accent are the same passphrase.
    let s2 = seal_backup(
        &data,
        "pa\u{0301}ssword long",
        &mut SeededEntropy::new("b2"),
    )
    .unwrap();
    assert_eq!(open_backup(&s2, "p\u{00e1}ssword long"), Some(data.clone()));
    assert_eq!(
        seal_backup(&data, "short", &mut SeededEntropy::new("b3")).unwrap_err(),
        CryptoError::WeakPassphrase(8)
    );
}

#[test]
fn the_rust_made_vector_file_is_reproducible() {
    let root = env!("CARGO_MANIFEST_DIR");
    let committed: Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{root}/../../docs/rust-vectors.json")).unwrap(),
    )
    .unwrap();
    assert!(
        privcord_crypto::vectors::build().unwrap() == committed,
        "docs/rust-vectors.json is stale: regenerate it with the gen_vectors example"
    );
}

#[test]
fn secure_channel_matches_typescript_byte_for_byte() {
    use privcord_crypto::secure_channel::{ChannelError, Data, Hello, SecureChannel};
    let v = load("android-vectors.json");
    let sc = &v["secureChannel"];
    let (ann, bob, cat) = people();
    let (ann_uid, bob_uid) = (ann.uid().unwrap(), bob.uid().unwrap());
    let scalar = |who: &str| -> [u8; 32] {
        codec::decode(sc[who]["ephPriv"]["d"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap()
    };
    let mut a = SecureChannel::with_fixed(
        ann_uid.as_str(),
        bob_uid.as_str(),
        bob.sign_public(),
        &scalar("ann"),
        sc["ann"]["nonce"].as_str().unwrap(),
    )
    .unwrap();
    let mut b = SecureChannel::with_fixed(
        bob_uid.as_str(),
        ann_uid.as_str(),
        ann.sign_public(),
        &scalar("bob"),
        sc["bob"]["nonce"].as_str().unwrap(),
    )
    .unwrap();

    // Hellos from TypeScript are accepted; ours carry the same key and nonce and are accepted by the other side.
    let ts_hello_ann = Hello::from_value(&sc["ann"]["hello"]).unwrap();
    let ts_hello_bob = Hello::from_value(&sc["bob"]["hello"]).unwrap();
    let our_hello_ann = a.hello(&ann).unwrap();
    assert_eq!(
        (&our_hello_ann.epk, &our_hello_ann.nonce),
        (&ts_hello_ann.epk, &ts_hello_ann.nonce)
    );
    a.accept(&ts_hello_bob).unwrap();
    b.accept(&our_hello_ann).unwrap();

    // Frames TypeScript encrypted decrypt here, and re-encrypting the same plaintext gives the same bytes.
    for f in sc["frames"].as_array().unwrap() {
        let frame = Data::from_value(&f["frame"]).unwrap();
        let plaintext: Value = serde_json::from_str(f["plaintext"].as_str().unwrap()).unwrap();
        let (sender, receiver) = if f["from"] == "ann" {
            (&mut a, &mut b)
        } else {
            (&mut b, &mut a)
        };
        assert_eq!(receiver.decrypt(&frame).unwrap(), plaintext);
        let again = sender.encrypt(&plaintext).unwrap();
        assert_eq!(again, frame, "frame {}", f["n"]);
        // A replay is refused.
        assert_eq!(receiver.decrypt(&frame).unwrap_err(), ChannelError::Replay);
    }

    // An impostor's hello (signed by someone else) is refused; so is a second handshake.
    let mut c = SecureChannel::new(
        bob_uid.as_str(),
        ann_uid.as_str(),
        ann.sign_public(),
        &mut SeededEntropy::new("c"),
    )
    .unwrap();
    assert_eq!(
        c.accept(&Hello::from_value(&sc["impostorHello"]).unwrap())
            .unwrap_err(),
        ChannelError::BadHandshake
    );
    assert_eq!(
        a.accept(&ts_hello_bob).unwrap_err(),
        ChannelError::AlreadyEstablished
    );
    let _ = cat;
    // Nothing can be sent before the handshake.
    let mut fresh =
        SecureChannel::new("x", "y", ann.sign_public(), &mut SeededEntropy::new("f")).unwrap();
    assert_eq!(
        fresh.encrypt(&json!({})).unwrap_err(),
        ChannelError::NotEstablished
    );
}

#[test]
fn ble_tags_match_the_shared_vectors() {
    use privcord_crypto::ble::{ble_accept_tags, ble_tag};
    let root = env!("CARGO_MANIFEST_DIR");
    let text = std::fs::read_to_string(format!("{root}/../../docs/ble-vectors.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let hex = |s: &str| -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    };
    let secret = hex(v["tag"]["secretHex"].as_str().unwrap());
    for t in v["tag"]["vectors"].as_array().unwrap() {
        let tag = ble_tag(&secret, t["epoch"].as_u64().unwrap()).unwrap();
        assert_eq!(tag.to_vec(), hex(t["tagHex"].as_str().unwrap()));
    }
    // Previous, current and next epoch are all accepted.
    let epoch = 1_900_000u64;
    let now_ms = epoch * 900 * 1000 + 5;
    let tags = ble_accept_tags(&secret, now_ms).unwrap();
    assert_eq!(tags.len(), 3);
    assert_eq!(tags[1], ble_tag(&secret, epoch).unwrap());
}

#[test]
fn nostr_events_match_typescript_and_the_relay_rules_hold() {
    use privcord_crypto::{
        nostr::{
            accept_relay_message, event_frame, make_event, req_frame, verify_event, NostrEvent,
            PutKind,
        },
        rng::SeededEntropy,
    };
    use privcord_domain::{blob::SealedBlob, signaling::SeenSet};
    let root = env!("CARGO_MANIFEST_DIR");
    let text = std::fs::read_to_string(format!("{root}/../../docs/misc-vectors.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let n = &v["nostr"];

    // The TypeScript event: our id computation reproduces its id, and its signature verifies; tampering does not.
    let ts = NostrEvent::from_value(&n["event"]).unwrap();
    assert_eq!(
        privcord_crypto::nostr::event_id(&ts.pubkey, ts.created_at, ts.kind, &ts.tags, &ts.content),
        n["expectId"].as_str().unwrap()
    );
    for case in n["verify"].as_array().unwrap() {
        let e = NostrEvent::from_value(&case["event"]).unwrap();
        assert_eq!(verify_event(&e), case["ok"].as_bool().unwrap());
    }

    // Our own event verifies, carries the blob, and is different every time (throwaway key).
    let blob = SealedBlob::from_value(&n["blob"]).unwrap();
    let mut rng = SeededEntropy::new("nostr-test");
    let a = make_event("mb", &blob, PutKind::Sig, 120, 1_700_000_000, &mut rng).unwrap();
    let b = make_event("mb", &blob, PutKind::Msg, 3600, 1_700_000_000, &mut rng).unwrap();
    assert!(verify_event(&a) && verify_event(&b));
    assert_ne!(a.pubkey, b.pubkey);
    assert_eq!((a.kind, b.kind), (21733, 31733));
    assert_eq!(a.tag("expiration"), Some("1700000120"));
    assert_eq!(SealedBlob::decode(&a.content), Some(blob.clone()));
    let mut bad = a.clone();
    bad.content.push('A');
    assert!(!verify_event(&bad));
    assert!(req_frame("sub", "mb", 5).contains("\"#t\":[\"mb\"]"));
    assert!(event_frame(&a).starts_with("[\"EVENT\","));

    // Which relay messages become blobs: right subscription, valid, our mailbox, not expired, first time only.
    let frame =
        |sub: &str, e: &NostrEvent| serde_json::json!(["EVENT", sub, e.to_value()]).to_string();
    let mut seen = SeenSet::default();
    let now = 1_700_000_050;
    assert!(accept_relay_message(&frame("sub", &a), "sub", "mb", &mut seen, now).is_some());
    assert!(
        accept_relay_message(&frame("sub", &a), "sub", "mb", &mut seen, now).is_none(),
        "a repeat is dropped"
    );
    assert!(
        accept_relay_message(&frame("other", &b), "sub", "mb", &mut seen, now).is_none(),
        "wrong subscription"
    );
    assert!(
        accept_relay_message(&frame("sub", &b), "sub", "elsewhere", &mut seen, now).is_none(),
        "wrong mailbox"
    );
    assert!(
        accept_relay_message(
            &frame("sub", &a),
            "sub",
            "mb",
            &mut SeenSet::default(),
            1_700_000_121
        )
        .is_none(),
        "expired"
    );
    assert!(
        accept_relay_message(
            &frame("sub", &bad),
            "sub",
            "mb",
            &mut SeenSet::default(),
            now
        )
        .is_none(),
        "tampered"
    );
    assert!(accept_relay_message("not json", "sub", "mb", &mut SeenSet::default(), now).is_none());
    assert!(accept_relay_message(
        r#"["NOTICE","x"]"#,
        "sub",
        "mb",
        &mut SeenSet::default(),
        now
    )
    .is_none());
}

#[test]
fn a_friend_request_opens_only_from_the_identity_on_its_card() {
    let (ann, bob, eve) = people();
    let bob_uid = bob.uid().unwrap();
    let mut rng = SeededEntropy::new("hello");
    let ann_card = ContactCard::of(&ann, Some("Ann"))
        .unwrap()
        .encode()
        .unwrap();
    // Ann added Bob from his QR code; Bob does not know her yet.
    let hello = json!({ "t": "hello", "card": ann_card });
    let blob = seal(&ann, &bob_uid, &bob.dh_public(), &hello, &mut rng).unwrap();
    let (contact, payload) = open_from_stranger(&blob, &bob_uid, &bob).unwrap();
    assert_eq!(contact.uid, ann.uid().unwrap());
    assert_eq!(payload["t"], "hello");

    // Eve signs her own request but puts Ann's card in it: the card is not the sender, so it is refused.
    let forged = seal(&eve, &bob_uid, &bob.dh_public(), &hello, &mut rng).unwrap();
    assert!(open_from_stranger(&forged, &bob_uid, &bob).is_none());
    // Eve copies Ann's blob and claims to be Ann: the signature no longer matches what was signed.
    let mut relabelled = blob.clone();
    relabelled.sig = forged.sig.clone();
    assert!(open_from_stranger(&relabelled, &bob_uid, &bob).is_none());
    // Not for Bob, or no card inside: refused.
    assert!(open_from_stranger(&blob, &eve.uid().unwrap(), &eve).is_none());
    let bare = seal(
        &ann,
        &bob_uid,
        &bob.dh_public(),
        &json!({ "t": "hello" }),
        &mut rng,
    )
    .unwrap();
    assert!(open_from_stranger(&bare, &bob_uid, &bob).is_none());
}
