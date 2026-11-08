//! Property tests: no input, however hostile, may panic a parser, and the merge/ordering rules hold for any data.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_domain::{
    codec,
    files::{FileChunk, FileOffer},
    ids::{MessageId, UserId},
    message::{parse_declined_frame, ChatMessage, DeliveryState},
    network::{parse_turn_share, NetworkConfig},
    ordering::{compare_messages, merge_messages},
    social::{parse_delete_frame, parse_react_frame},
};
use proptest::prelude::*;
use serde_json::Value;

fn arb_json() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<i64>().prop_map(Value::from),
        any::<f64>()
            .prop_filter("finite", |f| f.is_finite())
            .prop_map(Value::from),
        ".{0,40}".prop_map(Value::String),
    ];
    leaf.prop_recursive(4, 64, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6).prop_map(Value::Array),
            prop::collection::hash_map("[a-zA-Z]{1,12}", inner, 0..6)
                .prop_map(|m| Value::Object(m.into_iter().collect())),
        ]
    })
}

fn arb_message() -> impl Strategy<Value = ChatMessage> {
    (
        "[a-z0-9-]{1,12}",
        1i64..2_000_000,
        prop::sample::select(vec![
            DeliveryState::Queued,
            DeliveryState::Sent,
            DeliveryState::Delivered,
            DeliveryState::Read,
            DeliveryState::Failed,
        ]),
    )
        .prop_map(|(id, at, state)| {
            let mut m = ChatMessage::outgoing(
                UserId::new("u").unwrap(),
                "hi",
                at,
                MessageId::new(id).unwrap(),
                None,
            )
            .unwrap();
            m.delivery_state = state;
            m
        })
}

proptest! {
    #[test]
    fn no_parser_panics_on_arbitrary_json(v in arb_json()) {
        let _ = ChatMessage::from_peer_frame(&v);
        let _ = FileOffer::from_frame(&v);
        let _ = FileChunk::from_frame(&v);
        let _ = parse_declined_frame(&v);
        let _ = parse_delete_frame(&v);
        let _ = parse_react_frame(&v);
        let _ = privcord_domain::message::ReplyRef::from_value(&v);
        let _ = privcord_domain::blob::SealedBlob::from_value(&v);
        let _ = privcord_domain::mesh::MeshPacket::parse(&v);
        let _ = NetworkConfig::parse(Some(&v.to_string()));
    }

    #[test]
    fn no_text_parser_panics(s in ".{0,200}") {
        let _ = codec::decode(&s);
        let _ = parse_turn_share(&s);
        let _ = privcord_domain::channel::normalize_channel_name(&s);
        let _ = privcord_domain::files::sanitize_file_name(&s);
        let _ = privcord_domain::files::sanitize_mime(&s);
        let _ = NetworkConfig::parse(Some(&s));
        let _ = privcord_domain::message::validate_outgoing_text(&s);
    }

    #[test]
    fn base64url_round_trips(bytes in prop::collection::vec(any::<u8>(), 0..300)) {
        prop_assert_eq!(codec::decode(&codec::encode(&bytes)), Some(bytes));
    }

    #[test]
    fn sanitised_names_are_safe_and_bounded(s in ".{0,300}") {
        let n = privcord_domain::files::sanitize_file_name(&s);
        prop_assert!(!n.is_empty());
        prop_assert!(n.chars().count() <= 120);
        let bad = n.chars().any(|c| c <= '\u{1f}' || "\\/:*?\"<>|".contains(c));
        prop_assert!(!bad);
        prop_assert!(!n.starts_with('.'));
    }

    #[test]
    fn merge_is_idempotent_and_sorted(a in prop::collection::vec(arb_message(), 0..12), b in prop::collection::vec(arb_message(), 0..12)) {
        let once = merge_messages(a.clone(), b.clone());
        let twice = merge_messages(once.clone(), b);
        prop_assert_eq!(once.len(), twice.len());
        for w in once.windows(2) {
            prop_assert!(compare_messages(&w[0], &w[1]).is_le());
        }
        let ids: std::collections::HashSet<_> = once.iter().map(|m| m.message_id.to_string()).collect();
        prop_assert_eq!(ids.len(), once.len());
    }

    #[test]
    fn delivery_state_never_moves_backwards(a in prop::sample::select(vec![DeliveryState::Queued, DeliveryState::Sent, DeliveryState::Delivered, DeliveryState::Read, DeliveryState::Failed]),
                                            b in prop::sample::select(vec![DeliveryState::Queued, DeliveryState::Sent, DeliveryState::Delivered, DeliveryState::Read, DeliveryState::Failed])) {
        let h = DeliveryState::highest(a, b);
        prop_assert_eq!(h, DeliveryState::highest(b, a));
        if a == DeliveryState::Read || b == DeliveryState::Read { prop_assert_eq!(h, DeliveryState::Read); }
    }

    #[test]
    fn chunks_reassemble_for_any_size(len in 1usize..60_000, seed in any::<u8>()) {
        use privcord_domain::files::{file_chunks, AssembleResult, BeginOutcome, FileAssembler};
        let bytes: Vec<u8> = (0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect();
        let id = MessageId::new("f").unwrap();
        let offer = FileOffer::make(id.clone(), None, "a.bin", "application/octet-stream", &bytes, 5, None).unwrap();
        let mut asm = FileAssembler::new();
        prop_assert_eq!(asm.begin(offer), BeginOutcome::Ok);
        let mut last = AssembleResult::More;
        for c in file_chunks(&id, &bytes) { last = asm.chunk(&c); }
        match last {
            AssembleResult::Done { bytes: out, .. } => prop_assert_eq!(out, bytes),
            other => prop_assert!(false, "{:?}", other),
        }
    }

    #[test]
    fn a_tampered_chunk_never_assembles(len in 13_000usize..40_000, flip in 0usize..12_000) {
        use privcord_domain::files::{file_chunks, AssembleResult, FileAssembler};
        let bytes: Vec<u8> = (0..len).map(|i| i as u8).collect();
        let id = MessageId::new("f").unwrap();
        let offer = FileOffer::make(id.clone(), None, "a.bin", "application/octet-stream", &bytes, 5, None).unwrap();
        let mut asm = FileAssembler::new();
        asm.begin(offer);
        let mut chunks: Vec<_> = file_chunks(&id, &bytes).collect();
        let mut raw = codec::decode(&chunks[0].data).unwrap();
        let at = flip % raw.len();
        raw[at] ^= 1;
        chunks[0].data = codec::encode(&raw);
        let mut last = AssembleResult::More;
        for c in &chunks { last = asm.chunk(c); }
        prop_assert!(matches!(last, AssembleResult::Failed(_)));
    }
}
