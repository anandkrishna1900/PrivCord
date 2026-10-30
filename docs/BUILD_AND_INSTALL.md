# Build & Installation Guide

## Android Application (Debug APK)
The debug APK includes multi-contact storage, Bluetooth mesh router, background service, file attachment capabilities, and transport mode selection.

### APK Artifact
- **Path**: `apps/android/app/build/outputs/apk/debug/app-debug.apk`
- **Package ID**: `com.duochat.app`
- **Compile SDK**: Android 35 (VanillaIceCream)
- **Minimum SDK**: Android 26 (Oreo)

### Install via ADB
Connect your Android device via USB with USB Debugging enabled:
```bash
adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
```

### Required Device Permissions
When prompted on Android 12+:
- **Nearby Devices / Bluetooth**: Required for BLE direct links and mesh packet relaying.
- **Notifications**: Required for incoming message alerts and the foreground service persistent notification.

---

## Desktop Application (Web & Tauri)

### Web App Bundle (Ready for Production / Browser Preview)
- **Path**: `apps/desktop/dist/`
- Run local preview server:
```bash
npm --workspace @duochat/desktop run preview
```

### Tauri Native Desktop Bundle
To build the native desktop executable (requires Rust and Cargo installed):
```bash
npm --workspace @duochat/desktop run tauri:build
```
The compiled binary will be placed in `apps/desktop/src-tauri/target/release/`.

---

## Self-Hosted Relay Server
To run the lightweight mailbox relay:
```bash
cd relay
npm install
node server.js
```
The relay listens on port `8787` by default (`ws://0.0.0.0:8787`).
