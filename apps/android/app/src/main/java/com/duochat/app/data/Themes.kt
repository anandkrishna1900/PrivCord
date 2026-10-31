package com.duochat.app.data

import kotlin.math.pow

/**
 * Built-in colour themes, the same set as the desktop app (apps/desktop/src/lib/themes.ts). A theme is five
 * colours; everything else is derived so a theme cannot end up with unreadable text. "classic" is not in this
 * list: it is the original look that follows the system light/dark setting and the accent picker.
 */
data class ThemeDef(val id: String, val name: String, val dark: Boolean, val bg: Int, val surface: Int, val text: Int, val accent: Int)

const val CLASSIC_PALETTE = "classic"

val THEMES: List<ThemeDef> = listOf(
    ThemeDef("midnight", "Midnight", true, 0xFF0B1020.toInt(), 0xFF141B2F.toInt(), 0xFFE6E9F5.toInt(), 0xFF6C8CFF.toInt()),
    ThemeDef("graphite", "Graphite", true, 0xFF121212.toInt(), 0xFF1C1C1E.toInt(), 0xFFECECEC.toInt(), 0xFF6EA0F0.toInt()),
    ThemeDef("amoled", "AMOLED black", true, 0xFF000000.toInt(), 0xFF0D0D0D.toInt(), 0xFFF2F2F2.toInt(), 0xFFB57CFF.toInt()),
    ThemeDef("ocean", "Ocean", true, 0xFF08141C.toInt(), 0xFF0F2230.toInt(), 0xFFE3F2F8.toInt(), 0xFF1FA8CC.toInt()),
    ThemeDef("forest", "Forest", true, 0xFF0C1510.toInt(), 0xFF14231A.toInt(), 0xFFE6F2EA.toInt(), 0xFF3FB67C.toInt()),
    ThemeDef("sunset", "Sunset", true, 0xFF1A100C.toInt(), 0xFF2A1913.toInt(), 0xFFF8EBE3.toInt(), 0xFFF0783A.toInt()),
    ThemeDef("rose", "Rose", true, 0xFF1A0D13.toInt(), 0xFF2A1520.toInt(), 0xFFF8E8EF.toInt(), 0xFFE8447F.toInt()),
    ThemeDef("lavender", "Lavender", true, 0xFF13101F.toInt(), 0xFF1E1A31.toInt(), 0xFFECE8FA.toInt(), 0xFF9A7CF5.toInt()),
    ThemeDef("nord", "Nord", true, 0xFF2E3440.toInt(), 0xFF3B4252.toInt(), 0xFFECEFF4.toInt(), 0xFF5E9FB3.toInt()),
    ThemeDef("dracula", "Dracula", true, 0xFF282A36.toInt(), 0xFF343746.toInt(), 0xFFF8F8F2.toInt(), 0xFFA37CF0.toInt()),
    ThemeDef("solarized-dark", "Solarized dark", true, 0xFF002B36.toInt(), 0xFF073642.toInt(), 0xFFEEE8D5.toInt(), 0xFF2F95C9.toInt()),
    ThemeDef("paper", "Paper", false, 0xFFF6F1E7.toInt(), 0xFFFFFDF8.toInt(), 0xFF2B2620.toInt(), 0xFFB45F06.toInt()),
    ThemeDef("sky", "Sky", false, 0xFFEAF3FB.toInt(), 0xFFFFFFFF.toInt(), 0xFF10222E.toInt(), 0xFF1478C8.toInt()),
    ThemeDef("mint", "Mint", false, 0xFFE9F6F0.toInt(), 0xFFFFFFFF.toInt(), 0xFF10261C.toInt(), 0xFF14805A.toInt()),
    ThemeDef("solarized-light", "Solarized light", false, 0xFFFDF6E3.toInt(), 0xFFEEE8D5.toInt(), 0xFF073642.toInt(), 0xFF1F78B4.toInt()),
)

fun themeById(id: String): ThemeDef? = THEMES.firstOrNull { it.id == id }

private fun channel(c: Int, shift: Int) = (c shr shift) and 0xFF

/** [t] of the way from [a] to [b], per channel. */
fun mixColors(a: Int, b: Int, t: Float): Int {
    fun m(shift: Int) = (channel(a, shift) + (channel(b, shift) - channel(a, shift)) * t).toInt().coerceIn(0, 255)
    return (0xFF shl 24) or (m(16) shl 16) or (m(8) shl 8) or m(0)
}

private fun luminance(c: Int): Double {
    fun lin(v: Int): Double {
        val s = v / 255.0
        return if (s <= 0.03928) s / 12.92 else ((s + 0.055) / 1.055).pow(2.4)
    }
    return 0.2126 * lin(channel(c, 16)) + 0.7152 * lin(channel(c, 8)) + 0.0722 * lin(channel(c, 0))
}

/** WCAG contrast ratio, 1 to 21. */
fun contrastRatio(a: Int, b: Int): Double {
    val (hi, lo) = listOf(luminance(a), luminance(b)).sortedDescending()
    return (hi + 0.05) / (lo + 0.05)
}

/** Darken the accent until white text on it reaches 4.5:1, so filled buttons and own message bubbles stay readable. */
fun accentFill(accent: Int): Int {
    var fill = accent
    var i = 0
    while (i < 20 && contrastRatio(0xFFFFFFFF.toInt(), fill) < 4.5) {
        fill = mixColors(fill, 0xFF000000.toInt(), 0.08f)
        i++
    }
    return fill
}

fun mutedText(t: ThemeDef): Int = mixColors(t.text, t.bg, 0.42f)
