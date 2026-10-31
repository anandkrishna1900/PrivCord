package com.duochat.app.ui

import android.graphics.Color as AndroidColor
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.duochat.app.data.AppSettings
import com.duochat.app.data.accentFill
import com.duochat.app.data.mixColors
import com.duochat.app.data.themeById

private val typography = Typography(
    headlineMedium = TextStyle(fontSize = 28.sp, fontWeight = FontWeight.SemiBold),
    headlineSmall = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 16.sp),
    bodyMedium = TextStyle(fontSize = 14.sp),
    labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium),
)

@Composable
fun DuoChatTheme(settings: AppSettings, content: @Composable () -> Unit) {
    val themed = themeById(settings.palette)
    val dark = themed?.dark ?: when (settings.theme) {
        "dark" -> true
        "light" -> false
        else -> isSystemInDarkTheme()
    }
    val accent = parseColor(settings.accent)
    val scheme = if (themed != null) {
        val t = themed
        val text = Color(t.text)
        val fill = Color(accentFill(t.accent))
        val base = if (t.dark) darkColorScheme() else lightColorScheme()
        base.copy(
            primary = fill,
            onPrimary = Color.White,
            primaryContainer = Color(t.accent).copy(alpha = if (t.dark) 0.26f else 0.16f),
            onPrimaryContainer = text,
            secondary = Color(t.accent),
            background = Color(t.bg),
            onBackground = text,
            surface = Color(t.surface),
            onSurface = text,
            surfaceVariant = Color(mixColors(t.surface, t.text, 0.10f)),
            onSurfaceVariant = Color(mixColors(t.text, t.bg, 0.30f)),
            error = if (t.dark) Color(0xFFFFB4AB) else Color(0xFFB3261E),
            outline = Color(mixColors(t.bg, t.text, 0.22f)),
        )
    } else if (dark) {
        darkColorScheme(
            primary = accent,
            onPrimary = Color.White,
            primaryContainer = accent.copy(alpha = 0.24f),
            onPrimaryContainer = Color(0xFFE6E4FF),
            secondary = Color(0xFF8FD5CC),
            background = Color(0xFF0E1116),
            onBackground = Color(0xFFE6E8EC),
            surface = Color(0xFF14181F),
            onSurface = Color(0xFFE6E8EC),
            surfaceVariant = Color(0xFF1D232C),
            onSurfaceVariant = Color(0xFFA8B0BC),
            error = Color(0xFFFFB4AB),
            outline = Color(0xFF3A424E),
        )
    } else {
        lightColorScheme(
            primary = accent,
            onPrimary = Color.White,
            primaryContainer = accent.copy(alpha = 0.14f),
            onPrimaryContainer = Color(0xFF1B1B27),
            secondary = Color(0xFF0F766E),
            background = Color(0xFFF5F5F7),
            onBackground = Color(0xFF14161A),
            surface = Color(0xFFFFFFFF),
            onSurface = Color(0xFF14161A),
            surfaceVariant = Color(0xFFECEEF2),
            onSurfaceVariant = Color(0xFF525A66),
            error = Color(0xFFB3261E),
            outline = Color(0xFFD2D6DD),
        )
    }
    MaterialTheme(colorScheme = scheme, typography = typography, content = content)
}

private fun parseColor(value: String): Color = try {
    Color(AndroidColor.parseColor(value))
} catch (_: Exception) {
    Color(0xFF6366F1)
}
