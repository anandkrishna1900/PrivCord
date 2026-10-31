package com.duochat.app.security

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockTest {
    private val now = 1_000_000L

    @Test
    fun `a fresh start always asks when the lock is on and available`() {
        assertTrue(AppLock.shouldLock(enabled = true, available = true, leftAt = 0L, now = now))
    }

    @Test
    fun `no lock when it is off or the phone has no screen lock`() {
        assertFalse(AppLock.shouldLock(enabled = false, available = true, leftAt = 0L, now = now))
        assertFalse(AppLock.shouldLock(enabled = true, available = false, leftAt = 0L, now = now))
    }

    @Test
    fun `coming back within the grace period does not ask again, after it does`() {
        assertFalse(AppLock.shouldLock(true, true, leftAt = now - 10_000, now = now))
        assertFalse(AppLock.shouldLock(true, true, leftAt = now - AppLock.GRACE_MS, now = now))
        assertTrue(AppLock.shouldLock(true, true, leftAt = now - AppLock.GRACE_MS - 1, now = now))
    }
}
