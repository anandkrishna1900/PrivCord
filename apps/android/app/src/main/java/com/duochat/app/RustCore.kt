package com.duochat.app

/**
 * The Rust core (crates/privcord-ffi) inside this build. [status] is what Settings > About shows, so a tester can see at
 * a glance whether the native library is present and works on this phone.
 */
object RustCore {
    val status: String by lazy {
        try {
            "v${uniffi.privcord_ffi.coreVersion()} · self-test ${uniffi.privcord_ffi.selfTest()}"
        } catch (t: Throwable) {
            // UnsatisfiedLinkError when the library for this CPU is not in the APK (a local build without the native step).
            "not available (${t.javaClass.simpleName})"
        }
    }
}
