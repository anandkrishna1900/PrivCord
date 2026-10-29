# DuoChat — Pause / Resume Notes

Last updated: 2026-10-29  
Project root: `C:\Users\anand\OneDrive\Desktop\Projects\Messaging app`

## Current goal

Build DuoChat from `prd.txt`: a private, exactly-two-user messenger for Windows (Tauri 2 + React) and Android (Kotlin/Compose), with Firebase cloud messaging and WebRTC direct fallback during cloud outages. Target ₹0/free-tier operation with honest security and limitation docs.

## Completed

### Shared protocol
- `packages/protocol/` complete: constants, message validation, cloud/peer frames, ordering/merge, connection states, manual `DUO1:` signaling, peer-auth challenges, P-256 JWK helpers, safety number.
- Verification: `npm --workspace @duochat/protocol run test` → **26 tests pass**.

### Windows desktop
- React/Vite frontend complete: auth, setup/access-denied, chat, composer, status ticks, connection badge, settings, manual connection dialog, responsive styles.
- Chat engine, Firebase cloud repository, encrypted SQLite/localStorage, outbox, WebRTC transport, identity/signing, notifications, clipboard, settings.
- Verification: `npm --workspace @duochat/desktop run typecheck`, `npm --workspace @duochat/desktop run build` passed.
- Added `apps/desktop/src/lib/outbox.test.ts`; `npm --workspace @duochat/desktop run test` → **8 tests pass**.
- Tauri Rust shell written: keyring `secret_get/set/delete`, SQLite + notification plugins, NSIS config, CSP.
- Generated Tauri icon set (including source `icon-source.png`). Generated Android launcher icons are also available under `apps/desktop/src-tauri/icons/android/` for reuse.
- **Tauri has not been compiled.** Rust/MSVC are still missing.

### Firebase backend
- Added `firebase/firebase.json`, `firebase/firestore.rules`, `firebase/firestore.indexes.json`.
- Rules enforce exactly-two-member allowlist, own-profile-only writes, message author/immutability, read-state ownership, signal addressing, and deny client writes to `config/access`.
- Added emulator tests in `firebase/rules-tests/`.
- Verification: **12 rules tests pass** against Firestore emulator.
- Added `scripts/seed-firebase.mjs`; `node --check` passes. It has **not** been run against a real Firebase project.
- Added root dev dependency `firebase-admin`.

### Android toolchain
- Installed JDK 21 at `C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot`.
- Installed Android SDK at `C:\Users\anand\AppData\Local\Android\Sdk` with `platform-tools`, `platforms;android-35`, `build-tools;35.0.0`.
- Downloaded Gradle 8.9 to `C:\Users\anand\AppData\Local\Temp\opencode\gradle-8.9`.
- Gradle wrapper 8.9 generated in `apps/android/` (`gradlew`, `gradlew.bat`, wrapper jar/properties).
- Build scaffolding plus full app:
  - `apps/android/settings.gradle.kts`
  - `apps/android/build.gradle.kts`
  - `apps/android/gradle.properties`
  - `apps/android/local.properties` (machine SDK path; ignored)
  - `apps/android/app/build.gradle.kts`
  - `apps/android/app/proguard-rules.pro`
- Fixed `buildConfigField` type error by making `buildConfigString` an extension on `ApplicationDefaultConfig`; added `CONVERSATION_ID` BuildConfig field.
- Added `lifecycle-runtime-ktx`, `lifecycle-viewmodel-ktx`, and `kotlinx-coroutines-android`.

