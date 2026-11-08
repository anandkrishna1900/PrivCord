# ADR-005: Desktop through the existing Tauri Rust process
**Decision.** Host the engine in the Tauri application and expose typed commands and events; React keeps only UI state.
**Status.** Not started (milestone M7). The Tauri shell is excluded from the workspace for now because it has its own lockfile.
