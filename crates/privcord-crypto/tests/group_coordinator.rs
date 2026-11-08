//! Group coordination: frames against the TypeScript vectors, and the introduction, sync and gossip behaviour that makes
//! a group form without anyone sharing a code.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::{
    card::ContactCard,
    group_coordinator::{
        GroupCoordinator, GroupError, GroupFrame, MessageVerdict, OutgoingFrame, Who,
        MAX_EVENTS_PER_FRAME,
    },
    identity::Identity,
    rng::SeededEntropy,
};
use serde_json::Value;
use std::collections::BTreeSet;

struct Person {
    id: Identity,
    card: ContactCard,
    uid: String,
    coord: GroupCoordinator,
    known: BTreeSet<String>,
}

fn person(n: u8) -> Person {
    let phrase = privcord_crypto::identity::generate_recovery_phrase(&mut SeededEntropy::new(
        &format!("gc{n}"),
    ))
    .unwrap();
    let id = Identity::from_phrase(&phrase, "").unwrap();
    let card = ContactCard::of(&id, Some(&format!("P{n}"))).unwrap();
    let uid = id.uid().unwrap().to_string();
    let coord = GroupCoordinator::new(&uid, card.clone());
    Person {
        id,
        card,
        uid,
        coord,
        known: BTreeSet::new(),
    }
}

impl Person {
    fn handle(
        &mut self,
        from: &str,
        frame: &GroupFrame,
    ) -> privcord_crypto::group_coordinator::GroupResult {
        let known = self.known.clone();
        self.coord.handle(
            from,
            frame,
            &Who {
                known: &known,
                trusted: None,
            },
        )
    }
}

/// Deliver frames to their recipients, and keep going with whatever they send back, until nothing is left.
fn flood(people: &mut [&mut Person], from: &str, frames: Vec<OutgoingFrame>) -> usize {
    let mut queue: Vec<(String, OutgoingFrame)> =
        frames.into_iter().map(|f| (from.to_owned(), f)).collect();
    let mut delivered = 0;
    while let Some((sender, f)) = queue.pop() {
        if let Some(p) = people.iter_mut().find(|p| p.uid == f.to) {
            delivered += 1;
            let r = p.handle(&sender, &f.frame);
            let me = p.uid.clone();
            queue.extend(r.outgoing.into_iter().map(|o| (me.clone(), o)));
        }
        assert!(delivered < 500, "frames keep bouncing");
    }
    delivered
}

#[test]
fn frames_parse_like_typescript() {
    let root = env!("CARGO_MANIFEST_DIR");
    let v: Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{root}/../../docs/group-vectors.json")).unwrap(),
    )
    .unwrap();
    let mut valid = 0;
    for f in v["frames"].as_array().unwrap() {
        let parsed = GroupFrame::parse(&f["frame"]);
        assert_eq!(
            parsed.is_some(),
            f["valid"].as_bool().unwrap(),
            "{}",
            f["frame"]
        );
        if let Some(p) = parsed {
            valid += 1;
            // A frame we write parses to the same frame.
            assert_eq!(GroupFrame::parse(&p.to_value()), Some(p));
        }
    }
    assert!(
        valid >= 1 && valid < v["frames"].as_array().unwrap().len(),
        "some frames are valid and some are refused: {valid}"
    );
}

#[test]
fn a_group_forms_by_introduction_with_nobody_sharing_codes() {
    let (mut ann, mut bob, mut cat) = (person(1), person(2), person(3));
    // Ann knows Bob and Cat; Bob and Cat have never met.
    ann.known = BTreeSet::from([bob.uid.clone(), cat.uid.clone()]);
    bob.known = BTreeSet::from([ann.uid.clone()]);
    cat.known = BTreeSet::from([ann.uid.clone()]);

    let (gid, created) = ann
        .coord
        .create_group(
            &ann.id,
            "Friends",
            &[bob.card.clone(), cat.card.clone()],
            1000,
        )
        .unwrap();
    assert_eq!(created.joined, vec![gid.clone()]);
    let (a_uid, b_uid, c_uid) = (ann.uid.clone(), bob.uid.clone(), cat.uid.clone());
    let delivered = flood(&mut [&mut bob, &mut cat], &a_uid, created.outgoing);
    assert!(delivered >= 2);

    // Both joined and both learned the other from the roster, introduced by Ann.
    for (p, other) in [(&bob, &c_uid), (&cat, &b_uid)] {
        assert_eq!(p.coord.state(&gid).unwrap().members.len(), 3);
        assert!(p.coord.is_member(&gid, &p.uid));
        assert!(p.coord.is_member(&gid, other));
    }
    let mut bob2 = person(2);
    bob2.known = BTreeSet::from([a_uid.clone()]);
    // Replay for the "new contacts" report: a member we have not met yet is listed with who introduced them.
    // A new member gets the whole history in one batch (a lone event of a group we are not in is not believed).
    let all: Vec<privcord_crypto::group::GroupEvent> = ann.coord.export()[&gid]
        .iter()
        .map(|e| privcord_crypto::group::GroupEvent::from_value(e).unwrap())
        .collect();
    let r = bob2.handle(&a_uid, &GroupFrame::Events(all));
    let joined = !r.joined.is_empty();
    let new_contacts = r.new_contacts;
    assert!(joined);
    assert!(new_contacts
        .iter()
        .any(|c| c.uid == c_uid && c.introduced_by == a_uid));
    assert!(
        !new_contacts.iter().any(|c| c.uid == a_uid),
        "already known contacts are not reported"
    );
}

