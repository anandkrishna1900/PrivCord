package com.duochat.app.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.duochat.app.MainActivity
import com.duochat.app.R

/**
 * Android Foreground Service to maintain persistent background connectivity
 * for BLE mesh discovery and WebRTC/Signaling connection lifecycle.
 */
class DuoBackgroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureForegroundNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Starting a foreground service can be refused (permission, background-start limits, vendor rules). That must
        // never crash the app, and it must not repeat on every launch: give up and switch the setting off.
        try {
            val notification = buildForegroundNotification()
            when {
                // "Remote messaging" is the type for chat apps: unlike "data sync" (stopped after six hours a day from
                // Android 15), it has no daily limit and may start after a reboot.
                Build.VERSION.SDK_INT >= 34 -> startForeground(
                    NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
                )
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> startForeground(
                    NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                )
                else -> startForeground(NOTIFICATION_ID, notification)
            }
            // After the system killed the process (or after a reboot) nothing else starts the engine: this service does,
            // so messages keep arriving with no screen open.
            runCatching { com.duochat.app.engine.EngineHost.ensureStarted(application) }
        } catch (_: Throwable) {
            runCatching { com.duochat.app.data.SettingsRepository(applicationContext).update { copy(keepRunning = false) } }
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    /**
     * Only "data sync" (Android 10 to 13) has a time limit. Starting again from the background is not allowed then, so
     * stop cleanly; the engine keeps running until the system ends the process, and the next start brings it back.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf(startId)
    }

    private fun ensureForegroundNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java) ?: return
            val channel = NotificationChannel(
                SERVICE_CHANNEL_ID,
                "Background Connection",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Keeps DuoCord connected in the background so messages and mesh relays keep arriving."
                setShowBadge(false)
            }
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildForegroundNotification(): Notification {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, SERVICE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("DuoCord is active")
            .setContentText("Staying connected so your messages arrive")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    companion object {
        const val SERVICE_CHANNEL_ID = "duochat_service_channel"
        const val NOTIFICATION_ID = 9001

        fun start(context: Context) {
            val intent = Intent(context, DuoBackgroundService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
            } catch (_: Throwable) {
                // Not allowed right now: carry on without it.
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, DuoBackgroundService::class.java)
            context.stopService(intent)
        }
    }
}

