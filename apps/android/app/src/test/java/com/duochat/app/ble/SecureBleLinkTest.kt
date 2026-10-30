package com.duochat.app.ble

import com.duochat.app.data.BluetoothStatus
import com.duochat.app.data.ConnectionPath
import com.duochat.app.security.EcKeys
import com.duochat.app.security.RecoveryIdentity
import com.duochat.app.security.Vectors
import com.duochat.app.security.Vectors.objects
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Bluetooth secure link logic with an in-memory radio: handshake against the pinned contact, ordering,
 * impostors, tampering. Nothing here touches a real radio; that is the part still untested.
 */
class SecureBleLinkTest {
    private val recovery = Vectors.all.getJSONArray("recovery").objects()
    private val ann = RecoveryIdentity.derive(recovery[0].getString("phrase"), recovery[0].getString("passphrase"))
    private val bob = RecoveryIdentity.derive(recovery[2].getString("phrase"), recovery[2].getString("passphrase"))
    private val cat = RecoveryIdentity.derive(recovery[3].getString("phrase"), recovery[3].getString("passphrase"))

    /** One end of the fake radio. Delivery is synchronous, like frames arriving on the main thread in order. */
    private class Raw : RawLink {
        lateinit var handlers: BleTransport.Handlers
        var peer: Raw? = null
        override var isOpen = false
        val wire = mutableListOf<String>()
        var closed = false
        var tamper: ((String) -> String)? = null

        override fun start() {}

        override fun sendJson(value: String): Boolean {
            if (!isOpen) return false
            val out = tamper?.invoke(value) ?: value
            wire += out
            peer!!.handlers.onFrame(out)
            return true
        }

        override fun close() {
            if (closed) return
            closed = true
            isOpen = false
            handlers.onClose()
            peer?.takeIf { it.isOpen }?.let {
                it.isOpen = false
                it.handlers.onClose()
            }
        }
    }

    private class Events : BleTransport.Handlers {
        var opened = 0
        var closed = 0
        val frames = mutableListOf<String>()
        val errors = mutableListOf<String>()
        override fun onOpen() { opened++ }
        override fun onClose() { closed++ }
        override fun onFrame(data: String) { frames += data }
        override fun onError(message: String) { errors += message }
    }

    private class End(val raw: Raw = Raw(), val events: Events = Events()) {
        lateinit var link: SecureBleLink
    }

    private fun end(me: RecoveryIdentity.Keys, other: RecoveryIdentity.Keys, signer: RecoveryIdentity.Keys = me): End {
        val e = End()
        e.link = SecureBleLink(me.uid, other.uid, { EcKeys.sign(signer.signD, it) }, other.signPub, e.events) { h ->
            e.raw.handlers = h
            e.raw
        }
        return e
    }

    private fun connect(a: End, b: End) {
        a.raw.peer = b.raw
        b.raw.peer = a.raw
        a.raw.isOpen = true
        b.raw.isOpen = true
    }

    @Test
    fun `opens only after the handshake with the pinned contact and then carries encrypted frames both ways`() {
        val a = end(ann, bob)
        val b = end(bob, ann)
        connect(a, b)
        assertFalse(a.link.isOpen)
        a.raw.handlers.onOpen()
        assertFalse("not open until the peer's hello was verified", a.link.isOpen)
        b.raw.handlers.onOpen()
        assertTrue(a.link.isOpen && b.link.isOpen)
        assertEquals(1, a.events.opened)
        assertEquals(1, b.events.opened)

        assertTrue(a.link.sendJson("{\"kind\":\"hello\",\"secret\":\"needle-7731\"}"))
        assertTrue(b.link.sendJson("{\"kind\":\"pong\",\"at\":5}"))
        assertEquals(listOf("{\"kind\":\"hello\",\"secret\":\"needle-7731\"}"), b.events.frames)
        assertEquals(listOf("{\"kind\":\"pong\",\"at\":5}"), a.events.frames)
        val air = a.raw.wire + b.raw.wire
        assertTrue(air.none { it.contains("needle") })
        assertTrue("only sc_hello and sc_data cross the air", air.all { JSONObject(it).getString("kind").startsWith("sc_") })
    }

    @Test
    fun `a hello that arrives before our own link is open is buffered, not dropped`() {
        val a = end(ann, bob)
        val b = end(bob, ann)
        connect(a, b)
        // A opens and sends its hello while B has not even been told the link is open.
        a.raw.handlers.onOpen()
        assertEquals(1, a.raw.wire.size)
        b.raw.handlers.onOpen()
        assertTrue(a.link.isOpen && b.link.isOpen)
    }

    @Test
    fun `peer data sent right behind its hello is delivered in order after the link opens`() {
        val a = end(ann, bob)
        val b = end(bob, ann)
        connect(a, b)
        a.raw.handlers.onOpen()
        b.raw.handlers.onOpen()
        for (i in 1..20) assertTrue(a.link.sendJson("{\"i\":$i}"))
        assertEquals((1..20).map { "{\"i\":$it}" }, b.events.frames)
    }

