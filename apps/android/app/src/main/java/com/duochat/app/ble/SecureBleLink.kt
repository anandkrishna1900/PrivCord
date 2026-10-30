package com.duochat.app.ble

import android.content.Context
import com.duochat.app.data.ConnectionPath
import com.duochat.app.p2p.LinkTransport
import com.duochat.app.security.PublicJwk
import com.duochat.app.security.SecureChannel
import org.json.JSONObject

/**
 * Bluetooth LE carrying the same JSON frames as WebRTC, plus authenticated forward-secret encryption
 * (BLE itself is not relied on). Mirrors apps/desktop/src/lib/bleLink.ts.
 *
 * The link reports "open" only after the peer's signed hello was verified against the PINNED contact's
 * key; the normal hello / auth_proof / auth_ok handshake then runs inside the encrypted channel. The
 * secure channel is created synchronously when the radio link opens, and a frame that somehow beats that
 * is buffered, so a hello can never be dropped (the race that bit the desktop version). Incoming frames
 * are processed one at a time, in arrival order. UNTESTED on a real radio.
 */
class SecureBleLink(
    private val ownUid: String,
    private val peerUid: String,
    private val sign: (ByteArray) -> String,
    private val peerSign: PublicJwk,
    private val handlers: BleTransport.Handlers,
    rawFactory: (BleTransport.Handlers) -> RawLink,
) : LinkTransport {
    /** The real thing: GATT central and peripheral over [BleTransport]. */
    constructor(
        context: Context,
        /** 32-byte ECDH secret with the pinned contact; only selects which advertisements to accept. */
        secret: ByteArray,
        initiateAsCentral: Boolean,
        ownUid: String,
        peerUid: String,
        sign: (ByteArray) -> String,
        peerSign: PublicJwk,
        handlers: BleTransport.Handlers,
    ) : this(ownUid, peerUid, sign, peerSign, handlers, { raw -> BleTransport(context, { secret }, initiateAsCentral, raw) })

    private val lock = Any()
    private var channel: SecureChannel? = null
    private val early = ArrayDeque<String>()

    @Volatile
    private var ready = false

    @Volatile
    private var closedByUs = false

    private val inner: RawLink = rawFactory(
        object : BleTransport.Handlers {
            override fun onOpen() = begin()

            override fun onClose() {
                val wasReady = ready
                ready = false
                synchronized(lock) {
                    channel = null
                    early.clear()
                }
                if (!closedByUs && wasReady) handlers.onClose()
            }

            override fun onFrame(data: String) = receive(data)

            override fun onError(message: String) = handlers.onError(message)
        },
    )

    override val isOpen: Boolean get() = ready && inner.isOpen

    /** Starts advertising, and scanning when this side is the central. */
    fun start() = inner.start()

    private fun begin() {
        synchronized(lock) {
            val created = SecureChannel.create(ownUid, peerUid, sign, peerSign)
            channel = created
            inner.sendJson(created.hello().toString())
            while (early.isNotEmpty() && channel === created) receiveLocked(early.removeFirst())
        }
    }

    private fun receive(raw: String) {
        synchronized(lock) {
            if (channel == null) {
                if (early.size < MAX_EARLY_FRAMES) early.addLast(raw)
                return
            }
            receiveLocked(raw)
        }
    }

    private fun receiveLocked(raw: String) {
        try {
            val ch = channel ?: return
            val frame = JSONObject(raw)
            if (!ch.ready) {
                if (!SecureChannel.isHello(frame)) return
                ch.accept(frame)
                ready = true
                handlers.onOpen()
                return
            }
            if (SecureChannel.isData(frame)) handlers.onFrame(ch.decryptText(frame))
        } catch (error: Exception) {
            handlers.onError("Bluetooth link rejected: ${error.message ?: error.javaClass.simpleName}")
            close()
        }
    }

    /** Encrypts and queues one frame. Counters stay in order because encrypt+queue happen under one lock. */
    override fun sendJson(value: String): Boolean = synchronized(lock) {
        val ch = channel
        if (!ready || ch == null || !inner.isOpen) return false
        inner.sendJson(ch.encryptText(value).toString())
    }

    override fun close() {
        closedByUs = true
        ready = false
        inner.close()
    }

    override suspend fun connectionPath(): ConnectionPath? = if (isOpen) ConnectionPath.BLUETOOTH else null

    private companion object {
        const val MAX_EARLY_FRAMES = 16
    }
}
