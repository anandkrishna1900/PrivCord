package com.duochat.app.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * After a reboot or an app update nothing would run until DuoCord is opened, so messages would wait. When "Keep running
 * in the background" is on, the background service starts again (and it starts the chat engine).
 */
class StartOnBoot : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val keepRunning = runCatching { com.duochat.app.data.SettingsRepository(context).settings.value.keepRunning }
            .getOrDefault(false)
        if (keepRunning) DuoBackgroundService.start(context)
    }
}
