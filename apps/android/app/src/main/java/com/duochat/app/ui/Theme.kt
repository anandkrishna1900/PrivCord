package com.duochat.app.ui

import android.graphics.Color as AndroidColor
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.duochat.app.R
import com.duochat.app.data.AppSettings
import com.duochat.app.data.accentFill
import com.duochat.app.data.mixColors
import com.duochat.app.data.themeById

/*
 * The look: a quiet, warm-neutral ground (paper by day, soft charcoal by night), ink-dark text, one accent used only
 * for what you act on and what you sent, and Figtree, a friendly geometric sans, for every word. Surfaces step by
 * tone, not by shadow; corners are generous and consistent.
 */

@OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
private fun figtree(weight: Int) = Font(
    R.font.figtree,
    weight = FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
)

private val Figtree = FontFamily(figtree(400), figtree(500), figtree(600), figtree(700), figtree(800))

private fun style(size: Int, line: Int, weight: Int, tracking: Double = 0.0) = TextStyle(
    fontFamily = Figtree,
    fontSize = size.sp,
    lineHeight = line.sp,
    fontWeight = FontWeight(weight),
    letterSpacing = tracking.em,
)

private val typography = Typography(
    displaySmall = style(34, 40, 800, -0.025),
    headlineLarge = style(30, 36, 800, -0.02),
    headlineMedium = style(26, 32, 700, -0.015),
    headlineSmall = style(22, 28, 700, -0.01),
    titleLarge = style(20, 26, 700, -0.005),
    titleMedium = style(16, 22, 600),
    titleSmall = style(14, 20, 600),
    bodyLarge = style(16, 23, 400),
    bodyMedium = style(14, 20, 400),
    bodySmall = style(12, 16, 400, 0.005),
    labelLarge = style(14, 20, 600, 0.005),
    labelMedium = style(12, 16, 600, 0.01),
    labelSmall = style(11, 14, 500, 0.02),
)

private val shapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(24.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

private fun mix(a: Color, b: Color, t: Float) = Color(mixColors(a.toArgb(), b.toArgb(), t))

/** Every surface role from three colours (ground, card, text), so built-in palettes and the default share one recipe. */
private fun scheme(dark: Boolean, bg: Color, card: Color, text: Color, accent: Color): ColorScheme {
    val fill = Color(accentFill(accent.toArgb()))
    val base = if (dark) darkColorScheme() else lightColorScheme()
    val muted = mix(text, bg, if (dark) 0.36f else 0.40f)
    val step = { t: Float -> mix(bg, text, t) }
    return base.copy(
        primary = fill,
        onPrimary = Color.White,
        primaryContainer = mix(bg, accent, if (dark) 0.22f else 0.14f),
        onPrimaryContainer = if (dark) mix(accent, Color.White, 0.55f) else mix(accent, Color.Black, 0.45f),
        secondary = if (dark) mix(accent, Color.White, 0.35f) else fill,
        onSecondary = Color.White,
        secondaryContainer = mix(bg, accent, if (dark) 0.16f else 0.10f),
        onSecondaryContainer = text,
        tertiaryContainer = if (dark) Color(0xFF3A2F17) else Color(0xFFFBEFD3),
        onTertiaryContainer = if (dark) Color(0xFFF5DFA8) else Color(0xFF4A3608),
        background = bg,
        onBackground = text,
        surface = bg,
        onSurface = text,
        surfaceVariant = step(if (dark) 0.10f else 0.055f),
        onSurfaceVariant = muted,
        surfaceTint = Color.Transparent,
        surfaceBright = card,
        surfaceDim = step(if (dark) 0.02f else 0.06f),
        surfaceContainerLowest = card,
        surfaceContainerLow = mix(bg, card, 0.5f),
        surfaceContainer = card,
        surfaceContainerHigh = step(if (dark) 0.10f else 0.055f),
        surfaceContainerHighest = step(if (dark) 0.14f else 0.085f),
        inverseSurface = text,
        inverseOnSurface = bg,
        outline = step(if (dark) 0.22f else 0.18f),
        outlineVariant = step(if (dark) 0.12f else 0.09f),
        error = if (dark) Color(0xFFFF8A80) else Color(0xFFC62828),
        errorContainer = if (dark) Color(0xFF3B1715) else Color(0xFFFDE7E5),
        onErrorContainer = if (dark) Color(0xFFFFD7D2) else Color(0xFF5F1410),
    )
}

@Composable
fun DuoChatTheme(settings: AppSettings, content: @Composable () -> Unit) {
    val themed = themeById(settings.palette)
    val dark = themed?.dark ?: when (settings.theme) {
        "dark" -> true
        "light" -> false
        else -> isSystemInDarkTheme()
    }
    val colors = if (themed != null) {
        scheme(themed.dark, Color(themed.bg), Color(themed.surface), Color(themed.text), Color(themed.accent))
    } else if (dark) {
        scheme(true, Color(0xFF111214), Color(0xFF1A1B1E), Color(0xFFEDECE9), parseColor(settings.accent))
    } else {
        scheme(false, Color(0xFFF8F6F2), Color(0xFFFFFFFF), Color(0xFF1B1A18), parseColor(settings.accent))
    }
    MaterialTheme(colorScheme = colors, typography = typography, shapes = shapes, content = content)
}

/** Positive state (connected, online): one green that reads on both grounds. */
val Online = Color(0xFF22A06B)

private fun parseColor(value: String): Color = try {
    Color(AndroidColor.parseColor(value))
} catch (_: Exception) {
    Color(0xFF5B5BD6)
}
