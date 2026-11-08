# Benchmarks

PRD section 11 asks for baselines before claiming improvements, and says gains must be measured rather than assumed. This is a first baseline for the **cryptographic** operations only. It is not a complete report.

**How it was measured**

* Same container for both runs: 4 vCPU, Intel Xeon @ 2.1 GHz, Linux.
* TypeScript: Node.js with WebCrypto, `node docs/rust/tools/bench.mjs` (bundles `packages/protocol`).
* Rust: release build, `cargo run --release -p privcord-crypto --features test-support --example bench`.
* One run of each, after one warm-up call; averages over 5 to 2000 calls. No confidence intervals. Container timing is noisy.

| Operation | TypeScript (Node, WebCrypto) | Rust (release) |
|---|---:|---:|
| Identity from recovery phrase | 18.9 ms | 1.5 ms |
| Seal a message (ECDH, HKDF, AES-GCM, ECDSA sign) | 1.12 ms | 0.47 ms |
| Open a message (verify, ECDH, HKDF, AES-GCM) | 1.15 ms | 0.41 ms |
| Secure-channel frame, encrypt and decrypt | 0.21 ms | 0.004 ms |
| Derive invite (PBKDF2, 150,000 rounds) | 35.8 ms | 16.6 ms |

**What this does and does not show**

* The large identity gap is mostly the TypeScript code's hand-written BigInt scalar multiplication (`recovery/nistP256.ts`), which the Rust version replaces with a vetted library. It happens once per install or recovery.
* Message sealing and opening are already sub-millisecond in both; at chat rates the user will not notice the difference.
* The two sides are not the same kind of thing: Node's WebCrypto calls OpenSSL; the Rust crates are pure Rust. Phones and the WebView on Windows, Linux and macOS will differ from this container, and **no mobile or desktop-app numbers were taken**.

**Not measured yet (PRD section 11)**: cold start and engine-ready latency, allocations per message, storage insert/query/recovery latency, peak memory for files of different sizes, CPU and task count with many peers, idle CPU and memory, shutdown time. Setting numeric targets is deferred until those baselines exist, as the PRD says.
