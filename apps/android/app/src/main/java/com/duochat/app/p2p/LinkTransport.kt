package com.duochat.app.p2p

import com.duochat.app.data.ConnectionPath

/**
 * One way of carrying the JSON frames to the paired friend: the WebRTC data channel or the Bluetooth LE link.
 * PeerSession runs the same identity handshake over whichever is open.
 */
interface LinkTransport {
    val isOpen: Boolean
    fun sendJson(value: String): Boolean
    fun close()

    /** How the link is really routed; null while it is not known yet. */
    suspend fun connectionPath(): ConnectionPath?
}
