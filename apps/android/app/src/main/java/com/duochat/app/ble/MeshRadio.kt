package com.duochat.app.ble

/**
 * The radio under the Bluetooth mesh: keeps links to whatever nearby phones are also running PrivCord's mesh and
 * moves JSON packets between them. [MeshNode] decides what to do with the packets; this only carries them.
 * A fake implementation makes the engine testable without hardware.
 */
interface MeshRadio {
    interface Listener {
        fun onLinkUp(link: String)
        fun onLinkDown(link: String)
        fun onPacket(link: String, json: String)
    }

    /** Starts advertising and scanning. Calls back on the main thread. */
    fun start(listener: Listener)

    fun stop()

    /** False if the link is gone or the packet cannot be framed. */
    fun send(link: String, json: String): Boolean

    /** Number of links currently open. */
    val linkCount: Int
}
