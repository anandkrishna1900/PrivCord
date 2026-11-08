# ADR-001: Embedded Rust engine, no central application server
**Context.** Business rules are duplicated in TypeScript (desktop, protocol package) and Kotlin (Android) and drift apart. PrivCord has no application server by design.
**Options.** (a) Keep two implementations and share test vectors; (b) a shared engine embedded in each app; (c) move logic to a server.
**Decision.** (b). The engine runs in-process on every platform; the relay stays an optional, separate signaling and store-and-forward helper.
**Consequences.** One place to fix a rule. Adds a native build to Android and a dependency on the Tauri Rust process on desktop. Out of scope: a web or WASM target.
**Revisit if** a platform appears that cannot host native code.
