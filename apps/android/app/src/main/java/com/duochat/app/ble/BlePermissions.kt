package com.duochat.app.ble

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/** Runtime permissions Bluetooth LE needs: scan/advertise/connect on Android 12+, location on 11 and older. */
object BlePermissions {
    fun required(sdk: Int = Build.VERSION.SDK_INT): Array<String> =
        if (sdk >= 31) {
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    fun granted(context: Context): Boolean =
        required().all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
}

/** Delay before the next automatic Bluetooth attempt: 15 s doubling to 120 s (searching drains the battery). */
fun bleReconnectDelayMs(attempt: Int): Long = minOf(120_000L, 15_000L shl minOf(maxOf(attempt, 0), 3))

/**
 * The main-thread handler both Bluetooth radios run their work on. Anything a radio call throws inside it (a vendor
 * Bluetooth stack, a permission revoked mid-way, a link that vanished) goes to [onError] instead of crashing the app;
 * Bluetooth starts on its own at launch, so an uncaught error there would crash the app on every launch.
 */
class SafeRadioHandler(private val onError: (Throwable) -> Unit) : android.os.Handler(android.os.Looper.getMainLooper()) {
    override fun dispatchMessage(msg: android.os.Message) {
        try {
            super.dispatchMessage(msg)
        } catch (t: Throwable) {
            android.util.Log.w("DuoChat", "Bluetooth call failed", t)
            runCatching { onError(t) }
        }
    }
}
