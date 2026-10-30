package com.duochat.app.p2p

import com.duochat.app.security.Vectors
import com.duochat.app.security.Vectors.objects
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class LivenessTest {
    @Test
    fun `frames serialize in the shared wire format`() {
        val ping = Liveness.ping(1700000000123)
        assertEquals(1, ping.getInt("v"))
        assertEquals("ping", ping.getString("kind"))
        assertEquals(1700000000123, ping.getLong("at"))
        assertEquals("pong", Liveness.pong(7).getString("kind"))
        // What we send must parse back, and be accepted by the TypeScript parser's rule.
        val back = Liveness.parse(JSONObject(ping.toString()))!!
        assertEquals("ping", back.kind)
        assertEquals(1700000000123, back.at)
    }

    @Test
    fun `a pong carries the same at as the ping it answers`() {
        val ping = Liveness.parse(Liveness.ping(42))!!
        assertEquals(42L, Liveness.parse(Liveness.pong(ping.at))!!.at)
    }

    @Test
    fun `parsing accepts and rejects exactly what the TypeScript parser does`() {
        val cases = Vectors.all.getJSONArray("liveness").objects()
        assertEquals(8, cases.size)
        for (c in cases) {
            val parsed = Liveness.parse(c.getJSONObject("input"))
            val expected = if (c.isNull("parsed")) null else c.getJSONObject("parsed")
            assertEquals(c.getJSONObject("input").toString(), expected == null, parsed == null)
            if (expected != null) {
                assertEquals(expected.getString("kind"), parsed!!.kind)
                assertEquals(expected.getLong("at"), parsed.at)
            }
        }
    }

    @Test
    fun `silence for more than 14 seconds is a lost link, anything inbound resets it`() {
        var now = 1_000_000L
        val monitor = LivenessMonitor { now }
        assertEquals(LivenessMonitor.Tick.PING, monitor.tick())
        now += 14_000
        assertEquals("exactly 14 s is not yet lost", LivenessMonitor.Tick.PING, monitor.tick())
        now += 1
        assertEquals(LivenessMonitor.Tick.LOST, monitor.tick())
        monitor.onInbound() // any frame at all, a message or a pong
        assertEquals(LivenessMonitor.Tick.PING, monitor.tick())
        now += 13_999
        assertEquals(LivenessMonitor.Tick.PING, monitor.tick())
        monitor.reset()
        now += 14_001
        assertEquals(LivenessMonitor.Tick.LOST, monitor.tick())
    }

    @Test
    fun `timings match the desktop`() {
        assertEquals(4_000L, Liveness.PING_INTERVAL_MS)
        assertEquals(14_000L, Liveness.DEAD_LINK_MS)
        assertNotNull(Liveness.parse(Liveness.ping(0)))
        assertNull(Liveness.parse(JSONObject().put("v", 1).put("kind", "hello").put("at", 1)))
    }
}
