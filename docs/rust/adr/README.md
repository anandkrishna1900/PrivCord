# Architecture decision records

Each record gives context, options considered, the decision, consequences and when to revisit it (PRD section 20).

| ADR | Decision |
|---|---|
| [001](ADR-001-embedded-engine.md) | Embedded Rust engine; no mandatory central application server |
| [002](ADR-002-workspace.md) | A small Cargo workspace of six crates |
| [003](ADR-003-engine-shape.md) | Synchronous core behind a thin async shell; ports are synchronous traits |
| [004](ADR-004-android-ffi.md) | Android through UniFFI-generated Kotlin bindings |
| [005](ADR-005-desktop.md) | Desktop through the existing Tauri Rust process |
| [006](ADR-006-storage.md) | One SQLite implementation behind an atomic batch port |
| [007](ADR-007-crypto-compat.md) | Preserve every algorithm, parameter and wire format |
| [008](ADR-008-adapters.md) | WebRTC and Bluetooth stay platform adapters |
| [009](ADR-009-x3dh-ratchet.md) | X3DH and the Double Ratchet are not ported until the apps use them |
| [010](ADR-010-unsafe-and-errors.md) | No `unsafe` outside the FFI crate; typed errors; no panics in library code |
