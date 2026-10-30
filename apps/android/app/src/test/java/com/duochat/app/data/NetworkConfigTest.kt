package com.duochat.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkConfigTest {
    @Test
    fun `json round trip keeps stun turn and force relay`() {
        val config = NetworkConfig(
            stun = listOf("stun:stun.example.org:3478"),
            turn = listOf(TurnServer(listOf("turn:t.example.org:3478", "turns:t.example.org:5349"), "u", "p")),
            forceRelay = true,
        )
        assertEquals(config, NetworkConfig.fromJson(config.toJson()))
    }

    @Test
    fun `malformed or missing storage falls back`() {
        val fallback = NetworkConfig(stun = listOf("stun:x:1"))
        assertEquals(fallback, NetworkConfig.fromJson(null, fallback))
        assertEquals(fallback, NetworkConfig.fromJson("{not json", fallback))
    }

    @Test
    fun `invalid urls and incomplete turn entries are dropped`() {
        val parsed = NetworkConfig.fromJson(
            """{"stun":["stun:ok:1","http://bad"],"turn":[{"urls":["turn:a:1"],"credential":"x"}]}""",
        )
        assertEquals(listOf("stun:ok:1"), parsed.stun)
        assertTrue(parsed.turn.isEmpty())
    }

    @Test
    fun `matches the TypeScript parser on shared vectors`() {
        val cases = com.duochat.app.security.Vectors.all.getJSONArray("network")
        assertTrue(cases.length() >= 6)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val raw = if (c.isNull("raw")) null else c.getString("raw")
            assertEquals(
                "case $i: $raw",
                com.duochat.app.security.CanonicalJson.of(c.getJSONObject("expected")),
                com.duochat.app.security.CanonicalJson.of(org.json.JSONObject(NetworkConfig.fromJson(raw).toJson())),
            )
        }
    }

    @Test
    fun `websocket urls are validated`() {
        assertTrue(NetworkConfig.isWsUrl("wss://relay.example"))
        assertTrue(NetworkConfig.isWsUrl("ws://127.0.0.1:8787"))
        assertEquals(false, NetworkConfig.isWsUrl("https://not-ws"))
        assertEquals(false, NetworkConfig.isWsUrl("x"))
    }

    @Test
    fun `an empty stun list is kept so stun can be disabled`() {
        assertTrue(NetworkConfig.fromJson("""{"stun":[]}""").stun.isEmpty())
    }

    @Test
    fun `list parsing accepts commas and newlines`() {
        assertEquals(
            listOf("stun:a:1", "stun:b:2"),
            NetworkConfig.parseStunList("stun:a:1, stun:b:2\nhttp://nope"),
        )
        assertEquals(listOf("turn:a:1", "turns:b:2"), NetworkConfig.parseTurnUrls("turn:a:1\nturns:b:2\nstun:c:3"))
    }

    @Test
    fun `path classification follows the candidate types`() {
        assertEquals(ConnectionPath.DIRECT_LAN, classifyConnectionPath("host", "host"))
        assertEquals(ConnectionPath.DIRECT_P2P, classifyConnectionPath("srflx", "host"))
        assertEquals(ConnectionPath.DIRECT_P2P, classifyConnectionPath("prflx", "srflx"))
        assertEquals(ConnectionPath.RELAYED, classifyConnectionPath("relay", "host"))
        assertEquals(ConnectionPath.RELAYED, classifyConnectionPath("host", "relay"))
        assertNull(classifyConnectionPath(null, "host"))
        assertNull(classifyConnectionPath("host", ""))
    }

    @Test
    fun `undelivered messages are the ones to resend`() {
        assertTrue(needsDelivery(DeliveryState.QUEUED))
        assertTrue(needsDelivery(DeliveryState.SENT))
        assertTrue(needsDelivery(DeliveryState.FAILED))
        assertEquals(false, needsDelivery(DeliveryState.DELIVERED))
        assertEquals(false, needsDelivery(DeliveryState.READ))
    }
}
