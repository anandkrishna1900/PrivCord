package com.duochat.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThemesTest {
    @Test
    fun `there are at least ten themes with unique ids and names, dark and light`() {
        assertTrue(THEMES.size >= 10)
        assertEquals(THEMES.size, THEMES.map { it.id }.toSet().size)
        assertEquals(THEMES.size, THEMES.map { it.name }.toSet().size)
        assertTrue(THEMES.any { it.dark })
        assertTrue(THEMES.any { !it.dark })
        assertNotNull(themeById("nord"))
        assertNull(themeById("nope"))
    }

    @Test
    fun `every theme is readable`() {
        for (t in THEMES) {
            assertTrue("${t.name} text on background", contrastRatio(t.text, t.bg) >= 7.0)
            assertTrue("${t.name} text on surface", contrastRatio(t.text, t.surface) >= 7.0)
            assertTrue("${t.name} muted text", contrastRatio(mutedText(t), t.bg) >= 3.5)
            assertTrue("${t.name} white on filled accent", contrastRatio(0xFFFFFFFF.toInt(), accentFill(t.accent)) >= 4.5)
            assertTrue("${t.name} accent on background", contrastRatio(t.accent, t.bg) >= 3.0)
        }
    }

    @Test
    fun `the Android and desktop theme tables agree`() {
        // The ids and names are the contract between the two apps (settings are per device, but the names are the same).
        val desktop = java.io.File("../../apps/desktop/src/lib/themes.ts").takeIf { it.exists() }
            ?: java.io.File("../../../apps/desktop/src/lib/themes.ts").takeIf { it.exists() }
            ?: java.io.File("../../../../apps/desktop/src/lib/themes.ts").takeIf { it.exists() }
        if (desktop == null) return // built outside the repo checkout: nothing to compare with
        val text = desktop.readText()
        for (t in THEMES) assertTrue("desktop has ${t.id}", text.contains("id: '${t.id}'"))
        assertEquals(THEMES.size, Regex("id: '[a-z-]+', name:").findAll(text).count())
    }
}
