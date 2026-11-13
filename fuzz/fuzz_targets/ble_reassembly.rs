//! Bluetooth chunks from any nearby device, in any order and size: reassembly may refuse them, never panic or grow
//! without bound.
#![no_main]
use libfuzzer_sys::fuzz_target;
use privcord_domain::ble::Reassembler;

fuzz_target!(|data: &[u8]| {
    let mut r = Reassembler::new();
    // The first byte sets the chunk size, the rest is cut into chunks of it.
    let Some((&size, rest)) = data.split_first() else {
        return;
    };
    for chunk in rest.chunks(usize::from(size.max(1))) {
        let _ = r.push(chunk);
    }
});