#[test]
fn news_is_gossiped_to_members_the_author_cannot_reach() {
    let (mut ann, mut bob, mut cat, mut dan) = (person(1), person(2), person(3), person(4));
    ann.known = BTreeSet::from([bob.uid.clone(), cat.uid.clone(), dan.uid.clone()]);
    bob.known = BTreeSet::from([ann.uid.clone(), cat.uid.clone()]);
    cat.known = BTreeSet::from([ann.uid.clone(), bob.uid.clone()]);
    dan.known = BTreeSet::from([ann.uid.clone()]);
    let (gid, created) = ann
        .coord
        .create_group(&ann.id, "G", &[bob.card.clone(), cat.card.clone()], 1000)
        .unwrap();
    let a = ann.uid.clone();
    flood(&mut [&mut bob, &mut cat], &a, created.outgoing);

    // Bob adds Dan. Bob is linked to Ann only: Ann learns it from Bob's push, and Ann gossips it to Cat.
    let added = bob
        .coord
        .add_member(&bob.id, &gid, &dan.card, 2000)
        .unwrap();
    let b = bob.uid.clone();
    // Bob's frames to Cat are dropped (no link); only Ann and Dan are reachable.
    let reachable: Vec<OutgoingFrame> = added
        .outgoing
        .into_iter()
        .filter(|f| f.to != cat.uid)
        .collect();
    flood(&mut [&mut ann, &mut dan, &mut cat], &b, reachable);
    assert!(
        cat.coord.is_member(&gid, &dan.uid),
        "Cat heard about Dan through Ann"
    );
    assert!(
        dan.coord.is_member(&gid, &dan.uid) && dan.coord.state(&gid).unwrap().members.len() == 4
    );
    assert_eq!(ann.coord.check_message(&dan.uid, &gid), MessageVerdict::Ok);
}

#[test]
fn history_syncs_on_link_open_and_a_missing_group_is_pushed() {
    let (mut ann, mut bob) = (person(1), person(2));
    ann.known = BTreeSet::from([bob.uid.clone()]);
    bob.known = BTreeSet::from([ann.uid.clone()]);
    let (gid, created) = ann
        .coord
        .create_group(&ann.id, "G", std::slice::from_ref(&bob.card), 1000)
        .unwrap();
    // Bob never got the frames (he was offline). When the link opens he says "I have nothing"; Ann pushes the group.
    drop(created);
    let (a, b) = (ann.uid.clone(), bob.uid.clone());
    let hello = bob.coord.on_link_open(&a);
    assert!(
        matches!(&hello[0].frame, GroupFrame::Have { groups, full: true } if groups.is_empty())
    );
    flood(&mut [&mut ann, &mut bob], &b, hello);
    assert!(bob.coord.is_member(&gid, &b));

    // After that, one more event Bob lacks is sent when Ann reports what she has.
    ann.coord.rename(&ann.id, &gid, "Renamed", 3000).unwrap();
    let have = ann.coord.on_link_open(&b);
    flood(&mut [&mut ann, &mut bob], &a, have);
    assert_eq!(bob.coord.state(&gid).unwrap().name, "Renamed");
}

#[test]
fn only_members_can_pull_history_and_spam_for_a_foreign_group_is_forgotten() {
    let (mut ann, mut bob, mut eve) = (person(1), person(2), person(5));
    ann.known = BTreeSet::from([bob.uid.clone(), eve.uid.clone()]);
    eve.known = BTreeSet::from([ann.uid.clone()]);
    let (gid, _) = ann
        .coord
        .create_group(&ann.id, "Secret", std::slice::from_ref(&bob.card), 1000)
        .unwrap();
    // Eve is a contact but not a member: asking about the group gets nothing back, not even a hint it exists.
    let ask = GroupFrame::Have {
        groups: vec![(gid.clone(), vec![])],
        full: true,
    };
    let r = ann.handle(&eve.uid, &ask);
    assert!(r.outgoing.is_empty());

    // Eve (a known contact) pushes Bob a group he is not in: it is not kept.
    let (spam_gid, spam) = eve.coord.create_group(&eve.id, "Spam", &[], 1000).unwrap();
    bob.known = BTreeSet::from([eve.uid.clone(), ann.uid.clone()]);
    let eve_uid = eve.uid.clone();
    let frames: Vec<GroupFrame> = eve.coord.export()[&spam_gid]
        .iter()
        .map(|e| {
            GroupFrame::parse(&serde_json::json!({ "v": 1, "kind": "group_push", "event": e }))
                .unwrap()
        })
        .collect();
    drop(spam);
    for f in &frames {
        bob.handle(&eve_uid, f);
    }
    assert!(
        bob.coord.state(&spam_gid).is_none(),
        "not a member, so forgotten"
    );
    // A stranger Bob does not know cannot even get a group stored.
    let mut mallory = person(6);
    let (m_gid, _) = mallory
        .coord
        .create_group(&mallory.id, "Hi", std::slice::from_ref(&bob.card), 1000)
        .unwrap();
    let m_frames: Vec<GroupFrame> = mallory.coord.export()[&m_gid]
        .iter()
        .map(|e| {
            GroupFrame::parse(&serde_json::json!({ "v": 1, "kind": "group_push", "event": e }))
                .unwrap()
        })
        .collect();
    for f in &m_frames {
        bob.handle(&mallory.uid, f);
    }
    assert!(bob.coord.state(&m_gid).is_none());
    assert_eq!(
        bob.coord.check_message(&mallory.uid, &m_gid),
        MessageVerdict::UnknownGroup
    );
}

