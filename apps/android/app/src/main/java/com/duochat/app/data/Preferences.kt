package com.duochat.app.data

import android.content.Context
import com.duochat.app.AppConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class AppSettings(
    val theme: String = "system",
    val accent: String = ACCENTS.first().second,
    val notificationsEnabled: Boolean = true,
    val notificationPreviews: Boolean = true,
    /** Local nickname for the other person (never sent anywhere). */
    val peerNickname: String = "",
    val network: NetworkConfig = NetworkConfig(),
)

val ACCENTS: List<Pair<String, String>> = listOf(
    "Indigo" to "#6366F1",
    "Teal" to "#0D9488",
    "Rose" to "#E11D48",
    "Amber" to "#D97706",
    "Sky" to "#0284C7",
)

class SettingsRepository(context: Context) {
    private val prefs = context.applicationContext
        .getSharedPreferences("duochat.settings.v1", Context.MODE_PRIVATE)

    private val _settings = MutableStateFlow(load())
    val settings: StateFlow<AppSettings> = _settings.asStateFlow()

    fun update(patch: AppSettings.() -> AppSettings) {
        val next = _settings.value.patch()
        _settings.update { next }
        prefs.edit()
            .putString("theme", next.theme)
            .putString("accent", next.accent)
            .putBoolean("notificationsEnabled", next.notificationsEnabled)
            .putBoolean("notificationPreviews", next.notificationPreviews)
            .putString("peerNickname", next.peerNickname)
            .putString("network", next.network.toJson())
            .apply()
    }

    private fun load(): AppSettings {
        val theme = prefs.getString("theme", "system") ?: "system"
        val accent = prefs.getString("accent", ACCENTS.first().second) ?: ACCENTS.first().second
        return AppSettings(
            theme = if (theme in setOf("system", "dark", "light")) theme else "system",
            accent = if (Regex("^#[0-9a-fA-F]{6}$").matches(accent)) accent else ACCENTS.first().second,
            notificationsEnabled = prefs.getBoolean("notificationsEnabled", true),
            notificationPreviews = prefs.getBoolean("notificationPreviews", true),
            peerNickname = (prefs.getString("peerNickname", "") ?: "").trim().take(40),
            network = NetworkConfig.fromJson(
                prefs.getString("network", null),
                fallback = AppConfig.defaultNetworkConfig(),
            ),
        )
    }
}
