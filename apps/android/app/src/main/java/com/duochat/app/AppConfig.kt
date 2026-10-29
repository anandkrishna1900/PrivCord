package com.duochat.app

import org.webrtc.PeerConnection

object AppConfig {
    const val APP_VERSION = "0.1.0"

    val firebaseApiKey: String = BuildConfig.FIREBASE_API_KEY
    val firebaseApplicationId: String = BuildConfig.FIREBASE_APPLICATION_ID
    val firebaseProjectId: String = BuildConfig.FIREBASE_PROJECT_ID
    val firebaseSenderId: String = BuildConfig.FIREBASE_MESSAGING_SENDER_ID
    val firebaseStorageBucket: String = BuildConfig.FIREBASE_STORAGE_BUCKET
    val conversationId: String =
        BuildConfig.CONVERSATION_ID.ifBlank { "duo" }
    val emulatorHost: String = BuildConfig.EMULATOR_HOST

    val manualFirebaseConfigured: Boolean
        get() = firebaseApiKey.isNotBlank() &&
            firebaseApplicationId.isNotBlank() &&
            firebaseProjectId.isNotBlank()

    @Volatile
    var firebaseReady: Boolean = false

    val stunUrls: List<String> = listOf(
        "stun:stun.l.google.com:19302",
        "stun:stun.cloudflare.com:3478",
    )

    val turnUrl: String = BuildConfig.TURN_URL
    val turnUsername: String = BuildConfig.TURN_USERNAME
    val turnCredential: String = BuildConfig.TURN_CREDENTIAL

    fun iceServers(): List<PeerConnection.IceServer> {
        val servers = mutableListOf<PeerConnection.IceServer>()
        for (url in stunUrls) {
            servers += PeerConnection.IceServer.builder(url).createIceServer()
        }
        if (turnUrl.isNotBlank() && turnUsername.isNotBlank() && turnCredential.isNotBlank()) {
            for (url in turnUrl.split(',').map { it.trim() }.filter { it.isNotEmpty() }) {
                servers += PeerConnection.IceServer.builder(url)
                    .setUsername(turnUsername)
                    .setPassword(turnCredential)
                    .createIceServer()
            }
        }
        return servers
    }
}
