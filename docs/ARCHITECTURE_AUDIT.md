# DuoChat — Architecture Audit

Date: 2026-10-30
Scope: full repository audit performed before the redesign described in `prd.txt` (decentralized, multi-contact, BLE mesh + WebRTC platform).

## 1. Current system in one paragraph

DuoChat today is a **two-person messenger** with a mandatory Firebase cloud path and an optional WebRTC DataChannel peer-to-peer path. It ships as two apps — Windows desktop (Tauri 2 + React/TypeScript) and Android (Kotlin/Jetpack Compose) — sharing a TypeScript protocol package. There is **no Bluetooth implementation, no group support, no file transfer, and no end-to-end encryption of message content**.

## 2. Repository inventory

| Path | Role | State |
|---|---|---|
| `packages/protocol/` | Shared TS wire protocol: message validation, delivery states, peer-auth challenge, pairing (`PairingRecord`), P-256 JWK helpers, manual `DUO1:` signaling, safety number | 26 tests pass |
| `apps/desktop/` | Tauri 2 + React/Vite desktop app; chat engine, Firestore cloud repo, WebRTC `PeerTransport`, `LocalStore` (SQL plugin / localStorage), outbox | typecheck/build/test pass; **Tauri never compiled (no Rust/MSVC)** |
| `apps/android/` | Kotlin/Compose app; full parity of the two-person feature set; Room DB, Android Keystore identity, FCM service, WebRTC (libwebrtc) | `:app:assembleDebug` + lint pass; never run on a device; no Firebase config committed |
| `firebase/` | Firestore rules + emulator rules tests (12 pass), indexes | Rules enforce the two-member allowlist |
| `scripts/seed-firebase.mjs` | Seeds `config/access` allowlist, profiles, device keys | Syntax-checked only |
| `pause.md` | Work-in-progress log; accurate as of 2026-10-29 | — |

## 3. Firebase dependency inventory (audit result)

| Dependency | Actual responsibility today |
|---|---|
| Firebase Auth (`desktop useAuth.ts`, `android AppViewModel.kt`) | Account creation/sign-in; the allowlist gate is `config/access.memberIds`. **The only real identity primitive is an email account.** |
| Firestore (`cloud.ts`, `CloudRepository.kt`) | (a) message database for a single conversation, (b) WebRTC signaling (`conversations/{id}/signals`), (c) presence (`lastSeenAt`), (d) device key registry, (e) read-state watermarks |
| FCM (`DuoMessagingService.kt`) | Effectively decorative: token is never registered, no trusted notifier exists; `onMessageReceived` renders plaintext `data["text"]` |
| Firestore rules | Security boundary (client-side only protection), and hard-coded for exactly two members |

Conclusion for the redesign: all five responsibilities already have non-Firebase replacements planned (crypto identity, local encrypted DB + store-and-forward, signaling abstraction, BLE presence, push replacement strategies). Nothing depends on Firebase *infrastructure* beyond these five — removal is achievable, but the migration must preserve the "cloud outage resilience" the current outbox already provides.

## 4. Key technical limitations vs. the target architecture

### 4.1 Hardwired two-person model (everywhere)
- `firebase/`: rules require `memberIds.size == 2`.
- Android `CloudRepository.loadAccess` **throws unless exactly 2 members**.
- Android `ChatEngine` constructor takes a single `peerUid`; `ChatState` has singular `peerUid/peerProfile/peerTrust/safetyNumber`.
- Desktop `EngineDeps` takes a single `peerUid`; same singular state.
- Room `MessageEntity` has **no conversation/contact column**; one table row-set = one thread.
- `CONVERSATION_ID` is a compile-time `BuildConfig` constant (default `"duo"`).
- `PairingRecord` is a singleton-style record for one peer.
- UI copy ("Only the two approved accounts…") is hard-coded in several screens.

There is no contact store, no multi-thread routing, no per-recipient queue. This is the single largest structural blocker: the messaging core is not peer-indexed.

### 4.2 Transport model
- `TransportKind = 'cloud' | 'p2p'` only. No mesh, no relay, no transport abstraction — `ChatEngine` directly implements "P2P first, then Firestore write" with no pluggable route selection.
- WebRTC is functional but simplistic: non-trickle ICE, single DataChannel (`"duochat"`), offer/answer assumed as JSON frames, no ICE restart handling (a `failed` connection is torn down and renegotiated from scratch), no persistence of connection state across restarts. Cached peer keys (`peer.$uid.$deviceId` in plain SharedPreferences) survive restarts, but contacts/pairing records are not stored persistently on Android (the desktop `PairingRecord`/`pairing.ts` exists but desktop engine keeps state in `ChatState` only).
- Signaling is Firestore-coupled (`sendSignal`/`subscribeSignals`) plus the good `DUO1:` manual/QR path. No replaceable signaling interface exists.

