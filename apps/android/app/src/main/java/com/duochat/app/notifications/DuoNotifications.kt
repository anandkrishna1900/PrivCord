package com.duochat.app.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.duochat.app.MainActivity
import com.duochat.app.R
import com.duochat.app.data.AppSettings

object DuoNotifications {
    const val CHANNEL_ID = "messages"
    private const val CHANNEL_NAME = "Messages"
    private const val CHANNEL_DESCRIPTION = "New private messages from your DuoChat contact."

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = CHANNEL_DESCRIPTION
        }
        manager.createNotificationChannel(channel)
    }

    fun showNotice(context: Context, notice: com.duochat.app.engine.IncomingNotice, settings: AppSettings) {
        val body = if (notice.isMessage && !settings.notificationPreviews) "Open DuoChat to read it." else preview(notice.body)
        show(
            context = context,
            notificationId = notice.id.hashCode(),
            title = notice.title,
            body = body,
            settings = settings,
        )
    }

    private fun show(
        context: Context,
        notificationId: Int,
        title: String,
        body: String,
        settings: AppSettings,
    ) {
        if (!settings.notificationsEnabled) return
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        ensureChannel(context)
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            notificationId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(notificationId, notification)
        } catch (_: SecurityException) {
            // Notifications are best-effort.
        }
    }

    private fun preview(text: String): String {
        val single = text.replace(Regex("\\s+"), " ").trim()
        return if (single.length > 140) "${single.take(137)}…" else single
    }
}
