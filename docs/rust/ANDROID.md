# Android: the Rust core inside the app

**Status: the Android app (`com.duochat.app`) runs only the Rust engine; the separate "rust" flavor and the classic Kotlin
engine build were removed. CI builds and unit-tests it. It has been run on real phones only lightly; Bluetooth, the mesh,
groups and long background use are not yet proven on hardware.** The Kotlin engine (`ChatEngine.kt`) has been deleted.

What stage 1 does:

* `cargo ndk` builds `privcord-ffi` for `arm64-v8a`, `armeabi-v7a`, `x86_64` and `x86` into `apps/android/app/src/main/jniLibs`
  (git-ignored). CI does this before Gradle and checks the APK holds all four libraries.
* The UniFFI Kotlin (`crates/privcord-ffi/bindings/kotlin`) is compiled into the app; JNA loads the library.
* `RustCore.status` runs `self_test()` on the phone (two identities, seal and open, in-memory SQLite) and shows the result
  in **Settings > About > Rust core**. "v0.1.0 · self-test ok" means the native library loaded and works on that device.
  "not available (...)" means the library for that CPU is missing from the APK.

Building locally needs the Android NDK, `cargo-ndk` and the four Rust targets; otherwise download the APK from the CI
run's `duochat-android-debug` artifact.

**Stage 2, first piece: the engine probe.** Settings > About > **Rust engine** starts a real Rust engine on the phone
against a throwaway database and Keystore slot, creates an identity, reads its card and snapshot, checks the secret
round-trips through the Android Keystore (`rustcore/KeystoreSecureStore.kt`), then deletes everything. "ok" means the
engine, its SQLite storage and the Keystore adapter work on that device. It never touches your real data. The chat
screens are still on the Kotlin engine.

**Stage 2, the Rust build flavor.** `./gradlew :app:assembleRustDebug` builds "DuoChat Rust" (app id `com.duochat.app.rust`),
which installs beside the classic app with its own data. Everything the screens do goes through `RustChatEngine`:
identity from the recovery phrase, contacts and six-word invites, messages, groups, files (with receive progress),
reactions, delete, search, backup and restore, channels, wipe, WebRTC links, relay and Nostr signaling (one connection per
mailbox), Bluetooth links (layered mode) and the Bluetooth mesh, manual connection codes (format `RUST1:`, so they only
work between two Rust builds), friend renaming, read marks for groups, "why isn't it connecting" hints (from the same
pure function as the classic app) and store-and-forward through mutual friends (inside the engine).

Known limits: only lightly run on real phones so far (CI compiles and unit-tests it). Old chats from the classic app come over by backup export and restore, because the two apps keep separate data.
File progress is shown while sending and while receiving. Manual codes need both people to confirm within a few seconds.

Stage 2 is done for the Rust flavor. What is left is proof and retirement, not porting: see the M7 and M9 plan.

## Phones on different networks (Wi-Fi to mobile data)

Two phones can only link directly when their networks allow it. Many mobile networks do not (the app says so on the chat
screen: "the two networks would not let a direct link through"). The fix is a TURN relay, which carries the encrypted
stream and sees only that you are talking, not what you say. Without one, text still arrives when store-and-forward is on,
but files and voice notes need the direct link.

Set one up in the app on **both** phones: Settings > Connection > TURN. Run your own with
[docs/turn-server](../turn-server/docker-compose.yml), or use a hosted TURN service. The credential is deliberately not
baked into the CI-built APK: anyone who can download or receive the APK could read it out.
