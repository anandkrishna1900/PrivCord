# DuoChat — Migration Plan

Date: 2026-10-30
Goal: evolve the current two-person Firebase messenger into the decentralized, multi-contact, E2EE platform specified in `prd.txt`, **without breaking the currently working build** (Android `assembleDebug` ✓, protocol/desktop tests ✓).

Rules observed during migration: inspect before modify; never break working builds silently; no destructive migration without notice; Firebase removal only after replacements are verified.

## Phase map (dependencies → deliverables)

### Phase 1 — Audit (COMPLETE)
Deliverables: `ARCHITECTURE_AUDIT.md`, `SECURITY_AUDIT.md`, this file, `IMPLEMENTATION_STATUS.md`.

### Phase 2 — Core architecture (transport-independent E2EE core) — **IN PROGRESS**
Build the shared, platform-agnostic core in `packages/protocol` (TypeScript is the reference core; both Tauri/Windows WebView and Android later consume the same wire formats):

1. `src/e2ee/` — X3DH key agreement + Double Ratchet (Signal protocol semantics), using **only standard primitives**: P-256 ECDH, HKDF-SHA-256, AES-256-GCM, SHA-256, ECDSA P-256. Includes: signed prekey verification, associated-data binding to verified identity fingerprints, out-of-order handling with bounded skipped-key store, replay rejection, session serialization for persistence. Automated tests for every property (see §Testing).
2. `src/e2ee/envelope.ts` — `DuoEnvelope`: the transport-independent encrypted packet (works unchanged over Firestore, WebRTC DataChannel, BLE frames, or relay storage). Envelope carries no plaintext, no stable identifiers beyond what routing requires.
3. `docs/E2EE_PROTOCOL.md` — protocol spec + honest deviations from Curve25519 (NIST P-256 via WebCrypto) and header encryption.
4. Audit-driven cleanup: identity verification helpers for "key change detected" state.

Deliberately **not** in Phase 2: no engine rewiring, no DB schema change — the core must be proven by tests first.

### Phase 3 — Secure one-to-one messaging (per contact)
1. Contact store: Room v2 on Android (`contacts`, `per-contact message/outbox FK ref`), object-store on desktop; **non-destructive migration** with schema versioning and on-failure data backup before destructive steps (user will be asked before any data-destroying migration runs).
2. Wire E2EE sessions into engines: cloud payloads become envelopes (`payload` replaces plaintext `text` — old plaintext columns migrated or allowed to expire; decision point: irreversible deletion of old plaintext will be flagged for user approval).
3. QR safety-number verification flow + verified/unverified states + key-change warnings.
4. New-contact pairing screen (replaces the build-time `CONVERSATION_ID` allowlist).

### Phase 4 — WebRTC hardening
Replaceable signaling interface (Firestore impl kept working + manual `DUO1:` already exists; target: Nostr/relay impl later); persistent `PairingRecord` usage on Android as done on desktop; ICE restart instead of teardown; TURN configuration surfaced honestly (routes labeled TURN-relayed vs direct); background reconnection via WorkManager where feasible.

### Phase 5 — Bluetooth transport (Android first)
BLE GATT central/peripheral with rotating 16-bit service UUID mask + rotating hashed advertisement IDs; explicit runtime permissions (API 31+ `BLUETOOTH_SCAN/CONNECT/ADVERTISE` + location never required for our mask); same `DuoEnvelope` frames; MTU negotiation; foreground service with `connectedDevice|dataSync` rationale for Android 14 requirements; battery modes. Windows Bluetooth support comes via Tauri plugin only after Android works — must be scheduled honestly (no API exists in WebView; requires Rust additions).

### Phase 6 — Mesh routing
Packet format: version, type, sender/session routing hint (opaque), TTL/hops, expiry, frag/reassembly ids; dedup by packet hash LRU; relay participation settings (opt-in, storage cap, rate cap, battery mode, pause, clear queues); store-carry-forward queue with expiry; Anti-crowdsourced-fake-participation honesty: relays must run DuoChat-compatible code (documented, no OS accessory dependence).

