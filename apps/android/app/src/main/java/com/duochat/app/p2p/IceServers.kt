package com.duochat.app.p2p

import com.duochat.app.data.NetworkConfig
import org.webrtc.PeerConnection

fun NetworkConfig.iceServers(): List<PeerConnection.IceServer> {
    val servers = mutableListOf<PeerConnection.IceServer>()
    for (url in stun) servers += PeerConnection.IceServer.builder(url).createIceServer()
    if (builtinTurn) builtinTurnServer()?.let { servers += it }
    for (entry in turn) {
        servers += PeerConnection.IceServer.builder(entry.urls)
            .setUsername(entry.username)
            .setPassword(entry.credential)
            .createIceServer()
    }
    return servers
}

/**
 * The TURN relay this release was built with (`PRIVCORD_TURN_URLS`, `PRIVCORD_TURN_USERNAME`, `PRIVCORD_TURN_CREDENTIAL` at
 * build time; see docs/turn-server/README.md), or none. It only relays encrypted traffic when two devices cannot reach each other
 * directly; WebRTC still prefers a direct path whenever one works.
 */
fun builtinTurnServer(): PeerConnection.IceServer? {
    val urls = com.duochat.app.BuildConfig.PRIVCORD_TURN_URLS.split(',').map { it.trim() }.filter { it.isNotEmpty() }
    if (urls.isEmpty()) return null
    return PeerConnection.IceServer.builder(urls)
        .setUsername(com.duochat.app.BuildConfig.PRIVCORD_TURN_USERNAME)
        .setPassword(com.duochat.app.BuildConfig.PRIVCORD_TURN_CREDENTIAL)
        .createIceServer()
}

/** Whether this release has a TURN relay built in. */
val hasBuiltinTurn: Boolean get() = com.duochat.app.BuildConfig.PRIVCORD_TURN_URLS.isNotBlank()