### Android app
- Complete Kotlin/Compose implementation under `apps/android/app/src/main/java/com/duochat/app/`:
  - `DuoChatApp.kt`, `MainActivity.kt`, `AppConfig.kt`
  - `data/` — `Models.kt`, `Preferences.kt`, `CloudRepository.kt`, `MessageStore.kt`, `local/DuoDatabase.kt`
  - `security/` — `AndroidIdentity.kt`, `SignatureCodec.kt`, `LocalCrypto.kt`
  - `p2p/` — `WebRtcTransport.kt` (non-trickle ICE), `PeerSession.kt`, `ManualSignal.kt`
  - `engine/ChatEngine.kt` — cloud subscriptions, outbox/backoff, presence, P2P offer/answer, manual signaling, read receipts
  - `notifications/` — `DuoNotifications.kt`, `DuoMessagingService.kt`
  - `ui/` — `AppViewModel.kt`, `Theme.kt`, `StatusScreens.kt`, `ChatScreen.kt`, `SettingsDialog.kt`, `ManualConnectDialog.kt`
- Manifest + resources added: `AndroidManifest.xml`, `strings.xml`, `colors.xml`, `themes.xml` (light/night), `ic_notification.xml`, launcher mipmaps copied from `apps/desktop/src-tauri/icons/android/`, adaptive round icon.
- Manual connection supports `DUO1:` code create/paste, QR display (ZXing), and QR scanning via journeyapps.
- **Verification: `.\gradlew.bat :app:assembleDebug` → BUILD SUCCESSFUL**; APK at `apps/android/app/build/outputs/apk/debug/app-debug.apk` (~62 MB).
- **`:app:lintDebug` → 0 errors** (remaining warnings are dependency versions and launcher-icon shape/folder hints).
- Not yet installed or run on a device/emulator (no adb device attached), and no Firebase config supplied yet.

## Android build/version decisions already made

- Package/namespace/applicationId: `com.duochat.app`
- AGP `8.7.3`, Gradle `8.9`, Kotlin `2.0.21`, Compose compiler plugin `2.0.21`
- KSP `2.0.21-1.0.28`
- compileSdk/targetSdk `35`, minSdk `26`
- Firebase BOM `33.7.0`
- Room `2.6.1`, Compose BOM `2024.12.01`
- WebRTC `io.github.webrtc-sdk:android:125.6422.07`
- ZXing `com.journeyapps:zxing-android-embedded:4.3.0`
- Firebase config can come from `google-services.json` when present, otherwise manual `FirebaseOptions` from `local.properties` keys:
  - `firebase.apiKey`
  - `firebase.applicationId`
  - `firebase.projectId`
  - `firebase.messagingSenderId`
  - `firebase.storageBucket`
  - `duochat.emulatorHost` (for Auth 9099 / Firestore 8080)
  - `turn.url`, `turn.username`, `turn.credential`

## Next steps — resume here

### 1. Android build is complete

Rebuild with:

```powershell
$env:JAVA_HOME="C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot"
Set-Location "C:\Users\anand\OneDrive\Desktop\Projects\Messaging app\apps\android"
.\gradlew.bat :app:assembleDebug --console=plain
```

### 2. Android implementation reference

Implemented package layout under `apps/android/app/src/main/java/com/duochat/app/`:

- `DuoChatApp.kt` — Firebase manual init/emulator setup, notification channel.
- `MainActivity.kt` — Compose host, lifecycle visibility callbacks.
- `ui/` — login, setup/access-denied, chat, composer, settings, manual-connection/QR dialogs, theme.
- `ui/AppViewModel.kt` — auth/access state, engine lifecycle, UI state.
- `data/Models.kt`, `data/Preferences.kt`, `data/CloudRepository.kt`, `data/MessageStore.kt`.
- `data/local/DuoDatabase.kt`, entities/DAOs.
- `security/AndroidIdentity.kt` — EC P-256 Android Keystore key; public JWK; sign challenge; verify peer signatures.
- `security/SignatureCodec.kt` — DER ↔ raw P1363; base64url.
- `security/LocalCrypto.kt` — AES-GCM local message/outbox encryption.
- `p2p/WebRtcTransport.kt` — PeerConnection/DataChannel, non-trickle ICE.
- `p2p/PeerSession.kt` — hello/proof/auth_ok, message/ack/read frames, safety number.
- `notifications/` — FCM service + local notification helper.
- `app/src/main/AndroidManifest.xml`
- `app/src/main/res/values/strings.xml`, `themes.xml`
- `app/src/main/res/mipmap-*` — reuse generated icons from `apps/desktop/src-tauri/icons/android/`.

