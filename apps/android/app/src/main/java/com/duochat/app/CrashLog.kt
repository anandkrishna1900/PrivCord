package com.duochat.app

import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Process
import android.os.SystemClock
import java.io.File

/**
 * Keeps the last crash on the phone (nowhere else), so the next launch can recover from it and the user can copy
 * the details to whoever is fixing it. Only the stack trace and the phone model are written: no messages, no names.
 */
object CrashLog {
    private fun file(context: Context) = File(context.filesDir, "last-crash.txt")

    /** A crash this soon after the app started is treated as a crash at start-up (one that could repeat on every launch). */
    private const val STARTUP_MS = 30_000L

    fun install(app: Application) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            record(app, error, thread.name)
            previous?.uncaughtException(thread, error)
        }
    }

    /** Writes [error] as the last crash. Also used for errors the app survived (the engine's background work). */
    fun record(context: Context, error: Throwable, where: String) {
        runCatching {
            val uptime = if (Build.VERSION.SDK_INT >= 24) SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime() else -1L
            file(context).writeText(
                "uptimeMs=$uptime\n" +
                    "DuoCord ${BuildConfig.VERSION_NAME} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) · " +
                    "${Build.MANUFACTURER} ${Build.MODEL} · $where\n\n" +
                    error.stackTraceToString().take(24_000),
            )
        }
    }

    /** What the last run crashed with, if it did. It stays until [clear] (the user has seen it), so a crash that repeats
     *  before the dialog is answered never loses the details. */
    class Report(val details: String, val radio: Boolean, val atStartup: Boolean)

    fun take(context: Context): Report? {
        val f = file(context)
        if (!f.exists()) return null
        val text = runCatching { f.readText() }.getOrNull()
        if (text.isNullOrBlank()) return null
        val uptime = text.lineSequence().firstOrNull()?.removePrefix("uptimeMs=")?.toLongOrNull() ?: -1L
        val details = text.substringAfter('\n')
        val radio = details.contains("bluetooth", ignoreCase = true) || details.contains("com.duochat.app.ble.")
        return Report(details, radio, atStartup = uptime in 0..STARTUP_MS)
    }

    fun clear(context: Context) {
        file(context).delete()
    }
}