### Phase 7 — Automatic routing
`MessageMode`: AUTOMATIC / BLUETOOTH_ONLY / INTERNET_ONLY with strict no-silent-fallback rules; route indicators (Direct BLE / BLE Mesh / Direct WebRTC / TURN-relayed / Relay / Waiting); dedupe across transports by `messageId` (existing invariant).

### Phase 8 — Groups
Sender-key–style group encryption evaluated against audited designs (actual plan: per-member ratchet sessions for ≤ ~20 members, documented scaling limits; a true sender-keys implementation is deferred and documented — **no custom insecure scheme**). Membership transitions, admin permissions, group key rotation.

### Phase 9 — Files
Chunked authenticated encrypt-then-transfer; per-transfer random key wrapped by the message session; chunk hashing, resume, cancel, quota; BLE chunk pacing priority vs text.

### Phase 10 — Background operation
Foreground service with realistic justification, boot receiver for queue restore, battery-optimization guidance screen, Doze-safe retries; honest documentation of OEM variability.

### Phase 11 — UI/UX
Full contact/group screens, route indicators, copy message (both platforms), Android IME fix (root cause: bottomBar `navigationBarsPadding().imePadding()` combined without explicit inset consumption; fix: explicit `consumeWindowInsets`/correct single-source inset chain + `contentWindowInsets` reconciliation, to be verified on device).

### Phase 12 — Firebase removal
Sequence: E2EE on → new contact model works → local delivery acceptable → replace Auth with device identity (or optional user-hosted signaling) → replace Firestore signaling → archive rules → **stop**: confirm builds/lints/tests with firebase dependency removed, then remove. Old cloud data: read-only archive option; deletion requires explicit user approval (irreversible).

### Phase 13 — Testing/hardening
Unit (crypto, protocol), integration (two engines in-memory talking over fake transports — enables mesh/replay/failure scenarios without real devices), device matrix for BLE/IME, security review checklist vs `SECURITY_AUDIT.md` threat table, performance/battery profiling.

## Testing strategy (applies from Phase 2)
- Protocol unit tests via Vitest (Node webcrypto is a real WebCrypto implementation; invalidates the "can't test crypto in Node" concern).
- Scenario A–J from `prd.txt` mapped:
  - A/B (BLE) → device tests (Phase 5+) — cannot be unit-tested; documented as physical-device tests.
  - C/D/E/H/J → engine integration tests with fake cloud/transport (achievable without devices once Phase 3 core lands).
  - F → chunk-transfer integration test.
  - G → relay test: assert relay can hold/forward envelope bytecode but no function exists to decrypt without session state.
  - I → multi-contact/group integration test.

## Data migration strategy (protecting existing users)
1. Android Room: v1 → v2 additive migration (new tables/cols, backfilled from v1 data). v1 messages/outbox preserved; **no automatic deletion**.
2. Desktop localDb: additive columns; plaintext-history local data stays until E2EE replaces storage; cloud plaintext remains until Phase 12 archive step (user approval required for irreversible deletion).
3. No re-keying of at-rest data required (LocalCrypto scheme unchanged).

## Risk register
| Risk | Mitigation |
|---|---|
| E2EE wiring breaks existing two-person flows | Land core + tests first; add engine integration behind envelope version negotiation; keep legacy non-E2EE `.text` path readable for old data |
| BLE permissions UX failures | Runtime-permission flow + diagnostics screen (Phase 11 troubleshooting) |
| Group scheme not audited | Per-member ratchets for small groups by default (documented limits); sender-keys only after peer review |
| Firebase removal leaves push broken | Push is already decorative; phase it out first (Phase 12, step 1) |
| Tauri shell unverified (no Rust/MSVC) | Desktop verification remains user-environment-dependent; documented in status docs |