#[test]
fn the_ten_member_cap_removal_leaving_and_messages_are_enforced() {
    let mut ann = person(1);
    let members: Vec<Person> = (2..=12).map(person).collect();
    let cards: Vec<ContactCard> = members.iter().map(|m| m.card.clone()).collect();
    assert_eq!(
        ann.coord
            .create_group(&ann.id, "Big", &cards, 1000)
            .unwrap_err(),
        GroupError::TooManyMembers
    );
    let (gid, _) = ann
        .coord
        .create_group(&ann.id, "Big", &cards[..9], 1000)
        .unwrap();
    assert_eq!(ann.coord.state(&gid).unwrap().members.len(), 10);
    assert_eq!(
        ann.coord
            .add_member(&ann.id, &gid, &cards[9], 2000)
            .unwrap_err(),
        GroupError::Full
    );
    assert_eq!(
        ann.coord
            .add_member(&ann.id, &gid, &cards[0], 2000)
            .unwrap_err(),
        GroupError::AlreadyMember
    );

    // Only an admin removes others. A plain member's removal attempt is not allowed, and they can still leave.
    let mut bob = person(2);
    bob.known = BTreeSet::from([ann.uid.clone()]);
    let (gid2, created) = ann
        .coord
        .create_group(&ann.id, "Small", std::slice::from_ref(&bob.card), 3000)
        .unwrap();
    let a = ann.uid.clone();
    flood(&mut [&mut bob], &a, created.outgoing);
    assert_eq!(
        bob.coord
            .remove_member(&bob.id, &gid2, &a, 4000)
            .unwrap_err(),
        GroupError::NotAllowed
    );
    let left = bob.coord.leave(&bob.id, &gid2, 5000).unwrap();
    assert_eq!(left.left, vec![gid2.clone()]);
    assert_eq!(
        bob.coord.check_message(&a, &gid2),
        MessageVerdict::NotMember
    );
    assert_eq!(
        bob.coord.rename(&bob.id, &gid2, "x", 6000).unwrap_err(),
        GroupError::NotMember
    );
    // Ann first asks for the rejected attempt Bob's leave was written after (it stays in his log), then applies the leave.
    let b_uid = bob.uid.clone();
    flood(&mut [&mut ann, &mut bob], &b_uid, left.outgoing);
    assert!(!ann.coord.is_member(&gid2, &bob.uid));
    assert_eq!(
        ann.coord.check_message("nobody", &gid2),
        MessageVerdict::NotMember
    );
    assert_eq!(
        ann.coord.check_message(&a, "no-such-group"),
        MessageVerdict::UnknownGroup
    );
}

#[test]
fn big_histories_travel_in_batches_and_saved_groups_reload() {
    let mut ann = person(1);
    let bob = person(2);
    let (gid, _) = ann
        .coord
        .create_group(&ann.id, "Chatty", std::slice::from_ref(&bob.card), 1000)
        .unwrap();
    for i in 0..(MAX_EVENTS_PER_FRAME + 5) {
        ann.coord
            .rename(&ann.id, &gid, &format!("name {i}"), 2000 + i as i64)
            .unwrap();
    }
    let have = GroupFrame::Have {
        groups: vec![(gid.clone(), vec![])],
        full: false,
    };
    let known = BTreeSet::from([bob.uid.clone()]);
    let r = ann.coord.handle(
        &bob.uid,
        &have,
        &Who {
            known: &known,
            trusted: None,
        },
    );
    let sizes: Vec<usize> = r
        .outgoing
        .iter()
        .map(|o| {
            if let GroupFrame::Events(e) = &o.frame {
                e.len()
            } else {
                0
            }
        })
        .collect();
    assert!(
        sizes.iter().all(|n| *n <= MAX_EVENTS_PER_FRAME) && sizes.len() >= 2,
        "{sizes:?}"
    );
    assert_eq!(sizes.iter().sum::<usize>(), ann.coord.event_count(&gid));

    let saved = ann.coord.export();
    let mut again = GroupCoordinator::new(&ann.uid, ann.card.clone());
    again.load(&saved);
    assert_eq!(
        again.state(&gid).unwrap().name,
        format!("name {}", MAX_EVENTS_PER_FRAME + 4)
    );
    assert_eq!(again.event_count(&gid), ann.coord.event_count(&gid));
}
