package com.duochat.app.notifications

import com.duochat.app.data.SettingsRepository
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class DuoMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        // DuoChat does not persist FCM tokens; there is no trusted push sender yet.
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val data = remoteMessage.data
        val text = data["text"] ?: remoteMessage.notification?.body ?: return
        val senderName = data["senderName"] ?: "Your friend"
        val messageId = data["messageId"] ?: System.currentTimeMillis().toString()
        val settings = SettingsRepository(applicationContext).settings.value
        DuoNotifications.showIncomingPush(
            context = applicationContext,
            messageId = messageId,
            senderName = senderName,
            text = text,
            settings = settings,
        )
    }
}
