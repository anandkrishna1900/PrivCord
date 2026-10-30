# DuoChat — Verification & Test Report

**Date**: October 2026  
**Status**: All automated suites passing

---

## 1. Test Execution Summary

| Test Suite | Package / Target | Tests Run | Result | Evidence |
|---|---|---|---|---|
| **Protocol Suites** | `@duochat/protocol` | 85 tests | **PASS (85/85)** | `vitest run` |
| ↳ `recovery.test.ts` | BIP-39 & P-256 scalar derivation | 17 tests | **PASS** | 128-bit entropy, 12 words, checksum check, domain separation |
| ↳ `killswitch.test.ts`| Plan generator & truthful report | 18 tests | **PASS** | App-wide & per-chat step execution & status accounting |
| ↳ `e2ee.test.ts` | X3DH & Double Ratchet | 16 tests | **PASS** | Out-of-order, tamper detection, replay defense, skip bounds |
| ↳ `message/ordering/auth` | Packet encoding & signaling | 34 tests | **PASS** | Message structures & sequence tracking |
| **Desktop Suites** | `@duochat/desktop` | 27 tests | **PASS (27/27)** | `vitest run` |
| ↳ `killSwitch.test.ts`| Desktop executor & storage | 10 tests | **PASS** | Queue wipe, cache wipe, partial failure handling |
| ↳ `outbox/settings/etc`| Client operations | 17 tests | **PASS** | Outbox retries, settings persistence, clipboard |
| **Desktop Typecheck** | `@duochat/desktop` | TypeScript 5.8 | **PASS** | `tsc --noEmit` zero errors |
| **Desktop Build** | `@duochat/desktop` | Vite 6.4 production build | **PASS** | Production bundles generated |
| **Android Compile** | `:app:compileDebugKotlin` | Gradle 8.11 / Kotlin 2.0 | **PASS** | Full Kotlin compilation successful |
| **Android Unit Tests**| `:app:testDebugUnitTest` | JUnit 4.13 | **PASS** | MessageMode & engine tests passing |

---

## 2. Key Test Vectors & Cryptographic Validation

1. **BIP-39 Mnemonic Checksum Integrity**:
   - Verified that swapping any two words fails validation.
   - Verified that non-wordlist words fail validation.
   - Verified that phrases containing fewer or greater than 12 words are rejected.
2. **P-256 Public Point Derivation**:
   - Generator test vector: Scalar 1 produces NIST SP 800-186 base generator `(Gx, Gy)`.
   - Cross-checked against WebCrypto `crypto.subtle.generateKey` point calculations across multiple iterations with zero drift.
3. **Emergency Kill Switch Resiliency**:
   - Verified that individual conversation wipe preserves the root identity keys.
   - Verified that app-wide wipe purges root identity keys and returns client to onboarding state.

