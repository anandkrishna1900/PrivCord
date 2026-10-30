import java.util.Base64
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) {
        file.inputStream().use { load(it) }
    }
}

fun setting(name: String, fallback: String = ""): String =
    (localProperties.getProperty(name) ?: System.getenv(name) ?: fallback).trim()

// Release signing comes only from the environment (CI secrets or your shell); nothing is committed.
// Without it, `assembleRelease` produces an UNSIGNED apk that must not be distributed.
val releaseKeystore: File? =
    System.getenv("DUOCHAT_KEYSTORE_PATH")?.let { file(it) }
        ?: System.getenv("DUOCHAT_KEYSTORE_B64")?.takeIf { it.isNotBlank() }?.let { encoded ->
            layout.buildDirectory.file("release.keystore").get().asFile.also {
                it.parentFile.mkdirs()
                it.writeBytes(Base64.getMimeDecoder().decode(encoded))
            }
        }

fun com.android.build.api.dsl.ApplicationDefaultConfig.buildConfigString(name: String, value: String) {
    val escaped = value.replace("\\", "\\\\").replace("\"", "\\\"")
    buildConfigField("String", name, "\"$escaped\"")
}

android {
    namespace = "com.duochat.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.duochat.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        buildConfigString("CONVERSATION_ID", setting("duochat.conversationId", "duo"))
        buildConfigString("TURN_URL", setting("turn.url"))
        buildConfigString("TURN_USERNAME", setting("turn.username"))
        buildConfigString("TURN_CREDENTIAL", setting("turn.credential"))
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = releaseKeystore
                storePassword = System.getenv("DUOCHAT_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("DUOCHAT_KEY_ALIAS")
                keyPassword = System.getenv("DUOCHAT_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            signingConfig = signingConfigs.findByName("release")
            // Minification is off on purpose: it has not been tested on a device (WebRTC, Room, reflection).
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += setOf(
                "META-INF/AL2.0",
                "META-INF/LGPL2.1",
                "META-INF/LICENSE*",
                "META-INF/NOTICE*",
            )
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.10.0")
    implementation("androidx.fragment:fragment-ktx:1.8.5")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // WebSocket client for the signaling relay and Nostr relays.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    implementation("io.github.webrtc-sdk:android:125.6422.07")
    implementation("com.google.zxing:core:3.5.3")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    testImplementation("junit:junit:4.13.2")
    // Real org.json for JVM unit tests (the android.jar one is a stub); reads docs/ble-vectors.json.
    testImplementation("org.json:json:20240303")
}
