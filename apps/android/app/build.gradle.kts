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

fun com.android.build.api.dsl.ApplicationDefaultConfig.buildConfigString(name: String, value: String) {
    val escaped = value.replace("\\", "\\\\").replace("\"", "\\\"")
    buildConfigField("String", name, "\"$escaped\"")
}

if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
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

        buildConfigString("FIREBASE_API_KEY", setting("firebase.apiKey"))
        buildConfigString("FIREBASE_APPLICATION_ID", setting("firebase.applicationId"))
        buildConfigString("FIREBASE_PROJECT_ID", setting("firebase.projectId"))
        buildConfigString("FIREBASE_MESSAGING_SENDER_ID", setting("firebase.messagingSenderId"))
        buildConfigString("FIREBASE_STORAGE_BUCKET", setting("firebase.storageBucket"))
        buildConfigString("CONVERSATION_ID", setting("duochat.conversationId", "duo"))
        buildConfigString("EMULATOR_HOST", setting("duochat.emulatorHost"))
        buildConfigString("TURN_URL", setting("turn.url"))
        buildConfigString("TURN_USERNAME", setting("turn.username"))
        buildConfigString("TURN_CREDENTIAL", setting("turn.credential"))
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
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
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-auth")
    implementation("com.google.firebase:firebase-firestore")
    implementation("com.google.firebase:firebase-messaging")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    implementation("io.github.webrtc-sdk:android:125.6422.07")
    implementation("com.google.zxing:core:3.5.3")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    testImplementation("junit:junit:4.13.2")
}
