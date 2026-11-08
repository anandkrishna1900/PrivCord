# ADR-009: X3DH and the Double Ratchet are not ported yet
**Context.** `packages/protocol/src/e2ee/{x3dh,ratchet,envelope,groupCrypto}.ts` implement X3DH, a Double Ratchet, envelopes and group keys with their own tests. Searching the apps shows they are **not used**: the apps encrypt with sealed blobs (one ECDH per message) and the secure channel. The PRD's required tests mention X3DH and ratchets.
**Decision.** Port only what the apps run. Do not port unused protocol code on speculation. If the product adopts X3DH or a ratchet later, it is a protocol change that needs its own design, review and vectors, and the existing TypeScript tests are the starting point.
**Consequences.** There is no ratchet state to persist transactionally yet, so the PRD's ratchet-corruption risk does not apply to this code today.
**Revisit** when the product decides to adopt forward secrecy beyond the secure channel.
