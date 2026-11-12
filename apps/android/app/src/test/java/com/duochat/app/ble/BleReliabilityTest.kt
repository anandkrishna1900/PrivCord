package com.duochat.app.ble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BleReliabilityTest {
    @Test
    fun scanStartsStayUnderAndroidsLimit() {
        val limiter = ScanLimiter(maxStarts = 4, windowMs = 30_000)
        // Four starts in a row are fine.
        for (t in listOf(0L, 1_000, 2_000, 3_000)) assertEquals(0L, limiter.reserve(t))
        // The fifth within 30 s must wait until the first one leaves the window.
        assertEquals(26_000L, limiter.reserve(4_000))
        assertEquals(1_000L, limiter.reserve(29_000))
        // Once it has, it may start (and is counted).
        assertEquals(0L, limiter.reserve(30_000))
        assertEquals(1_000L, limiter.reserve(30_000))
    }

    @Test
    fun backoffGrowsToItsCapAndStartsOver() {
        val b = Backoff(baseMs = 1_000, maxMs = 8_000)
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 8_000L), List(5) { b.next() })
        b.reset()
        assertEquals(1_000L, b.next())
    }

    @Test
    fun busyRetriesGiveUpAfterTheirLimit() {
        val r = BusyRetry(maxTries = 3, stepMs = 10)
        assertEquals(listOf(10L, 20L, 30L), List(3) { r.next() })
        assertNull(r.next())
        r.reset()
        assertEquals(10L, r.next())
    }
}
