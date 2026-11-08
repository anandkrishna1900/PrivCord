# ADR-002: A small workspace
**Context.** The PRD warns against a crate per file and against over-engineering.
**Decision.** Six crates: `domain`, `crypto`, `ports`, `engine`, `storage`, `ffi`. Crypto and storage are separate crates because they have a different dependency footprint and a different review gate; the rest follow the PRD's layers. Dependencies point inward (domain depends on nothing platform-specific).
**Consequences.** Boundaries are enforced by Cargo. `adapters` is not a crate yet: adapters live in each platform's app until there is shared adapter code worth extracting.
**Revisit if** a crate grows past a few thousand lines of unrelated code, or an adapter is shared by two platforms.
