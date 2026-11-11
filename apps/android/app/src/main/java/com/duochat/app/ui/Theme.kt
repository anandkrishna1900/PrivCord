package com.duochat.app.ui

import android.graphics.Color as AndroidColor
import androidx.compose.foundation.background
import androidx.compose.material.icons.filled.Lock
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
 * The look ("plum & apricot"): a warm paper ground by day and a warm near-black by night, ink text, and colour with
 * jobs. Plum is yours: your messages and the main action on a screen. Apricot is "new": unread counts and the reactions
 * you gave. Everything else (chips, the New chat button, secondary buttons) is ink on paper, so
 * the two colours keep their meaning. Figtree for every word; surfaces step by tone, not by shadow.
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
    // In the dark, the accent as text (links, text buttons) must be lighter than the fill to read on the ground:
    // lightened until it reaches 4.5:1. Filled things that carry white text (your bubbles) use LocalOwnFill.
    var readable = accent
    var i = 0
    while (dark && i < 20 && com.duochat.app.data.contrastRatio(readable.toArgb(), bg.toArgb()) < 4.5) {
        readable = mix(readable, Color.White, 0.1f)
        i++
    }
    val base = if (dark) darkColorScheme() else lightColorScheme()
    val muted = mix(text, bg, if (dark) 0.36f else 0.40f)
    val step = { t: Float -> mix(bg, text, t) }
    return base.copy(
        primary = if (dark) readable else fill,
        onPrimary = if (dark) mix(accent, Color.Black, 0.7f) else Color.White,
        primaryContainer = mix(bg, accent, if (dark) 0.22f else 0.14f),
        onPrimaryContainer = if (dark) mix(accent, Color.White, 0.55f) else mix(accent, Color.Black, 0.45f),
        secondary = if (dark) mix(accent, Color.White, 0.35f) else fill,
        onSecondary = Color.White,
        secondaryContainer = mix(bg, accent, if (dark) 0.16f else 0.10f),
        onSecondaryContainer = text,
        tertiary = Apricot,
        onTertiary = Color(0xFF2B1608),
        tertiaryContainer = if (dark) Color(0xFF3A2516) else Color(0xFFFCE6D6),
        onTertiaryContainer = if (dark) Color(0xFFFFD2B3) else Color(0xFF5A2A0C),
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
        scheme(true, Color(0xFF131112), Color(0xFF1C191B), Color(0xFFF1ECEA), parseColor(settings.accent))
    } else {
        scheme(false, Color(0xFFF7F3EE), Color(0xFFFFFFFF), Color(0xFF221C1F), parseColor(settings.accent))
    }
    val accent = themed?.let { Color(it.accent) } ?: parseColor(settings.accent)
    androidx.compose.runtime.CompositionLocalProvider(LocalOwnFill provides Color(accentFill(accent.toArgb()))) {
        MaterialTheme(colorScheme = colors, typography = typography, shapes = shapes, content = content)
    }
}

/** The deep accent behind white text: your own message bubbles and the brand mark (same colour in light and dark). */
val LocalOwnFill = androidx.compose.runtime.staticCompositionLocalOf { Color(0xFF7A3E73) }

/** Positive state (connected, online): one green that reads on both grounds. */
val Online = Color(0xFF2E9E6B)

/** "New": unread counts and your reactions. Ink text on it. */
val Apricot = Color(0xFFF2A65A)

private fun parseColor(value: String): Color = try {
    Color(AndroidColor.parseColor(value))
} catch (_: Exception) {
    Color(0xFF7A3E73)
}

/**
 * The mark: a plum tile (your private space) with an apricot seal in its corner. Drawn, so it follows the theme and
 * needs no image asset.
 */
@Composable
fun BrandMark(size: Int = 56) {
    val plum = LocalOwnFill.current
    androidx.compose.foundation.layout.Box(androidx.compose.ui.Modifier.size(size.dp)) {
        androidx.compose.foundation.layout.Box(
            androidx.compose.ui.Modifier.size((size * 0.86f).dp)
                .background(plum, RoundedCornerShape((size * 0.28f).dp)),
        ) {
            androidx.compose.material3.Icon(
                androidx.compose.material.icons.Icons.Filled.Lock, contentDescription = null, tint = Color.White,
                modifier = androidx.compose.ui.Modifier.align(androidx.compose.ui.Alignment.Center).size((size * 0.36f).dp),
            )
        }
        androidx.compose.foundation.layout.Box(
            androidx.compose.ui.Modifier.align(androidx.compose.ui.Alignment.BottomEnd).size((size * 0.36f).dp)
                .background(MaterialTheme.colorScheme.background, androidx.compose.foundation.shape.CircleShape)
                .padding((size * 0.05f).dp)
                .background(Apricot, androidx.compose.foundation.shape.CircleShape),
        )
    }
}

/**
 * The one text field style: a tonal fill, no outline, rounded; the label floats inside. The Android twin of the
 * desktop's fields. Takes the parameters the screens use (positional value and onValueChange first, like the M3 one).
 */
@Composable
fun DuoTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: androidx.compose.ui.Modifier = androidx.compose.ui.Modifier,
    label: (@Composable () -> Unit)? = null,
    placeholder: (@Composable () -> Unit)? = null,
    singleLine: Boolean = false,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    readOnly: Boolean = false,
    textStyle: TextStyle = MaterialTheme.typography.bodyLarge,
    keyboardOptions: androidx.compose.foundation.text.KeyboardOptions = androidx.compose.foundation.text.KeyboardOptions.Default,
    keyboardActions: androidx.compose.foundation.text.KeyboardActions = androidx.compose.foundation.text.KeyboardActions.Default,
    visualTransformation: androidx.compose.ui.text.input.VisualTransformation = androidx.compose.ui.text.input.VisualTransformation.None,
) {
    val fill = MaterialTheme.colorScheme.surfaceContainerHigh
    androidx.compose.material3.TextField(
        value = value, onValueChange = onValueChange, modifier = modifier, label = label, placeholder = placeholder,
        singleLine = singleLine, minLines = minLines, maxLines = maxLines, readOnly = readOnly, textStyle = textStyle,
        keyboardOptions = keyboardOptions, keyboardActions = keyboardActions, visualTransformation = visualTransformation,
        shape = RoundedCornerShape(16.dp),
        colors = androidx.compose.material3.TextFieldDefaults.colors(
            focusedContainerColor = fill,
            unfocusedContainerColor = fill,
            disabledContainerColor = fill,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
            disabledIndicatorColor = Color.Transparent,
            focusedLabelColor = MaterialTheme.colorScheme.onSurface,
            cursorColor = MaterialTheme.colorScheme.onSurface,
        ),
    )
}