### 4.3 Encryption
- **No E2EE.** Message `text` is uploaded to Firestore in plaintext (`toCloudPayload()` writes `text`). The P2P DataChannel relies solely on DTLS. Anyone with Firestore project access (the two authorized UIDs, the project owner, Google) can read history. The docs (`pause.md`) state this honestly ("No E2EE claim").
- Local-at-rest encryption exists on both platforms (AES-GCM via Android Keystore on Android; Tauri SQL plugin + `secureStore.ts` keyring on desktop) — this is good and must be preserved.
- P-256 ECDSA identity signing (`AndroidIdentity.kt`, `identity.ts`) with challenge/response peer auth and a deterministic safety number is solid and worth preserving; it is, however, *authentication* only, not message confidentiality.

### 4.4 Wireless capabilities
- No BLE code at all; Android manifest has **no Bluetooth permissions** (`BLUETOOTH_SCAN/CONNECT/ADVERTISE` missing), no foreground service types for connectivity. Min SDK 26 / target 35 means the modern (API 31+) permission model applies.
- No store-carry-forward between *devices* — the outbox is per-account local retry against the cloud only.

### 4.5 Features vs. target checklist
| Target capability | Exists today |
|---|---|
| Multiple contacts | ✗ (hardwired 2-person) |
| Groups | ✗ |
| E2EE | ✗ (transport DTLS only) |
| File transfer | ✗ (text only; `MessageType = 'text'`) |
| BLE direct/mesh | ✗ |
| WebRTC direct | ✓ (needs reconnection hardening + signaling abstraction) |
| Automatic transport selection | Partial (P2P-then-cloud heuristic, no modes) |
| Store-and-forward | Partial (local outbox + cloud retention; no mesh relay storage) |
| Background reception | Partial (FCM stub only; no BLE background service) |
| Verification (QR/safety number) | ✓ (DUO1: pairing, safety number, peer challenge) |
| Desktop app | ✓ (UI complete, Tauri shell unverified) |
| Notifications | Basic; plaintext previews |
| Copy message | ✓ desktop; Android has long-press menu |

## 5. Code quality observations

- Good: consistent validation style (`ValidationResult`), protocol versioning (`v:1` on frames), dedup by `clientMessageId`, honest UI status strings, tests for protocol edge cases, `allowBackup=false` + backup rules on Android, `usesCleartextTraffic=false`.
- Duplication: cloud/profile/presence/read-state logic is implemented twice (once per platform) with a TS "reference" engine; the Android ChatEngine (1124 lines) re-implements desktop `engine.ts` (≈1100 lines). Phase 2 must define the shared core first so entity behavior stops being re-derived per platform.
- Risky details to fix during migration: Room `exportSchema = false` (no migration history — v2 schema work must establish migrations properly and back up user data); `DuoDatabase.clearMessages()/clearOutbox()` wipe the whole thread regardless of future multi-conversation scoping; TURN credentials flow through `local.properties` → BuildConfig → SDP (acceptable, but must never be committed); hardcoded Google/Cloudflare STUN URLs.
- Android IME handling: the chat screen relies solely on `Modifier.navigationBarsPadding().imePadding()` on the Scaffold bottomBar with edge-to-edge enabled and no `consumeWindowInsets` reconciliation (background in `apps/android/manifest + ui/ChatScreen.kt`). Targeted root-cause fix is planned in Phase 11 (see MIGRATION_PLAN.md).

## 6. What must be preserved (working functionality)

1. `packages/protocol` message/ordering/dedup semantics (`clientCreatedAt` + `messageId` sort key, delivery-state ranking).
2. Manual `DUO1:` QR pairing + safety-number algorithm (cross-platform exact match requirements documented in `pause.md`).
3. Peer challenge/authentication protocol and local encrypted storage on both platforms.
4. Outbox semantics (queue offline, retry with backoff, dedupe, delivery states QUEUED/SENT/DELIVERED/READ/FAILED).
5. The desktop React UI structure and Android Compose UI shell (to be extended, not rewritten).

## 7. Platform-honesty notes (for the target architecture)

- Ordinary Bluetooth-enabled phones **cannot** participate in DuoChat mesh without running compatible relay software; the redesign must only count other DuoChat (or compatible relay) devices.
- WebRTC without TURN frequently fails across restrictive NATs; direct connectivity must never be claimed when relayed.
- Background reception is bounded by OS policy on Android (battery optimization, Doze, OEM task killers); "guaranteed background delivery" must not be promised.
