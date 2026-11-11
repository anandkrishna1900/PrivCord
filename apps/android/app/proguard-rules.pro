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
-dontwarn org.webrtc.**

-keep class com.google.zxing.** { *; }
