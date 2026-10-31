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
    /** A built-in colour theme (see Themes.kt), or "classic" for the system light/dark look with the accent picker. */
    val palette: String = CLASSIC_PALETTE,
    val notificationsEnabled: Boolean = true,
    val notificationPreviews: Boolean = true,
    /** Local nickname the single paired friend had before multi-contact; used once to migrate it. */
    val peerNickname: String = "",
    /** The name friends see on your invite and in groups. */
    val displayName: String = "",
    /**
     * Privacy: stay group-only with people you only meet through a group. You still get their group messages
     * and they get yours, but neither of you can start a direct chat unless you swap invites yourselves.
     */
    val groupOnly: Boolean = false,
    /** Relay messages for nearby phones over Bluetooth (multi-hop mesh). Off by default: it keeps Bluetooth busy. */
    val mesh: Boolean = false,
    /** Ask for fingerprint, face or the screen-lock PIN/pattern/password to open the app (when the phone has one). */
    val appLock: Boolean = true,
    /** Conversation ids (contact uid / group id) whose notifications are muted. */
    val mutedChats: Set<String> = emptySet(),
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
            .putString("palette", next.palette)
            .putBoolean("notificationsEnabled", next.notificationsEnabled)
            .putBoolean("notificationPreviews", next.notificationPreviews)
            .putString("peerNickname", next.peerNickname)
            .putString("displayName", next.displayName)
            .putBoolean("groupOnly", next.groupOnly)
            .putBoolean("mesh", next.mesh)
            .putBoolean("appLock", next.appLock)
            .putStringSet("mutedChats", next.mutedChats)
            .putString("network", next.network.toJson())
            .apply()
    }

    private fun load(): AppSettings {
        val theme = prefs.getString("theme", "system") ?: "system"
        val accent = prefs.getString("accent", ACCENTS.first().second) ?: ACCENTS.first().second
        return AppSettings(
            theme = if (theme in setOf("system", "dark", "light")) theme else "system",
            accent = if (Regex("^#[0-9a-fA-F]{6}$").matches(accent)) accent else ACCENTS.first().second,
            palette = (prefs.getString("palette", CLASSIC_PALETTE) ?: CLASSIC_PALETTE).let { if (it == CLASSIC_PALETTE || themeById(it) != null) it else CLASSIC_PALETTE },
            notificationsEnabled = prefs.getBoolean("notificationsEnabled", true),
            notificationPreviews = prefs.getBoolean("notificationPreviews", true),
            peerNickname = (prefs.getString("peerNickname", "") ?: "").trim().take(40),
            displayName = (prefs.getString("displayName", "") ?: "").trim().take(40),
            groupOnly = prefs.getBoolean("groupOnly", false),
            mesh = prefs.getBoolean("mesh", false),
            appLock = prefs.getBoolean("appLock", true),
            mutedChats = prefs.getStringSet("mutedChats", emptySet())?.toSet() ?: emptySet(),
            network = NetworkConfig.fromJson(
                prefs.getString("network", null),
                fallback = AppConfig.defaultNetworkConfig(),
            ),
        )
    }
}