Protocol compatibility requirements:

- Message text max 4,000 code points; wire max 16,000 bytes.
- Message sort key: `clientCreatedAt`, then `messageId`.
- Transport values: `cloud` or `p2p`.
- Peer auth string: `duochat-peer-auth-v1\n{conversationId}\n{uid}\n{deviceId}\n{nonceSelf}\n{noncePeer}`.
- Peer signatures are sent base64url of raw 64-byte P1363 (`r||s`). Convert Android Keystore DER signatures to raw before sending; accept both when verifying.
- Manual codes: `DUO1:` + base64url(JSON) with fields `v`, `kind`, `conversationId`, `fromUid`, `fromDeviceId`, `publicKeyJwk`, `sdp`, `nonce`, `createdAt`.
- Safety number algorithm must match `packages/protocol/src/safetyNumber.ts` exactly:
  - thumbprint input JSON key order: `{"crv":"P-256","kty":"EC","x":"...","y":"..."}`
  - SHA-256 hex each key, sort the two hex strings, join with `|`, SHA-256 again
  - six groups of five digits from 3-byte big-endian values modulo 100000.

Android behavior to preserve:

- Exactly two authorized accounts from `config/access`; outsiders denied.
- Cloud normal path; local encrypted outbox; queue offline; retry with backoff; dedupe by `messageId`.
- P2P keeps working if cloud goes down after connection; do not tear down an existing DataChannel because cloud health polling fails.
- Automatic signaling through Firestore only when cloud is available; manual signaling works without cloud.
- Require safety-number confirmation before sending direct messages for manually keyed peers.
- Show delivery states `QUEUED/SENT/DELIVERED/READ/FAILED`.
- Mark cloud-read messages through the peer `readStates` watermark.
- No E2EE claim; local storage is encrypted, transport is TLS/DTLS, authorized project access can read cloud data.

### 3. Verify Android on a device/emulator

Provide Firebase values in `apps/android/local.properties` (keys listed above) or add `google-services.json`, then:

```powershell
& "C:\Users\anand\AppData\Local\Android\Sdk\platform-tools\adb.exe" install -r `
  "apps\android\app\build\outputs\apk\debug\app-debug.apk"
& "C:\Users\anand\AppData\Local\Android\Sdk\platform-tools\adb.exe" shell am start `
  -n com.duochat.app/.MainActivity
```

Smoke test: sign in with an allowlisted account, verify access denial for a third account, send/receive via cloud, kill cloud connectivity and exercise manual `DUO1:` connect with QR, confirm safety number, verify queued messages drain, and check notification permission/preview behavior.

### 4. Verify Windows Tauri build

Rust/MSVC still needed:

```powershell
winget install --id Rustlang.Rustup --exact --silent --accept-source-agreements --accept-package-agreements
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --silent --accept-source-agreements --accept-package-agreements --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
rustup default stable-x86_64-pc-windows-msvc
```

Then:

```powershell
Set-Location "C:\Users\anand\OneDrive\Desktop\Projects\Messaging app"
npm --workspace @duochat/desktop run tauri:info
npm --workspace @duochat/desktop run tauri:build
```

Verify Tauri capability `sql:default` covers `load/select/execute/close`; adjust `apps/desktop/src-tauri/capabilities/default.json` if not.

### 5. Write required docs

Missing docs referenced by the UI:

- `README.md`
- `docs/DEPLOYMENT.md`
- `docs/ARCHITECTURE.md`
- `docs/SECURITY.md`
- `docs/P2P_PROTOCOL.md`
- `docs/OUTAGE_RECOVERY.md`
- `docs/FREE_TIER.md`
- `docs/LIMITATIONS.md`

