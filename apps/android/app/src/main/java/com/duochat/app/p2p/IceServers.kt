package com.duochat.app.p2p

import com.duochat.app.data.NetworkConfig
import org.webrtc.PeerConnection

fun NetworkConfig.iceServers(): List<PeerConnection.IceServer> {
    val servers = mutableListOf<PeerConnection.IceServer>()
    for (url in stun) servers += PeerConnection.IceServer.builder(url).createIceServer()
    for (entry in turn) {
        servers += PeerConnection.IceServer.builder(entry.urls)
            .setUsername(entry.username)
            .setPassword(entry.credential)
            .createIceServer()
    }
    return servers
}
