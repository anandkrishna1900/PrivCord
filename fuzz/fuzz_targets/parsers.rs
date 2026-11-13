//! Every parser of a JSON frame that arrives from a peer, a relay or the mesh: none may panic on any input.
#![no_main]
use libfuzzer_sys::fuzz_target;
use privcord_crypto::{
    group, group_coordinator, nostr, peer_auth, pq_channel, prekeys, secure_channel,
};
use privcord_domain::{blob, files, mesh, message, pairing, peer, social};

fuzz_target!(|data: &[u8]| {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(data) else {
        return;
    };
    let _ = message::ChatMessage::from_peer_frame(&v);
    let _ = message::ReplyRef::from_value(&v);
    let _ = message::parse_declined_frame(&v);
    let _ = message::parse_timestamp(&v);
    let _ = message::parse_timestamp_any(&v);
    let _ = social::parse_delete_frame(&v);
    let _ = social::parse_react_frame(&v);
    let _ = mesh::MeshPacket::parse(&v);
    let _ = peer::PeerFrame::parse(&v);
    let _ = files::FileOffer::from_frame(&v);
    let _ = files::FileChunk::from_frame(&v);
    let _ = pairing::PairingRecord::from_value(&v, None);
    let _ = blob::PublicJwk::from_value(&v);
    let _ = blob::SealedBlob::from_value(&v);
    let _ = pq_channel::PqHello::from_value(&v);
    let _ = pq_channel::PqKem::from_value(&v);
    let _ = pq_channel::PqData::from_value(&v);
    let _ = peer_auth::Hello::parse(&v);
    let _ = secure_channel::Hello::from_value(&v);
    let _ = secure_channel::Data::from_value(&v);
    let _ = group::GroupEvent::from_value(&v);
    let _ = group_coordinator::GroupFrame::parse(&v);
    let _ = nostr::NostrEvent::from_value(&v);
    let _ = prekeys::PeerKey::from_value(&v);
    let _ = privcord_crypto::card::ContactCard::from_value(&v);
});
