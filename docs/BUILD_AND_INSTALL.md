# DuoChat — Build and Installation Guide

**Date**: October 2026

---

## 1. Prerequisites

- **Node.js**: >= 20.x LTS
- **Package Manager**: `npm`
- **Android SDK & JDK**: JDK 17 or JDK 21 with Android API 35 build-tools (for Android builds)
- **Rust Toolchain**: Rust >= 1.78 + MSVC/GCC (for Tauri desktop native packaging)

---

## 2. Desktop Application

### Development:
```bash
# Install dependencies across workspaces
npm install

# Run protocol tests
npm --workspace @duochat/protocol run test

# Run desktop tests & typecheck
npm --workspace @duochat/desktop run test
npm --workspace @duochat/desktop run typecheck

# Start local desktop development server
npm --workspace @duochat/desktop run dev
```

### Production Build:
```bash
npm --workspace @duochat/desktop run build
```

---

## 3. Android Application

### Debug Build & Tests:
```bash
cd apps/android

# Run unit tests
./gradlew :app:testDebugUnitTest --console=plain

# Compile Kotlin sources
./gradlew :app:compileDebugKotlin --console=plain

# Assemble Debug APK
./gradlew :app:assembleDebug --console=plain
```
Output APK is located at:
`apps/android/app/build/outputs/apk/debug/app-debug.apk`

