# ADR-011: Protocol v2 — post-quantum hybrid, per-frame ratchet, one-time keys, encrypted storage

**Context.** Protocol v1 (ADR-007) used P-256 only: live links relied on WebRTC DTLS or a per-link ECDH channel; offline
messages were sealed to the recipient's long-term key (no forward secrecy); the local database was plain SQLite. A
future quantum computer could decrypt recorded traffic, and a stolen long-term key opened every relayed message. The
owner asked for post-quantum encryption, a ratchet and stronger protection everywhere, and accepted that older app
versions would no longer interoperate.

**Decision.**
* **Hybrid everywhere.** Every key agreement combines P-256 ECDH with ML-KEM-768 (FIPS 203, RustCrypto `ml-kem`),
  joined by HKDF-SHA-256 over both secrets and a length-prefixed transcript (`crypto::pq::combine`).
* **Links** (`crypto::pq_channel`). Once a link is authenticated (any of the existing session kinds), both sides run a
  symmetric post-quantum handshake inside it: signed hellos with fresh P-256 and ML-KEM keys, mutual encapsulation.
  Frames then use one HMAC chain per direction: a new key per frame, old keys erased; lost frames may be skipped; the
  chain moves only for a genuine frame. Plaintext is padded to buckets. The contact counts as connected only when this
  is done (10 s, or the link is remade); plain frames are refused.
* **Offline** (`crypto::prekeys`, `engine::core::keys`). Each link hands the contact 10 one-time hybrid keys and a
  standing key (rotated weekly, kept 30 days). Text messages for someone offline are sealed (blob v2) to a one-time key,
  which the recipient erases after opening; everything else uses the standing key. v1 sealing is only for people never
  linked with, and refused from anyone keys were exchanged with.
* **Storage.** SQLCipher with a random 256-bit key in the OS key store, in its own slot. Older databases are encrypted
  in place; a key is only created when no encrypted database exists.
* This is a ratchet in the sense that matters for the threat (a new key per frame, erased keys, fresh keys per link and
  per offline message), not the Signal Double Ratchet: the existing `crypto::e2ee` port stays unused, because one
  ratchet state shared across relay and link paths can fall out of step and lose messages.

**Consequences.** Older app versions cannot talk to v2 apps. Each link costs one extra round trip and ~5 KB of
handshake; each relayed blob grows by ~1.5 KB (the ML-KEM ciphertext). The design has not had an independent
cryptographic review.

**Supersedes** the "no cryptographic change" rule of ADR-007 and the "not switched on" status of ADR-009 for the parts
above.
