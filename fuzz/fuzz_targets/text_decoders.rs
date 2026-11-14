//! Text that comes from outside: cards (QR codes, pasted), sealed blobs (relays), invite words, manual connection codes,
//! base64, stored settings. None may panic.
#![no_main]
use libfuzzer_sys::fuzz_target;
use privcord_domain::{blob::SealedBlob, codec, network, pairing, signaling::ManualSignal};

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let _ = privcord_crypto::card::ContactCard::decode(text);
    let _ = SealedBlob::decode(text);
    let _ = privcord_crypto::invite::parse_invite_words(text);
    let _ = codec::decode(text);
    let _ = ManualSignal::decode(text, "duo");
    let _ = network::NetworkConfig::parse(Some(text));
    let _ = network::parse_turn_share(text);
    let _ = pairing::PairingStoreState::parse(Some(text), None);
});
