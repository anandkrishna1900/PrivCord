package com.duochat.app.p2p

import org.json.JSONObject

/**
 * Liveness probe frames `{v:1, kind:'ping'|'pong', at:<ms>}` (packages/protocol/src/peerAuth.ts). While the
 * channel is authenticated each side pings every [PING_INTERVAL_MS], answers every ping with a pong carrying
 * the same `at`, and treats ANY inbound frame as proof of life. Silence for [DEAD_LINK_MS] means the link is lost.
 */
object Liveness {
    const val PING_INTERVAL_MS = 4_000L
    const val DEAD_LINK_MS = 14_000L

    class Frame(val kind: String, val at: Long)

    fun ping(at: Long): JSONObject = JSONObject().put("v", 1).put("kind", "ping").put("at", at)

    fun pong(at: Long): JSONObject = JSONObject().put("v", 1).put("kind", "pong").put("at", at)

    /** Same acceptance rule as `parsePeerFrame`: version 1, kind ping|pong, `at` a finite number. */
    fun parse(frame: JSONObject): Frame? {
        if ((frame.opt("v") as? Number)?.toInt() != 1) return null
        val kind = frame.opt("kind") as? String ?: return null
        if (kind != "ping" && kind != "pong") return null
        val at = frame.opt("at") as? Number ?: return null
        val value = at.toDouble()
        if (value.isNaN() || value.isInfinite()) return null
        return Frame(kind, at.toLong())
    }
}

/** Tracks when anything last arrived and says what to do on each tick. The clock is injectable for tests. */
class LivenessMonitor(private val clock: () -> Long = System::currentTimeMillis) {
    enum class Tick { PING, LOST }

    @Volatile private var lastInboundAt = clock()

    /** Call for every inbound frame, whatever it is. */
    fun onInbound() {
        lastInboundAt = clock()
    }

    fun reset() = onInbound()

    fun tick(): Tick = if (clock() - lastInboundAt > Liveness.DEAD_LINK_MS) Tick.LOST else Tick.PING
}
