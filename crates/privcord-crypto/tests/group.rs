//! The group log against the TypeScript traces in `docs/group-vectors.json`: every step's status, effect, roster and name,
//! the final order, heads and effective events must be identical.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::{
    card::ContactCard,
    group::{sign_group_event, AddStatus, EventType, GroupLog, NewEvent},
    identity::Identity,
    rng::SeededEntropy,
};
use serde_json::Value;

fn vectors() -> Value {
    let root = env!("CARGO_MANIFEST_DIR");
    serde_json::from_str(
        &std::fs::read_to_string(format!("{root}/../../docs/group-vectors.json")).unwrap(),
    )
    .unwrap()
}

fn roster(log: &GroupLog) -> Vec<String> {
    log.state()
        .map(|s| s.members.keys().cloned().collect())
        .unwrap_or_default()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

/// Replay `events` and compare with the TypeScript trace.
fn check(group_id: &str, events: &[Value], expected: &Value, label: &str) {
    let mut log = GroupLog::new(group_id);
    for (i, ev) in events.iter().enumerate() {
        let status = log.add(ev);
        let step = &expected["steps"][i];
        let id = ev["eventId"].as_str().unwrap();
        assert_eq!(
            status.as_str(),
            step["status"].as_str().unwrap(),
            "{label} step {i} status"
        );
        assert_eq!(
            log.is_effective(id),
            step["effective"].as_bool().unwrap(),
            "{label} step {i} effective"
        );
        assert_eq!(
            roster(&log),
            strings(&step["roster"]),
            "{label} step {i} roster"
        );
        assert_eq!(
            log.state().map(|s| s.name.clone()),
            step["name"].as_str().map(str::to_owned),
            "{label} step {i} name"
        );
    }
    assert_eq!(
        log.all()
            .iter()
            .map(|e| e.event_id.clone())
            .collect::<Vec<_>>(),
        strings(&expected["order"]),
        "{label} order"
    );
    assert_eq!(log.heads(), strings(&expected["heads"]), "{label} heads");
    assert_eq!(roster(&log), strings(&expected["roster"]), "{label} roster");
    let effective: Vec<String> = log
        .all()
        .into_iter()
        .filter(|e| log.is_effective(&e.event_id))
        .map(|e| e.event_id)
        .collect();
    assert_eq!(
        effective,
        strings(&expected["effective"]),
        "{label} effective set"
    );
}

#[test]
fn every_typescript_scenario_folds_identically() {
    let v = vectors();
    let group_id = v["groupId"].as_str().unwrap();
    let base: Vec<Value> = v["base"].as_array().unwrap().clone();
    let with_base = |extra: &[Value]| [base.clone(), extra.to_vec()].concat();

    let concurrent: Vec<Value> = v["concurrent"]["events"].as_array().unwrap().clone();
    check(
        group_id,
        &with_base(&concurrent),
        &v["concurrent"]["expected"],
        "concurrent",
    );
    let linear: Vec<Value> = v["linear"]["events"].as_array().unwrap().clone();
    check(group_id, &linear, &v["linear"]["expected"], "linear");
    let buffered: Vec<Value> = v["buffered"]["events"].as_array().unwrap().clone();
    check(
        group_id,
        &with_base(&buffered),
        &v["buffered"]["expected"],
        "buffered",
    );
    for r in v["rejects"].as_array().unwrap() {
        check(
            group_id,
            &with_base(std::slice::from_ref(&r["event"])),
            &r["expected"],
            r["label"].as_str().unwrap(),
        );
    }
}

#[test]
fn the_order_of_arrival_does_not_change_the_result() {
    let v = vectors();
    let group_id = v["groupId"].as_str().unwrap();
    let mut all: Vec<Value> = v["base"].as_array().unwrap().clone();
    all.extend(
        v["concurrent"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .cloned(),
    );
    let reference = {
        let mut l = GroupLog::new(group_id);
        all.iter().for_each(|e| {
            let _ = l.add(e);
        });
        (
            roster(&l),
            l.heads(),
            l.all()
                .iter()
                .map(|e| e.event_id.clone())
                .collect::<Vec<_>>(),
        )
    };
    // Reversed, and rotated: events whose dependencies are missing are buffered, then released.
    for shift in 0..all.len() {
        let mut shuffled = all.clone();
        shuffled.rotate_left(shift);
        shuffled.reverse();
        let mut l = GroupLog::new(group_id);
        shuffled.iter().for_each(|e| {
            let _ = l.add(e);
        });
        assert_eq!(
            (
                roster(&l),
                l.heads(),
                l.all()
                    .iter()
                    .map(|e| e.event_id.clone())
                    .collect::<Vec<_>>()
            ),
            reference,
            "shift {shift}"
        );
    }
}

fn person(seed: u8) -> (Identity, ContactCard, String) {
    let phrase = privcord_crypto::identity::generate_recovery_phrase(&mut SeededEntropy::new(
        &format!("p{seed}"),
    ))
    .unwrap();
    let id = Identity::from_phrase(&phrase, "").unwrap();
    let card = ContactCard::of(&id, Some("P")).unwrap();
    let uid = id.uid().unwrap().to_string();
    (id, card, uid)
}

#[allow(clippy::too_many_arguments)]
fn event(
    identity: &Identity,
    group: &str,
    kind: EventType,
    actor: &str,
    ts: i64,
    deps: &[String],
    target: Option<&str>,
    card: Option<&ContactCard>,
    name: Option<&str>,
) -> Value {
    sign_group_event(
        identity,
        NewEvent {
            group_id: group.into(),
            kind,
            actor: actor.into(),
            ts,
            deps: deps.to_vec(),
            target: target.map(str::to_owned),
            card: card.cloned(),
            name: name.map(str::to_owned),
        },
    )
    .unwrap()
    .to_value()
}

#[test]
fn events_signed_in_rust_are_accepted_and_the_ten_member_cap_holds() {
    let (admin, admin_card, admin_uid) = person(0);
    let create = event(
        &admin,
        "",
        EventType::Create,
        &admin_uid,
        1000,
        &[],
        None,
        Some(&admin_card),
        Some("Rust group"),
    );
    let group_id = create["groupId"].as_str().unwrap().to_owned();
    assert_eq!(create["eventId"], create["groupId"]);
    let mut log = GroupLog::new(&group_id);
    assert_eq!(log.add(&create), AddStatus::Applied);
    assert_eq!(log.add(&create), AddStatus::Duplicate);

    // Add eleven more people in a chain: only nine fit (the creator is the tenth).
    let mut head = vec![create["eventId"].as_str().unwrap().to_owned()];
    let mut added = vec![];
    for i in 1..=11u8 {
        let (_, card, uid) = person(i);
        let e = event(
            &admin,
            &group_id,
            EventType::Add,
            &admin_uid,
            1000 + i64::from(i) * 10,
            &head,
            Some(&uid),
            Some(&card),
            None,
        );
        head = vec![e["eventId"].as_str().unwrap().to_owned()];
        assert_eq!(log.add(&e), AddStatus::Applied);
        added.push((uid, e["eventId"].as_str().unwrap().to_owned()));
    }
    assert_eq!(log.state().unwrap().members.len(), 10, "hard cap");
    assert!(log.is_effective(&added[8].1), "the ninth add fits");
    assert!(
        !log.is_effective(&added[9].1) && !log.is_effective(&added[10].1),
        "the rest do nothing, on every replica"
    );

    // Only an admin renames; a member's rename is stored but has no effect.
    let (member_id, _, member_uid) = person(1);
    let ren = event(
        &member_id,
        &group_id,
        EventType::Rename,
        &member_uid,
        5000,
        &head,
        None,
        None,
        Some("hijacked"),
    );
    assert_eq!(log.add(&ren), AddStatus::Applied);
    assert_eq!(log.state().unwrap().name, "Rust group");
    // A member can leave on their own, and then cannot write any more.
    let leave = event(
        &member_id,
        &group_id,
        EventType::Remove,
        &member_uid,
        5100,
        &[ren["eventId"].as_str().unwrap().to_owned()],
        Some(&member_uid),
        None,
        None,
    );
    assert_eq!(log.add(&leave), AddStatus::Applied);
    assert!(!log.state().unwrap().members.contains_key(&member_uid));
}

#[test]
fn tampering_missing_parents_and_foreign_groups_are_refused() {
    let (admin, card, uid) = person(0);
    let create = event(
        &admin,
        "",
        EventType::Create,
        &uid,
        1000,
        &[],
        None,
        Some(&card),
        Some("G"),
    );
    let gid = create["groupId"].as_str().unwrap().to_owned();
    let mut log = GroupLog::new(&gid);
    log.add(&create);
    let (_, c2, u2) = person(1);
    let good = event(
        &admin,
        &gid,
        EventType::Add,
        &uid,
        1100,
        std::slice::from_ref(&gid),
        Some(&u2),
        Some(&c2),
        None,
    );

    let mut tampered = good.clone();
    tampered["ts"] = 1101.into();
    assert_eq!(
        log.add(&tampered),
        AddStatus::Invalid,
        "id no longer matches"
    );
    let mut forged_sig = good.clone();
    forged_sig["sig"] = create["sig"].clone();
    assert_eq!(
        log.add(&forged_sig),
        AddStatus::Applied,
        "stored, but a bad signature has no effect"
    );
    assert!(!log.is_effective(good["eventId"].as_str().unwrap()));
    assert_eq!(log.state().unwrap().members.len(), 1);
    // The broken copy came first, but it must not shadow the genuine event: the real one still takes effect, and a
    // broken copy arriving after it changes nothing.
    assert_eq!(log.add(&good), AddStatus::Applied);
    assert!(log.is_effective(good["eventId"].as_str().unwrap()));
    assert_eq!(log.state().unwrap().members.len(), 2);
    assert_eq!(log.add(&forged_sig), AddStatus::Duplicate);
    assert!(log.is_effective(good["eventId"].as_str().unwrap()));

    let mut other = GroupLog::new("0".repeat(64).as_str());
    assert_eq!(other.add(&good), AddStatus::Invalid, "wrong group");
    let no_deps = event(
        &admin,
        &gid,
        EventType::Add,
        &uid,
        1200,
        &[],
        Some(&u2),
        Some(&c2),
        None,
    );
    assert_eq!(log.add(&no_deps), AddStatus::Invalid);
    let orphan = event(
        &admin,
        &gid,
        EventType::Add,
        &uid,
        1300,
        &["f".repeat(64)],
        Some(&u2),
        Some(&c2),
        None,
    );
    assert_eq!(log.add(&orphan), AddStatus::Buffered);
    assert_eq!(log.missing_deps(), vec!["f".repeat(64)]);
    // Garbage is invalid, not a panic.
    assert_eq!(log.add(&Value::Null), AddStatus::Invalid);
    assert_eq!(
        log.add(&serde_json::json!({ "v": 1, "kind": "group_event" })),
        AddStatus::Invalid
    );
}
