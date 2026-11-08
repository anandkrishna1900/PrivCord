# ADR-010: No `unsafe` outside the FFI crate, typed errors, no panics
**Decision.** Workspace lints forbid `unsafe_code` and deny `unwrap`, `expect` and `panic` in library code (tests exempt). Errors are enums (`thiserror`); the public API maps them to stable, redacted codes. `privcord-ffi` alone allows `unsafe`, only for generated scaffolding.
