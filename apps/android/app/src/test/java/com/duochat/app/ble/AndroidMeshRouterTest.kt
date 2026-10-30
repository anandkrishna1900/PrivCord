package com.duochat.app.ble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class AndroidMeshRouterTest {
    @Test
    fun `router consumes packets for own uid and forwards packets for others`() {
        val router = AndroidMeshRouter(ownUid = "device-B")
        val packetForB = AndroidMeshRouter.MeshPacket(
            packetId = "pkt-1",
            originUid = "device-A",
            destUid = "device-B",
            ttl = 3,
            maxHops = 3,
            timestamp = System.currentTimeMillis(),
            payload = "data-for-B",
        )
        assertEquals(AndroidMeshRouter.Action.CONSUME, router.processPacket(packetForB))

        // Same packet arriving again is dropped (loop / duplicate prevention)
        assertEquals(AndroidMeshRouter.Action.DROP, router.processPacket(packetForB))

        val packetForC = AndroidMeshRouter.MeshPacket(
            packetId = "pkt-2",
            originUid = "device-A",
            destUid = "device-C",
            ttl = 3,
            maxHops = 3,
            timestamp = System.currentTimeMillis(),
            payload = "data-for-C",
        )
        assertEquals(AndroidMeshRouter.Action.FORWARD, router.processPacket(packetForC))

        val next = router.nextHop(packetForC)
        assertNotNull(next)
        assertEquals(2, next!!.ttl)
    }

    @Test
    fun `router drops expired packets and zero-ttl packets`() {
        val router = AndroidMeshRouter(ownUid = "device-B")
        val zeroTtl = AndroidMeshRouter.MeshPacket(
            packetId = "pkt-zero",
            originUid = "device-A",
            destUid = "device-C",
            ttl = 0,
            maxHops = 3,
            timestamp = System.currentTimeMillis(),
            payload = "zero",
        )
        assertEquals(AndroidMeshRouter.Action.DROP, router.processPacket(zeroTtl))
        assertNull(router.nextHop(zeroTtl))
    }

    @Test
    fun `store-carry-forward retains packets for offline peers`() {
        val router = AndroidMeshRouter(ownUid = "device-B")
        val delayed = AndroidMeshRouter.MeshPacket(
            packetId = "pkt-delayed",
            originUid = "device-A",
            destUid = "device-C",
            ttl = 2,
            maxHops = 3,
            timestamp = System.currentTimeMillis(),
            payload = "delayed-data",
        )
        router.store(delayed)
        val packets = router.getPacketsFor("device-C")
        assertEquals(1, packets.size)
        assertEquals("pkt-delayed", packets[0].packetId)
    }
}
