//! `cargo run -p privcord-ffi --features cli --bin uniffi-bindgen -- generate --library <libprivcord_ffi.so> --language kotlin --out-dir <dir>`
fn main() {
    uniffi::uniffi_bindgen_main();
}
