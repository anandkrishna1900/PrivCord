package com.duochat.app.notifications

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/** The two things phones need before a chat app may run in the background: no battery optimisation, and autostart. */
object BackgroundHelp {
    fun batteryUnrestricted(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) == true

    /** Android's own one-tap "Let DuoCord run in the background?" prompt (falls back to the list of apps). */
    fun askBatteryUnrestricted(context: Context) {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        startFirst(context, listOf(direct, list))
    }

    /**
     * Phone makers' own "autostart" / background pages, which stop apps even with battery optimisation off. Tries the
     * known screens for this maker, then the app's info page.
     */
    fun openMakerBackgroundSettings(context: Context) {
        val maker = android.os.Build.MANUFACTURER.lowercase()
        val screens = buildList {
            fun add(pkg: String, cls: String) = add(Intent().setComponent(ComponentName(pkg, cls)))
            when {
                "vivo" in maker || "iqoo" in maker -> {
                    add("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")
                    add("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager")
                    add("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity")
                }
                "xiaomi" in maker || "redmi" in maker || "poco" in maker ->
                    add("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
                "oppo" in maker || "realme" in maker || "oneplus" in maker -> {
                    add("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")
                    add("com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity")
                }
                "huawei" in maker || "honor" in maker ->
                    add("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")
                "samsung" in maker ->
                    add("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity")
            }
            add(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
        }
        startFirst(context, screens)
    }

    private fun startFirst(context: Context, intents: List<Intent>) {
        for (i in intents) {
            if (runCatching { context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess) return
        }
    }
}
