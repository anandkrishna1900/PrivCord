package com.duochat.app

import android.app.Application
import com.duochat.app.notifications.DuoNotifications
import com.duochat.app.p2p.PeerConnectionFactoryHolder
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore

class DuoChatApp : Application() {
    override fun onCreate() {
        super.onCreate()
        DuoNotifications.ensureChannel(this)
        PeerConnectionFactoryHolder.initialize(this)
        initializeFirebase()
    }

    private fun initializeFirebase() {
        if (FirebaseApp.getApps(this).isEmpty() && AppConfig.manualFirebaseConfigured) {
            try {
                val builder = FirebaseOptions.Builder()
                    .setApiKey(AppConfig.firebaseApiKey)
                    .setApplicationId(AppConfig.firebaseApplicationId)
                    .setProjectId(AppConfig.firebaseProjectId)
                if (AppConfig.firebaseSenderId.isNotBlank()) {
                    builder.setGcmSenderId(AppConfig.firebaseSenderId)
                }
                if (AppConfig.firebaseStorageBucket.isNotBlank()) {
                    builder.setStorageBucket(AppConfig.firebaseStorageBucket)
                }
                FirebaseApp.initializeApp(this, builder.build())
            } catch (_: Exception) {
                // Configuration errors are surfaced on the setup screen.
            }
        }
        if (FirebaseApp.getApps(this).isEmpty()) {
            runCatching { FirebaseApp.initializeApp(this) }
        }
        AppConfig.firebaseReady = FirebaseApp.getApps(this).isNotEmpty()
        if (!AppConfig.firebaseReady) return
        if (AppConfig.emulatorHost.isBlank()) return
        runCatching {
            FirebaseAuth.getInstance().useEmulator(AppConfig.emulatorHost, 9099)
        }
        runCatching {
            FirebaseFirestore.getInstance().useEmulator(AppConfig.emulatorHost, 8080)
        }
    }
}
