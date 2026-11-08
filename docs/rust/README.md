# PrivCord Rust engine

One Rust implementation of PrivCord's rules for Android and Windows (Linux and macOS are not targets for now), replacing the duplicated TypeScript (`packages/protocol`, `apps/desktop/src/lib`) and Kotlin (`apps/android/.../{data,security,engine,groups,p2p}`) logic. This follows [the product requirements document](../../README.md) "Unified Rust Engine PRD v1.0" and its phases M0 to M9.

**Status: foundation built and tested; the apps do not call it yet.** See [Status](#status) before relying on any of it.

## Crates

| Crate | What it holds | Depends on |
|---|---|---|
| `privcord-domain` | Pure rules and types: messages, ordering, delivery states, connection state machine, privacy rule, files and chunk assembler, mesh relay logic, channels, network settings, diagnosis, wire shapes. No OS, network, database, UI or crypto-provider code. | `serde_json`, `base64`, `sha2`, `url`, `unicode-normalization` |
| `privcord-crypto` | Identity recovery and derivation, signatures, key agreement, sealed blobs, contact cards, safety numbers, invites, channels, backups, secure channel. Wire-compatible with TypeScript and Kotlin. | domain, RustCrypto crates (`p256`, `aes-gcm`, `hkdf`, `pbkdf2`, `sha2`), `bip39`, `zeroize` |
| `privcord-ports` | Traits the engine needs from the outside: `Storage`, `SecureStore`, `Transport`, `Clock`, `Notifier`; in-memory fakes behind the `testing` feature. | domain |
| `privcord-engine` | The application engine: identity, contacts and trust, authenticated peer links, messaging, delivery with outbox and retries, events and snapshots; owns its runtime thread. | domain, crypto, ports, Tokio |
| `privcord-storage` | SQLite implementation of `Storage`: versioned schema, atomic batches, integrity check, backup before migration. | domain, ports, `rusqlite` (bundled) |
| `privcord-import` | Reads the existing desktop (SQLite) and Android (Room) databases, verifies everything, and writes it to the new storage. See [IMPORTERS.md](IMPORTERS.md). | domain, crypto, ports, `rusqlite` |
| `privcord-ffi` | The narrow facade the UIs call: plain data, stable error codes, callback traits for the platform adapters. Kotlin bindings are generated from it with UniFFI. The only crate allowed to contain `unsafe` (generated scaffolding). | everything above |

Dependency rule (checked by cargo, not by convention): domain depends on nothing platform-specific; crypto and ports depend on domain; the engine depends on domain, crypto and ports and never on storage or an OS API; adapters and storage implement the port traits; the FFI crate wires them together.

## How the engine is used

A UI (or the FFI) sends typed commands and listens to typed events; it holds no business state. Platform code implements the ports: Android Keystore or Windows Credential Manager for `SecureStore`; WebRTC or Bluetooth for `Transport`; and so on. Link changes and received frames flow into the engine as inputs (`link_up`, `link_down`, `frame_received`). The engine core is a synchronous, deterministic state machine; `runtime.rs` is a thin shell that owns one thread and one current-thread Tokio runtime, a bounded command queue (a full queue answers `Busy`), and a timer for retries. `shutdown()` stops accepting commands, ends every session and joins the thread.

Events are numbered and delivered through bounded queues. A reader that falls behind never blocks the engine: it receives `Lagged { missed }` and asks for a snapshot, which contains everything a recreated UI needs.

## Status

| Milestone (PRD section 16) | State |
|---|---|
| M0 Audit | Done: [MIGRATION_MAP.md](MIGRATION_MAP.md) maps all 164 source files (32,238 lines); the generator fails if a file is unmapped. |
| M1 Foundation | Done: workspace, crate boundaries, error types, port traits, lint rules (`unsafe` forbidden, no `unwrap`/`expect`/`panic` in library code), CI job. |
| M2 Pure domain | Done for what the apps use: rules, BLE chunk framing, pairing records and backoff, manual connection codes, kill-switch plans and runner, link policy. |
| M3 Cryptography | Done for what the apps use: identity, signatures, ECDH, sealed blobs, cards, safety numbers, invites, channels, backups, secure channel, BLE tags, Nostr events (BIP-340). Verified against TypeScript output **and** TypeScript verifies Rust output. X3DH, Double Ratchet, envelopes and group keys exist in the TypeScript package but the apps never call them; they are not ported ([ADR-009](adr/ADR-009-x3dh-ratchet.md)). |
| M4 Protocol services | Done for what the apps do: direct messages, receipts, privacy frames, both handshakes, groups (log, coordinator, sync on link-up, fan-out messages), files, public channels and the Bluetooth mesh, six-word invites, sealed connection setup and store-and-forward messages through the signaling services (rules for Nostr and the relay in Rust, sockets in the adapters), relaying through mutual contacts, the dead-link timer, dial backoff, friend removal and emergency deletion with a truthful report. Also done: delete for everyone (tombstones that survive late copies), reactions, search, muting, and encrypted backups that the apps' backup files restore into. |
| M5 Engine | Done, with mock-adapter integration tests, crash and restart tests, shutdown tests, and three-engine tests for groups, files, channels, invites and relaying. |
| M6 Storage | SQLite storage (schema 3: files, reactions, deleted marks), migrations, crash-safety tests, and importers for the existing desktop and Android databases ([IMPORTERS.md](IMPORTERS.md)) tested on generated fixtures. **Not yet run on a real device's data.** |
| M7 Desktop | Not started: the Tauri shell does not host the engine. |
| M8 Android | Kotlin bindings generate from the FFI crate; they are not compiled into the app, and `ChatEngine.kt` still runs the app. |
| M9 Retirement | Not started. Nothing was deleted. |

## Commands

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
# regenerate Rust-made vectors that the TypeScript tests read (docs/rust-vectors.json)
cargo run -q -p privcord-crypto --features test-support --example gen_vectors > docs/rust-vectors.json
# regenerate the Kotlin bindings snapshot (crates/privcord-ffi/bindings)
cargo build -p privcord-ffi --features cli
target/debug/uniffi-bindgen generate --library target/debug/libprivcord_ffi.so --language kotlin --out-dir crates/privcord-ffi/bindings/kotlin
# regenerate the migration map
python3 docs/rust/tools/gen_migration_map.py
```

More: [COMPATIBILITY.md](COMPATIBILITY.md) (what must not change, and the few deliberate differences), [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md), [BENCHMARKS.md](BENCHMARKS.md), [adr/](adr/).
