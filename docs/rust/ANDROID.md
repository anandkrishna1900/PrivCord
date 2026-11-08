# Android: the Rust core inside the app

**Status: stage 1 of 2. The APK contains the Rust core and checks it at launch. The chat screens still run on the Kotlin
engine (`ChatEngine.kt`); they have not been moved onto the Rust engine yet.** Nothing here has been run on a phone or an
emulator by the author; CI builds it.

What stage 1 does:

* `cargo ndk` builds `privcord-ffi` for `arm64-v8a`, `armeabi-v7a`, `x86_64` and `x86` into `apps/android/app/src/main/jniLibs`
  (git-ignored). CI does this before Gradle and checks the APK holds all four libraries.
* The UniFFI Kotlin (`crates/privcord-ffi/bindings/kotlin`) is compiled into the app; JNA loads the library.
* `RustCore.status` runs `self_test()` on the phone (two identities, seal and open, in-memory SQLite) and shows the result
  in **Settings > About > Rust core**. "v0.1.0 · self-test ok" means the native library loaded and works on that device.
  "not available (...)" means the library for that CPU is missing from the APK.

Building locally needs the Android NDK, `cargo-ndk` and the four Rust targets; otherwise download the APK from the CI
run's `duochat-android-debug` artifact.

Stage 2 (not done): move identity, contacts, direct messages, groups and files in `ChatEngine.kt` onto `PrivcordEngine`,
with WebRTC, Bluetooth and the relay sockets staying as thin Kotlin adapters (for Bluetooth use `LinkKind::Layered`).
