package com.duochat.app.engine

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.os.BatteryManager
import android.os.PowerManager
import androidx.core.content.ContextCompat
import uniffi.privcord_ffi.BackgroundPlanDto
import uniffi.privcord_ffi.BleScanDto
import uniffi.privcord_ffi.DeviceStateDto
import uniffi.privcord_ffi.NetworkKindDto
import uniffi.privcord_ffi.backgroundPlan
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The Android side of the shared background policy (privcord_domain::background): it reports the phone's state to
 * the Rust core and hands the decision to whoever acts on it (the Bluetooth mesh today). It listens only to rare system
 * broadcasts (charger, battery low/okay, power saver, Data Saver), never to every battery-level change.
 */
object BackgroundPolicy {
    private val DEFAULT = BackgroundPlanDto(internetSync = true, bulk = false, bleScan = BleScanDto.LOW_POWER)

    @Volatile var plan: BackgroundPlanDto = DEFAULT
        private set

    @Volatile private var foreground = false
    private var watching = false
    private var app: Context? = null
    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    fun addListener(listener: () -> Unit) { listeners.add(listener) }
    fun removeListener(listener: () -> Unit) { listeners.remove(listener) }

    @Synchronized
    fun watch(context: Context) {
        if (watching) return
        watching = true
        val appContext = context.applicationContext
        app = appContext
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
            addAction(Intent.ACTION_BATTERY_LOW)
            addAction(Intent.ACTION_BATTERY_OKAY)
            addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
            addAction(ConnectivityManager.ACTION_RESTRICT_BACKGROUND_CHANGED)
        }
        runCatching {
            ContextCompat.registerReceiver(appContext, object : BroadcastReceiver() {
                override fun onReceive(c: Context, intent: Intent) = refresh()
            }, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        }
        refresh()
    }

    /** The app came on screen or went off it. */
    fun setForeground(on: Boolean) {
        foreground = on
        refresh()
    }

    /** Reads the phone's state and asks the core again; tells listeners only when the decision changed. */
    fun refresh() {
        val context = app ?: return
        val next = runCatching { backgroundPlan(read(context)) }.getOrElse { DEFAULT }
        if (next == plan) return
        plan = next
        listeners.forEach { runCatching { it() } }
    }

    private fun read(context: Context): DeviceStateDto {
        val battery = context.getSystemService(BatteryManager::class.java)
        val level = battery?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.takeIf { it in 0..100 }
        val charging = battery?.isCharging ?: false
        val power = context.getSystemService(PowerManager::class.java)
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val network = when {
            cm?.activeNetwork == null -> NetworkKindDto.NONE
            cm.isActiveNetworkMetered -> NetworkKindDto.METERED
            else -> NetworkKindDto.UNMETERED
        }
        return DeviceStateDto(
            batteryPercent = level?.toUByte(),
            charging = charging,
            network = network,
            dataSaver = cm?.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED,
            powerSaver = power?.isPowerSaveMode ?: false,
            foreground = foreground,
        )
    }
}
