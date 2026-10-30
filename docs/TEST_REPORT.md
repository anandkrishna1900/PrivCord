# Test & Verification Report

## 1. Automated Test Suites Execution

### TypeScript / Protocol & Desktop Tests
- **Package `@duochat/protocol`**: 12 test suites, **106 passed**, 3 skipped (100% pass rate).
  - `advancedFeatures.test.ts`: Verified group epoch encryption/decryption, eviction key isolation, BLE mesh multi-hop routing, deduplication, TTL decrements, and file sharing chunking with SHA-256 verification.
  - `e2ee.test.ts`: Verified X3DH + Double Ratchet forward secrecy.
  - `recovery.test.ts`: Verified 12-word BIP-39 mnemonic derivation.
  - `connectivity.test.ts` & `signaling.test.ts`: Verified sealed blob relays and connection logic.
- **Package `@duochat/desktop`**: 7 test suites, **55 passed** (100% pass rate).
  - Outbox, settings, BLE framing (27 tests), BLE link, killswitch, and live relay client pub/sub tests.

### Android JVM Test Suite
- **Android App Unit Tests (`apps/android`)**:
  - `AndroidMeshRouterTest`: Tested packet consumption, multi-hop forwarding, TTL decrementing, anti-loop deduplication, and store-carry-forward.
  - `SecureChannelTest`: Tested P-256 ephemeral ECDH handshakes, replay rejection, tamper rejection, and interop with TypeScript vectors.
  - `BleFramingTest`: Tested 20-512 byte chunking and reassembly.
  - `RelayInteropTest`: Tested Nostr & self-hosted relay interop.
  - **Results**: 14 test classes, **75 tests passed** (100% pass rate).

---

## 2. Platform Build Verification

### Android Debug APK
- Built via Gradle 8.9 / AGP 8.7.3:
  - **Path**: `apps/android/app/build/outputs/apk/debug/app-debug.apk`
  - **Size**: ~61.1 MB
  - **Status**: Successful (Zero build errors).

### Desktop Web Bundle
- Built via Vite & TypeScript:
  - **Path**: `apps/desktop/dist/`
  - **Status**: Successful (Zero typecheck or bundling errors).

---

## 3. Physical Device Verification Guidelines

For multi-device BLE Mesh verification:
1. Deploy `app-debug.apk` onto 3 physical Android devices (Device A, Device B, Device C).
2. Space Device A and Device C apart so they are out of direct BLE range (~20-30 meters or obstructed).
3. Place Device B between Device A and Device C.
4. Send an encrypted message from Device A to Device C. Observe Device B relaying the ciphertext packet and Device C successfully decrypting and acknowledging delivery.
