//! Prints `docs/rust-vectors.json`: things the Rust code produced that the TypeScript tests must open
//! (`packages/protocol/test/rustInterop.test.ts`). Deterministic: same output every run.
//! Run: `cargo run -p privcord-crypto --features test-support --example gen_vectors > docs/rust-vectors.json`

fn main() {
    match privcord_crypto::vectors::build().and_then(|v| serde_json::to_string_pretty(&v).map_err(|_| privcord_crypto::CryptoError::Invalid)) {
        Ok(text) => println!("{text}"),
        Err(e) => {
            eprintln!("could not build vectors: {e}");
            std::process::exit(1);
        }
    }
}
