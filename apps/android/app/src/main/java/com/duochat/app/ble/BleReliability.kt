package com.duochat.app.ble

/*
 * The timing rules both Bluetooth radios follow, kept free of Android so they are unit-tested.
 */

/**
 * Android quietly ignores an app that starts scanning more than 5 times in 30 seconds (the scan "succeeds" but finds
 * nothing), across all of the app's scanners. Every scan start in the app asks this first and waits if told to.
 */
class ScanLimiter(private val maxStarts: Int = 4, private val windowMs: Long = 30_000L) {
    private val starts = ArrayDeque<Long>()

    /** How long to wait before a scan may start at [now] (0: start now, and it is counted). */
    @Synchronized
    fun reserve(now: Long): Long {
        while (starts.isNotEmpty() && now - starts.first() >= windowMs) starts.removeFirst()
        if (starts.size < maxStarts) {
            starts.addLast(now)
            return 0
        }
        return starts.first() + windowMs - now
    }

    companion object {
        /** The one limiter for the whole app (the platform's limit is per app, not per scanner). */
        val shared = ScanLimiter()
    }
}

/** Waits that grow after each failure (1 s, 2 s, 4 s ... up to [maxMs]) and start over after a success. */
class Backoff(private val baseMs: Long = 1_000L, private val maxMs: Long = 30_000L) {
    private var failures = 0

    fun next(): Long {
        val wait = minOf(maxMs, baseMs shl minOf(failures, 20))
        failures++
        return wait
    }

    fun reset() {
        failures = 0
    }
}

/**
 * Retries for one chunk the radio would not take right now ("busy" is common while the stack is still sending the last
 * one). A short, growing pause each time; after [maxTries] the link is treated as broken.
 */
class BusyRetry(private val maxTries: Int = 8, private val stepMs: Long = 25L) {
    private var tries = 0

    /** The pause before trying again, or null when it is time to give up. */
    fun next(): Long? {
        if (tries >= maxTries) return null
        tries++
        return stepMs * tries
    }

    fun reset() {
        tries = 0
    }
}

object BleTimeouts {
    /** A connection attempt that has not called back by now never will on some phones. */
    const val CONNECT_MS = 12_000L

    /** Connected but not ready to carry messages (packet size, services, subscription) by now: start over. */
    const val SETUP_MS = 15_000L

    /** Some phones never report the agreed packet size: carry on with the default after this. */
    const val MTU_MS = 2_500L
}