Must document Firebase setup, two-account allowlist seeding, rules deploy, emulator usage, Tauri/Android builds, TURN optionality, no E2EE, FCM limitations, and free-tier assumptions.

## Commands and current status

```powershell
# Protocol
npm --workspace @duochat/protocol run test        # 26 pass

# Desktop
npm --workspace @duochat/desktop run test         # 8 pass
npm --workspace @duochat/desktop run typecheck    # last run passed
npm --workspace @duochat/desktop run build        # last run passed

# Root
npm test                                          # should pass now
npm run typecheck                                 # should pass
```

Firestore rules tests normally use:

```powershell
Set-Location "C:\Users\anand\OneDrive\Desktop\Projects\Messaging app\firebase\rules-tests"
npm run test:emulator
```

If `emulators:exec` misbehaves in this terminal, use two steps:

```powershell
# Terminal 1
Set-Location "C:\Users\anand\OneDrive\Desktop\Projects\Messaging app\firebase\rules-tests"
npx firebase emulators:start --config ../firebase.json --only firestore --project demo-duochat

# Terminal 2
Set-Location "C:\Users\anand\OneDrive\Desktop\Projects\Messaging app\firebase\rules-tests"
$env:FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
npx vitest run
```

Last status: **12 rules tests pass**, emulator stopped, port 8080 free.

## Important files

- `prd.txt` — authoritative requirements.
- `packages/protocol/src/` — shared wire protocol and security helpers.
- `apps/desktop/src/lib/engine.ts` — desktop orchestration; useful reference for Android behavior.
- `apps/desktop/src/lib/cloud.ts` — exact Firestore field contract.
- `apps/desktop/src/lib/p2p.ts` — desktop WebRTC behavior.
- `firebase/firestore.rules` — deployed security model.
- `firebase/rules-tests/test/rules.test.ts` — rules coverage.
- `scripts/seed-firebase.mjs` — owner-managed allowlist setup.
- `apps/desktop/src-tauri/tauri.conf.json` — Tauri config, icons now present.
- `apps/desktop/src-tauri/capabilities/default.json` — permissions to verify.
- `apps/android/` — complete Android app; builds to `app-debug.apk`.

## Known issues / gaps

- No real Firebase project or credentials; no real cloud or cross-device P2P test yet.
- Firebase rules currently allow device fields `publicKeyJwk`, `createdAt`, `lastSeenAt`. **If Android writes an FCM token to the device document, extend `validDeviceDoc` and rules tests to allow `fcmToken`.**
- FCM token/service wiring alone cannot deliver true background notifications without a trusted notifier (Cloud Function on a billing plan or self-hosted service). Document this limitation or add a free-tier-compatible notifier strategy.
- Desktop engine/frontend have not run against Firebase emulators or a real WebRTC peer.
- Android compiles but has not been installed or runtime-tested on a device/emulator.
- Android expects Firebase config from `local.properties`/`google-services.json`; none is present.
- Android does not write an FCM token; push handling only renders data-payload notifications if a trusted sender is added later.
- Tauri has not been compiled; missing Rust and MSVC Build Tools.
- No git repository is initialized in this folder.
- `npm test` previously failed because desktop had no tests; that is fixed by `outbox.test.ts`.
- Root `package.json` has an `allowScripts` allowlist; npm may warn about new install scripts after dependency changes.

## Restart checklist

1. Read this file and `prd.txt`.
2. Run `git status` only if a repo is initialized; otherwise ignore.
3. Confirm `java -version`, `adb`, and Android SDK still exist.
4. Rebuild Android with the wrapper and confirm `app-debug.apk`.
5. Configure Firebase and run the Android smoke test on a device/emulator.
6. Then install Rust/MSVC, verify Tauri, and write docs.
