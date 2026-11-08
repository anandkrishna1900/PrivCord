# ADR-009: X3DH and the Double Ratchet are ported, and not switched on

**Context.** `packages/protocol/src/e2ee/{x3dh,ratchet,envelope,groupCrypto}.ts` implement X3DH, a Double Ratchet,
envelopes and epoch-keyed group messages with their own tests. Searching the apps shows they are **not used**: the apps
encrypt with sealed blobs (one ECDH per message) and the secure channel. The first version of this ADR left them unported
to avoid porting code on speculation.

**Decision (revised).** The goal became "the entire TypeScript protocol package rewritten in Rust", so this code is ported
to `privcord-crypto::e2ee`, and checked against the TypeScript in both directions (`docs/e2ee-vectors.json`,
`rust-vectors.json`, `rustInterop.test.ts`). It is **not wired into the engine**: nothing calls it, so no message uses it.
Turning it on is still a protocol change that needs its own design and review.

**Consequences.**
* One behaviour is stricter than the TypeScript on purpose: decrypting is atomic, so a refused message cannot corrupt the
  ratchet (see `COMPATIBILITY.md`).
* If it is wired in, ratchet state must be persisted transactionally with the messages it protects (the PRD's
  ratchet-corruption risk); the engine's `Storage::apply` batches are the place for that. Nothing does this yet.
* It has had no independent cryptographic review. Port fidelity is not the same as a security review of the design.

**Revisit** when the product decides to adopt forward secrecy beyond the secure channel.
