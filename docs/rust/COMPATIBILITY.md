# Compatibility with the TypeScript and Kotlin implementations

The Rust code changes no algorithm, parameter or wire format. Everything below is inventoried from the existing source, not inferred from names, and is checked by tests that run against the TypeScript output (`docs/*-vectors.json`) and against what Rust produces (`docs/rust-vectors.json`, read by `packages/protocol/test/rustInterop.test.ts`).

## Inventory

| Area | Algorithm and parameters | Where checked |
|---|---|---|
| Recovery phrase | BIP-39 English, 12 words (128-bit entropy); seed = PBKDF2-HMAC-SHA-512, 2048 rounds, optional passphrase (NFKD) | 4 phrases incl. a passphrase with non-ASCII text; generation from fixed entropy |
| Key derivation | HKDF-SHA-256, salt `DuoChat-Recovery-Trust-v1`, info `duochat-derive-v1/identity-sign` and `/identity-agreement`; 32 bytes taken modulo the P-256 order | seed, material, private scalars and public points, uid, fingerprint all equal |
| Curves and signatures | P-256; ECDSA with SHA-256; signatures are the 64-byte `r‖s` form WebCrypto produces | TypeScript proofs and signatures verify in Rust; Rust signatures verify in WebCrypto |
| Identity proof | ECDSA over `duochat-identity-proof-v1\n` + canonical JSON of the ECDH key's `{crv,kty,x,y}` | both directions |
| uid | SHA-256 of `EC|P-256|` + x bytes + `|` + y bytes, lower-case hex | 3 identities |
| Contact card | `DUOID1:` + base64url of canonical JSON `{dh,name?,proof,sign,v}` | re-encoding a TypeScript card gives identical bytes |
| Safety number | SHA-256 of each signing key's `{"crv","kty","x","y"}` text, the two hex digests sorted and joined with `|`, hashed, 6 groups of 3 bytes mod 100000 | one vector, order-independent |
| Sealed blob | ephemeral ECDH, HKDF-SHA-256 (salt `duochat-seal-v1`, info `to|from`), AES-256-GCM (aad `to|from`, 12-byte IV, 16-byte tag), ECDSA over canonical JSON of `{v,to,from,epk,iv,ct}`; base64url JSON on the wire; max 64 KiB | TypeScript blobs open in Rust and the reverse; every kind of tampering refused |
| Mailbox | SHA-256 of `duochat-mailbox-v1|` + uid | vector |
| Secure channel | signed hello (fresh ECDH key, 16-byte nonce); two directional AES-256-GCM keys from HKDF-SHA-256 (salt `nLow|nHigh`, info `duochat-sc-v1|low->high` / `high->low`); IV = 4 zero bytes + 64-bit counter; aad `sc|n`; counters only move forward | fixed-key vectors: Rust decrypts TypeScript frames **and re-encrypts to identical bytes**; replay and impostor refused |
| Invite | 6 words from the BIP-39 list; PBKDF2-HMAC-SHA-256 150,000 rounds, salt `duochat-invite-v1`; mailbox = SHA-256(`duochat-invite-mailbox-v1|` + hex(seed)); key = HKDF(seed, same salt, info `key`) | mailbox and a TypeScript blob match; both exchange directions |
| Channel | mailbox = SHA-256(`duochat-channel-mailbox-v1|` + name); key = HKDF(digest, salt `duochat-channel-v1`, info `key`); tag `ch:` + first 16 hex | name normalisation cases, TypeScript message opens |
| Backup | `PRIVCORD-BACKUP1:` + base64url JSON; PBKDF2-HMAC-SHA-256 300,000 rounds over the NFKC passphrase; AES-256-GCM, aad `privcord-backup-v1`; iteration count accepted 100,000 to 2,000,000 | TypeScript backup opens in Rust and the reverse |
| Files | 12 KiB chunks, SHA-256 of the whole file, base64url, in-order chunks, 8 MiB cap, name and MIME sanitising | offer and all chunks re-created identically; properties for any size |
| Mesh | packet id = first 24 characters of the signature; TTL at most 7; 8 KB packet cap; 30 min carry; per-sender rate limit | simulations including flaky links |
| Canonical JSON | keys sorted by UTF-16 code unit, no spaces, JSON string escaping | 8 vectors |

## Deliberate differences

These are stricter than TypeScript, and none can affect a peer that behaves like the existing clients.

1. **Timestamps are whole numbers.** TypeScript accepts any finite positive number, including `1.5`. Rust requires an integer (milliseconds) at most 2^53. Real clients send `Date.now()`.
2. **Lone surrogates.** A JSON string containing an unpaired surrogate escape (`\ud800`) parses in JavaScript but not in Rust. Such a frame is dropped. Names and text from real clients are valid Unicode.
3. **Fractional numbers in canonical JSON are refused** instead of being formatted. Nothing that is signed or hashed contains one.
4. **Signatures are deterministic (RFC 6979)** where WebCrypto's are randomised. Both verify everywhere; only the bytes of a signature differ between runs of TypeScript and are fixed in Rust.
5. **Safety numbers check the key is on the curve.** TypeScript only checks the coordinates are long enough.
6. **Names in contact cards are cut to 40 UTF-16 units without splitting a character**; TypeScript's `slice` may leave half of a pair.
7. **Safety numbers take the signing keys**, as the apps use them (`contact.card.sign`).
8. **Mesh carry-queue eviction order** can differ in rare overflow cases (the TypeScript `Map` keeps the original position when a key is set again; the Rust version moves it to the end).

## Not yet compatible (not ported)

The legacy WebRTC handshake (`hello` / `auth_proof` / `auth_ok` in `peerAuth.ts`), group frames and the event log, file frames inside the engine, signaling frames and Nostr events, manual pairing codes, BLE chunk framing, and the kill-switch report. Until they are ported the Rust engine's links authenticate with the secure-channel handshake, which an old client does not speak; so **the Rust engine cannot yet talk to the existing apps over WebRTC**. The secure channel is the same protocol the apps already use over Bluetooth.

## Data

Nothing here reads existing user databases yet. The desktop SQLite schema (`localDb.ts`) and Android Room schema (`DuoDatabase.kt`) are mapped in [MIGRATION_MAP.md](MIGRATION_MAP.md); the importer is milestone M6b, and per the PRD no legacy persistence code may be removed before it passes on representative data.
