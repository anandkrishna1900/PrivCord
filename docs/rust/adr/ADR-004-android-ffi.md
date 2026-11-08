# ADR-004: Android through UniFFI
**Decision.** Generate Kotlin bindings from the `privcord-ffi` crate with UniFFI (proc-macro mode). The facade is plain data plus callback traits the platform implements (secure storage, transport, notifications). Kotlin wraps blocking calls in `suspend` and turns `next_event` into a `Flow`.
**Status.** The bindings generate (a snapshot is committed under `crates/privcord-ffi/bindings` and checked in CI). They are not compiled into the app yet, no Android `.so` has been built, and no ABI has been tested.
**Revisit if** UniFFI's async support makes the blocking wrapper unnecessary.
