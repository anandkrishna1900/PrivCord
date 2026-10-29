package com.duochat.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageModeTest {
    @Test
    fun `missing or invalid stored mode defaults to cloud`() {
        assertEquals(MessageMode.CLOUD, MessageMode.fromWire(null))
        assertEquals(MessageMode.CLOUD, MessageMode.fromWire(""))
        assertEquals(MessageMode.CLOUD, MessageMode.fromWire("unexpected"))
    }

    @Test
    fun `stored direct mode is loaded`() {
        assertEquals(MessageMode.DIRECT, MessageMode.fromWire("direct"))
    }

    @Test
    fun `direct mode never allows cloud message writes`() {
        assertFalse(allowsCloudWrites(MessageMode.DIRECT))
        assertTrue(allowsCloudWrites(MessageMode.CLOUD))
    }

    @Test
    fun `direct mode does not fall back to a connected cloud`() {
        assertFalse(
            canAttemptDelivery(
                mode = MessageMode.DIRECT,
                cloudConnected = true,
                p2pConnected = false,
            ),
        )
        assertTrue(
            canAttemptDelivery(
                mode = MessageMode.DIRECT,
                cloudConnected = false,
                p2pConnected = true,
            ),
        )
    }

    @Test
    fun `cloud mode keeps existing cloud and direct behavior`() {
        assertTrue(
            canAttemptDelivery(
                mode = MessageMode.CLOUD,
                cloudConnected = true,
                p2pConnected = false,
            ),
        )
        assertTrue(
            canAttemptDelivery(
                mode = MessageMode.CLOUD,
                cloudConnected = false,
                p2pConnected = true,
            ),
        )
        assertFalse(
            canAttemptDelivery(
                mode = MessageMode.CLOUD,
                cloudConnected = false,
                p2pConnected = false,
            ),
        )
    }
}
