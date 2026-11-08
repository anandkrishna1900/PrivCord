# Security checklist and dependency inventory

Status of the PRD's security requirements (section 12) for the Rust code that exists. "Met" means there is code and a test; it is not a substitute for the independent cryptographic review the PRD requires as a separate gate (nothing here has had one).

| ID | Requirement | Status |
|---|---|---|
| SEC-01 | Never log keys, phrases, plaintext secrets or session keys | Met by construction: the Rust crates contain no logging. `Debug` of `Identity`, `StoredSecrets`, `SecureChannel`, `Rendezvous`, `ChannelKeys` prints no key material (tested by review, not by a test that greps output). |
| SEC-02 | Zeroize sensitive buffers, document limits | Partly: seeds, key material, shared secrets, identity scalars, stored secrets, phrases and passphrases use `Zeroizing`/`ZeroizeOnDrop`. Plain `Vec`s that briefly hold decrypted plaintext are not zeroized. Zeroization is best effort: it does not protect against memory dumps, compiler copies or hardware copies. |
| SEC-03 | Authenticate messages and transitions; replay protection | Met for the secure channel (signed hello, per-direction keys, forward-only counters, replay test) and for acknowledgements (only the recipient can acknowledge, tested). |
| SEC-04 | Validate untrusted input, bound lengths, collections, allocations | Met for the parsers that exist: property tests feed arbitrary JSON and text to every parser; frames over 128 KiB are dropped before parsing; ids, names, previews and chunk indexes are bounded. Not fuzzed with a coverage-guided fuzzer yet (see below). |
| SEC-05 | Persist session state consistently, recover after crashes | Met for messages and the outbox: one atomic batch, tested by failing writes and by restart. There is no ratchet state because the apps do not use a ratchet. The secure channel is rebuilt on every link. |
| SEC-06 | Audit dependencies, keep a cryptographic dependency inventory | `cargo audit` is part of CI (see `.github/workflows/ci.yml`) and the inventory is below. One real advisory (RUSTSEC-2026-0387, timing variability in `crypto-bigint` 0.5.5, pulled in by `p256` 0.13) was found while building this and fixed by moving to `p256` 0.14. Three "unmaintained" warnings remain (`basic-toml`, `bincode`, `paste`), all through UniFFI/build tooling; none is in the cryptographic path. |
| SEC-07 | `unsafe` forbidden by default, exceptions isolated | Met: workspace lint `unsafe_code = "forbid"`; only `privcord-ffi` allows it, solely for UniFFI's generated scaffolding. No hand-written `unsafe` anywhere. |
| SEC-08 | No secrets or internal state through FFI | Mostly: no key or ratchet state reaches UI code. The two private scalars do cross into the platform's `SecureStoreCallbacks` (and back) because that adapter stores them in the OS keystore; that is the single, documented exception. |
| SEC-09 | Enforce limits on message sizes, file sizes, groups, outbox, connections, queues | Met for message length (4000), file size (8 MiB), chunks, incoming transfers per peer, frame size, command queue (256, rejects with `Busy`), event queues (256 per reader, then `Lagged`). Group size, outbox length and connection count limits wait for groups and the connection manager. |
| SEC-10 | Redact diagnostics, safe public error codes | Met: public errors are enumerations (`ErrorCode`, `FfiError`) with fixed texts; no content, keys or paths. |

Library code is held to `clippy::unwrap_used`, `expect_used` and `panic` as errors; tests are exempt.

## Cryptographic dependency inventory

| Crate | Version | Purpose |
|---|---|---|
| `p256` (with `ecdsa`, `ecdh`) | 0.14 | P-256 keys, ECDSA signatures, ECDH |
| `aes-gcm` | 0.10 | AES-256-GCM |
| `sha2` | 0.10 | SHA-256, and SHA-512 inside BIP-39 |
| `hkdf` | 0.12 | HKDF-SHA-256 |
| `pbkdf2` / `hmac` | 0.12 | PBKDF2-HMAC-SHA-256 for invites and backups |
| `bip39` | 2 | Recovery phrase word list, checksum, seed |
| `getrandom` | 0.2 | Operating-system random numbers (the only production randomness source) |
| `zeroize` | 1 | Wiping secrets |

Randomness: production code draws only from the operating system through the `Entropy` trait. A repeatable test generator exists behind the `test-support` feature and is not enabled by any shipped crate.

## Not done

Independent cryptographic review of the Rust implementation; coverage-guided fuzzing (`cargo fuzz`) of the parsers (property tests stand in for now); `cargo deny` configuration beyond `deny.toml`; reproducible-build and supply-chain provenance checks; side-channel testing.
