# DuoChat — Implementation Status

Date: 2026-10-30
Baseline before redesign: see `pause.md` and `docs/ARCHITECTURE_AUDIT.md`.

Verified state at time of audit:
- `npm --workspace @duochat/protocol run test` → 26 tests pass
- `npm --workspace @duochat/desktop run test` → 8 tests pass
- Android `:app:assembleDebug` + lint previously green (per `pause.md`, device install still pending)
- Firebase rules tests: 12 pass (emulator)

## Redesign progress ledger

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 1 | Audit | **DONE** | `ARCHITECTURE_AUDIT.md`, `SECURITY_AUDIT.md`, `MIGRATION_PLAN.md`, this file |
| 2 | Core architecture: E2EE core (X3DH + Double Ratchet), envelope, protocol docs | **DONE (core) / PENDING (platform wiring)** | `packages/protocol/src/e2ee/*`, `packages/protocol/test/e2ee.test.ts` (all green), `docs/E2EE_PROTOCOL.md` |
| 3 | Secure 1:1 messaging wired into engines (contacts store, key-change warnings) | NOT STARTED | — |
| 4 | WebRTC hardening (signaling interface, ICE restart, persistent pairing) | NOT STARTED | — |
| 5 | Bluetooth transport | NOT STARTED | — |
| 6 | Mesh routing | NOT STARTED | — |
| 7 | Automatic/Bluetooth-only/Internet-only modes | NOT STARTED | — |
| 8 | Groups | NOT STARTED | — |
| 9 | File sharing | NOT STARTED | — |
| 10 | Background operation | NOT STARTED | — |
| 11 | UI/UX (incl. Android IME fix, copy message) | **IME fix applied** (needs device verification) | `apps/android/.../ui/ChatScreen.kt` |
| 12 | Firebase removal | NOT STARTED (planned last; see migration plan) | — |
| 13 | Testing and hardening | Automated crypto/protocol tests live; device/physical tests pending | — |

## What was implemented and verified in this pass

1. **E2EE core** (`packages/protocol/src/e2ee/`):
   - Standard primitives only: P-256 ECDH, HKDF-SHA-256, AES-256-GCM, SHA-256, ECDSA P-256 prekey signatures (WebCrypto).
   - X3DH key agreement (identity key, signed prekey, one-time prekeys, FF-0xFF-prefixed KDF) with bundle signature verification.
   - Double Ratchet per Signal semantics (chain keys per direction, DH ratchet on new remote key, out-of-order with bounded skipped-key store, replay rejection, associated-data tamper binding).
   - `DuoEnvelope` transport-independent encrypted packet; sessions serialize/deserialize for persistence across restarts.
   - Test suite `packages/protocol/test/e2ee.test.ts` covering: agreement equality, 30-message bidirectional session, out-of-order, skip-limit expiry, tampered ciphertext + tampered AD rejection, replay rejection, session restore, bundle signature rejection. **All tests pass**, plus full protocol suite (35 tests total).

## Verification commands

```powershell
npm --workspace @duochat/protocol run test        # e2ee + protocol suites
npm --workspace @duochat/protocol run typecheck
npm --workspace @duochat/desktop run test         # existing suites unchanged
npm --workspace @duochat/desktop run typecheck
npm --workspace @duochat/desktop run build
# Android (needs JDK21 + Android SDK as per pause.md):
Set-Location apps/android; .\gradlew.bat :app:assembleDebug --console=plain
```

## Known gaps / honest notes

- Android IME fix is *code-complete* but **requires multi-device verification** (see MIGRATION_PLAN Phase 11); no emulator/device was attached in this session.
- Tauri shell still not compiled (missing Rust/MSVC toolchain — environment constraint, not a code issue).
- The TS E2EE core is the reference implementation; Android/desktop engines still use the legacy non-E2EE paths until Phase 3 wiring lands.
- No Firebase project/credentials exist; all cloud behavior so far is emulator-only.

## Next actions (recommended order)

1. Phase 3: contact store + engine wiring of `DuoEnvelope` over both existing transports.
2. Phase 4: signaling interface + persistent pairing on Android.
3. Phase 5/6: Bluetooth prototype on Android (requires physical devices for verification).
