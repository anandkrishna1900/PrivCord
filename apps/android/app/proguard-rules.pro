# Shrink only: unused library code goes, nothing is renamed, so anything found by name at run time still resolves.
-dontobfuscate

# Our own code and the Rust bindings: small, and partly reached by reflection (JNA callbacks, Room, Compose previews).
-keep class com.duochat.app.** { *; }
-keep class uniffi.** { *; }

# JNA reads Structure fields and proxies Library interfaces by reflection, and its native side calls back by name.
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-dontwarn java.awt.**
-dontwarn com.sun.jna.**

# WebRTC's native library calls back into these classes by name.
-keep class org.webrtc.** { *; }
# WebRTC 150+ calls into Java through Chromium's jni_zero glue, looked up by name from native code. The library ships no
# keep rules for it: without this, R8 renames or removes it and WebRTC aborts the process at start-up (no Java trace).
-keep class org.jni_zero.** { *; }
# Generated per app in Chromium builds, not shipped in the library; only referenced by a path WebRTC does not use.
-dontwarn org.jni_zero.JniZeroJni
# Any class with native methods: native code finds them by name.
-keepclasseswithmembernames,includedescriptorclasses class * { native <methods>; }
-dontwarn org.webrtc.**

-keep class com.google.zxing.** { *; }

# Release builds log nothing below warnings: info/debug lines name peers and mailboxes (prefixes of ids), which any app
# with log access (adb, OEM tools) could read.
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
}