    @Test
    fun `an impostor that is not the pinned contact never opens the link`() {
        val a = end(ann, bob)
        val evil = end(bob, ann, signer = cat) // claims to be bob but signs with cat's key
        connect(a, evil)
        a.raw.handlers.onOpen()
        evil.raw.handlers.onOpen()
        assertFalse(a.link.isOpen)
        assertEquals(0, a.events.opened)
        assertTrue(a.events.errors.single().contains("rejected"))
        assertTrue("the link was torn down", a.raw.closed)
        assertFalse(a.link.sendJson("{}"))
    }

    @Test
    fun `a flipped bit on the air drops the link and delivers nothing`() {
        val a = end(ann, bob)
        val b = end(bob, ann)
        connect(a, b)
        a.raw.handlers.onOpen()
        b.raw.handlers.onOpen()
        a.raw.tamper = { json ->
            val frame = JSONObject(json)
            val ct = frame.getString("ct")
            frame.put("ct", ct.dropLast(2) + if (ct.endsWith("AA")) "BB" else "AA").toString()
        }
        a.link.sendJson("{\"x\":1}")
        assertTrue(b.events.frames.isEmpty())
        assertTrue(b.events.errors.single().contains("rejected"))
        assertFalse(b.link.isOpen)
    }

    @Test
    fun `a replayed data frame is rejected`() {
        val a = end(ann, bob)
        val b = end(bob, ann)
        connect(a, b)
        a.raw.handlers.onOpen()
        b.raw.handlers.onOpen()
        a.link.sendJson("{\"n\":1}")
        val recorded = a.raw.wire.last()
        b.raw.handlers.onFrame(recorded)
        assertEquals(listOf("{\"n\":1}"), b.events.frames)
        assertFalse(b.link.isOpen)
    }

    @Test
    fun `cannot send before the handshake and reports Bluetooth as the path once open`() = runBlocking {
        val a = end(ann, bob)
        val b = end(bob, ann)
        connect(a, b)
        assertFalse(a.link.sendJson("{}"))
        assertNull(a.link.connectionPath())
        a.raw.handlers.onOpen()
        b.raw.handlers.onOpen()
        assertEquals(ConnectionPath.BLUETOOTH, a.link.connectionPath())
        assertEquals("Bluetooth, no internet", ConnectionPath.BLUETOOTH.label)
    }

    @Test
    fun `closing ourselves is silent but a lost link after opening is reported once`() {
        val a = end(ann, bob)
        val b = end(bob, ann)
        connect(a, b)
        a.raw.handlers.onOpen()
        b.raw.handlers.onOpen()
        a.link.close()
        assertEquals("our own close must not be reported as a loss", 0, a.events.closed)
        assertEquals("the peer sees the link go away once", 1, b.events.closed)
        assertFalse(a.link.sendJson("{}"))
    }

    @Test
    fun `permissions and backoff helpers`() {
        assertEquals(listOf("android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_ADVERTISE", "android.permission.BLUETOOTH_CONNECT"), BlePermissions.required(31).toList())
        assertEquals(listOf("android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_ADVERTISE", "android.permission.BLUETOOTH_CONNECT"), BlePermissions.required(34).toList())
        assertEquals(listOf("android.permission.ACCESS_FINE_LOCATION"), BlePermissions.required(30).toList())
        assertEquals(listOf(15_000L, 30_000L, 60_000L, 120_000L, 120_000L, 120_000L), (0..5).map { bleReconnectDelayMs(it) })
        assertEquals(15_000L, bleReconnectDelayMs(-4))
    }

    @Test
    fun `status row decisions`() {
        fun status(
            enabled: Boolean = true,
            env: Boolean = true,
            isBle: Boolean = false,
            ready: Boolean = false,
            avail: BleAvailability? = BleAvailability.READY,
            paired: Boolean = true,
        ) = bluetoothStatusFor(enabled, env, isBle, ready, avail, paired)

        assertEquals(BluetoothStatus.DISABLED, status(enabled = false, isBle = true, ready = true))
        assertEquals(BluetoothStatus.UNSUPPORTED, status(env = false))
        assertEquals(BluetoothStatus.UNSUPPORTED, status(avail = BleAvailability.UNSUPPORTED))
        assertEquals(BluetoothStatus.NEEDS_PERMISSION, status(avail = BleAvailability.NEEDS_PERMISSION))
        assertEquals(BluetoothStatus.ADAPTER_OFF, status(avail = BleAvailability.ADAPTER_OFF))
        assertEquals(BluetoothStatus.NOT_PAIRED, status(paired = false))
        assertEquals(BluetoothStatus.READY, status())
        assertEquals(BluetoothStatus.SEARCHING, status(isBle = true, avail = BleAvailability.ADAPTER_OFF))
        assertEquals(BluetoothStatus.CONNECTED, status(isBle = true, ready = true))
        // A WebRTC link that is ready does not make Bluetooth "connected".
        assertEquals(BluetoothStatus.READY, status(ready = true))
    }
}
