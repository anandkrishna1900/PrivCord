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
