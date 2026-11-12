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
| Legacy peer handshake | `hello` (uid, deviceId, both public keys, identity proof, 24-byte hex nonce), then `auth_proof` = ECDSA over `duochat-peer-auth-v1\n<context>\n<uid>\n<deviceId>\n<own nonce>\n<peer nonce>`, then `auth_ok`; trusted only once the peer proved itself and acknowledged ours; plain JSON frames afterwards | a complete TypeScript transcript (fixed nonces) is accepted in Rust, our proof verifies against TypeScript's challenge, and a Rust-made transcript passes the TypeScript checks |
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

## Also checked against the apps

| Area | What is checked | How |
|---|---|---|
| BLE chunk framing and rotating tags | chunking, every reassembly error, 64 KiB message, tags | `docs/ble-vectors.json` (made by an independent Python implementation and used by the TypeScript and Kotlin tests) |
| Pairing records, reconnect backoff, kill-switch plans and reports, manual connection codes | parse and validate cases, status table, delay table, every summary case, a run and a resume, every decode error | `docs/misc-vectors.json` made by `scripts/gen-misc-vectors.ts`; reproducible in CI |
| Nostr events | event id, BIP-340 signature, the rules for which relay messages become blobs | a TypeScript-made event verifies in Rust; a Rust-made event verifies in TypeScript (`rustInterop.test.ts`) |
| Group messages, files, channels, mesh | frame shapes, ordering, delivery, persistence | engine tests with real crypto and fake radios; two-hop mesh across three real engines through the facade |
| Delete for everyone, reactions, search, muting, backups | frames and rules; a backup made by the app's own `sealBackup` restores into the engine | engine tests (`social.rs`), `docs/legacy-fixtures.json` |
| Importers | both old databases on generated data | `docs/legacy-fixtures.json` (see [IMPORTERS.md](IMPORTERS.md)) |

Additional deliberate differences: the kill-switch runner takes a clock instead of reading one, and failure text is cut to 160 UTF-16 units without splitting a character; pairing timestamps are whole milliseconds like every other timestamp here; a relayed (`relay_blob`) frame is passed on at most twice, as in the apps.

## The pairwise end-to-end layer (X3DH, Double Ratchet, envelopes, group messages)

Ported to `crypto::e2ee` and checked both ways with `docs/e2ee-vectors.json` (made by `scripts/gen-e2ee-vectors.ts`) and
`rust-vectors.json`:

* every bundle verdict and error message; the responder derives exactly the secret and associated data the TypeScript
  initiator derived;
* TypeScript conversations (first message, replies, out-of-order delivery across a DH ratchet, a replayed position, a
  changed byte, a rewritten context) are read by Rust from the TypeScript's own session snapshots;
* a Rust X3DH session, its ratchet messages and a group message are read by the TypeScript code (`rustInterop.test.ts`);
* serialised sessions restore across languages.

Deliberate differences: **decrypting is atomic in Rust** (a refused message leaves the ratchet exactly as it was; the
TypeScript documents this but may leave a half-advanced state behind); ratchet public keys must have 32-byte
coordinates (the TypeScript only fails later); prekey ids are whole numbers; the group manager takes `(group_id, epoch)`
instead of the TypeScript's metadata object, which is only a carrier.

## The signaling clients

`engine::signaling` holds the relay client, the Nostr transport and the hub as state machines with no sockets. The relay
client is tested against the real `relay/server.js` (live delivery, stored delivery on subscribe, refusal of an oversize
blob); backoff (1 s doubling to 30 s), put timeouts (8 s), reconnect from the newest timestamp, de-duplication across
services and the Nostr acceptance rules are tested against small fake servers speaking the same protocols. One
difference: a hub whose services are all stopped reports `idle` (the TypeScript says `error`).

The Nostr client is also run against a real, independent relay (Python `nostr-relay`, which verifies BIP-340 signatures and event age): a stored event is handed over on subscribe, a live event reaches an online listener, and a damaged signature is not accepted (`tests/real_nostr.rs`). It was not run against public Nostr relays, whose policies differ, and the size-limit refusal is not tested for that reason. The refusal check also treats silence as refusal.

## Not yet compatible (not ported)

* Disappearing messages and translations were removed from the apps and are not in the engine.
* The WebRTC session, the raw sockets, the Bluetooth radio, the keychain and all UI stay in the platform adapters by design. The only application files still marked partly ported are `engine.ts` and `ChatEngine.kt`, which still start and drive the WebRTC and Bluetooth links, turn events into screen state, and show notices.

**What this means for talking to the existing apps.** The engine can authenticate with the existing apps over a WebRTC data channel (`LinkSecurity::TransportEncrypted`) and over Bluetooth (`LinkSecurity::Layered`: the secure-channel handshake, then the legacy peer handshake inside it, then encrypted frames; Bluetooth is what the TypeScript and Kotlin apps do today). `EngineEncrypted` (secure channel only) is not what the existing apps speak and is for engine-to-engine links.

**Run live against the real desktop app (Bluetooth only), until protocol v2.** `apps/desktop/e2e/rust-peer.mjs` connected the desktop app's browser build (the TypeScript engine) over a simulated Bluetooth radio to a separate Rust engine process. Protocol v2 (ADR-011) is not compatible with v1, and the TypeScript engine only speaks v1, so that test was removed. What the installed desktop app runs (its page driving the Rust engine through the shell) is covered by `apps/desktop/src/lib/hosted/e2e.test.ts` against two real Rust engine processes, which is CI-run.

What that does **not** cover: the WebRTC path against the live app, groups, files and channels against a live app, the real Bluetooth radio, and **any Kotlin app** (no emulator here; the Kotlin side is checked by shared vectors only).
## Data

Existing installs are brought over by `privcord-import` (desktop SQLite and Android Room). See [IMPORTERS.md](IMPORTERS.md) for what is checked, what is left behind and why, and what has not been tried on a real device.

## Addendum: user ids come from both public keys

A contact card proves only that its signing key signed its ECDH key. In v1 the user id was a hash of the ECDH key alone,
so anyone could build a valid card pairing someone else's ECDH key (and therefore their id) with their own signing key,
and appear under that id in channels, friend requests and group introductions.

The id is now `SHA-256("duocord-uid-v2\n" || ECDH key || "\n" || signing key)` (each key as `EC|P-256|x|y`), in Rust
(`identity::uid_from_keys`), TypeScript (`uidFromKeys`) and the legacy Kotlin code. A forged card gets its own,
different id.

Migration: on start (and when an identity is restored), the engine moves everything stored under a v1 id to the v2 id:
our own id, and each friend whose stored card shows the v1 id was theirs (`StorageOp::RenameUser`). Legacy imports and
backups made before this change are accepted under the v1 id and moved the same way. Groups are not migrated: their
signed history names members by v1 ids, and accepting those again would reopen the forgery. They are made again.
