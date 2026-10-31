package com.duochat.app.data

import com.duochat.app.signaling.SignalingStatus

/** "Why isn't it connecting?" Mirrors packages/protocol/src/connectivity/diagnosis.ts; same table, same tests. */
data class CandidateCounts(val host: Int, val srflx: Int, val relay: Int)

data class ConnectionFacts(
    val signaling: SignalingStatus,
    val attempts: Int,
    val sawPeerReply: Boolean,
    val localCandidates: CandidateCounts?,
    val iceState: String?,
    val hasTurn: Boolean,
    val storeForward: Boolean,
)

enum class DiagnosisAction { ENABLE_STORE_FORWARD, ADD_TURN, OPEN_CONNECTION_SETTINGS }

data class Diagnosis(val code: String, val message: String, val actions: List<DiagnosisAction>)

fun diagnoseConnection(f: ConnectionFacts, friend: String = "your friend"): Diagnosis? {
    if (f.signaling == SignalingStatus.IDLE) {
        return Diagnosis(
            "no-signaling",
            "No connection service is set up, so phones across the internet cannot find each other. Turn one on in Settings > Connection.",
            listOf(DiagnosisAction.OPEN_CONNECTION_SETTINGS),
        )
    }
    if (f.signaling != SignalingStatus.ONLINE) {
        if (f.attempts < 1) return null
        return Diagnosis(
            "signaling-down",
            "Can't reach the connection service (the relays). Check your internet, or add another relay in Settings > Connection.",
            listOf(DiagnosisAction.OPEN_CONNECTION_SETTINGS),
        )
    }
    if (f.attempts < 2) return null
    val c = f.localCandidates
    val failed = f.iceState == "failed" || f.iceState == "disconnected"
    val fallback = if (f.storeForward) emptyList() else listOf(DiagnosisAction.ENABLE_STORE_FORWARD)
    if (c != null && c.srflx == 0 && c.relay == 0 && !f.hasTurn && c.host > 0) {
        return Diagnosis(
            "no-public-address",
            "This phone could not find its public address (the address lookup is blocked on this network), so a direct link to $friend is not possible. A TURN server fixes this.",
            listOf(DiagnosisAction.ADD_TURN) + fallback,
        )
    }
    if (failed || (f.sawPeerReply && f.attempts >= 3)) {
        return Diagnosis(
            "blocked-networks",
            "$friend answered, but the two networks would not let a direct link through. This is common on mobile data. A TURN server fixes it, and with store-and-forward on, messages still arrive through the relays in the meantime.",
            listOf(DiagnosisAction.ADD_TURN) + fallback,
        )
    }
    if (!f.sawPeerReply) {
        return Diagnosis(
            "no-answer",
            "$friend has not answered. Make sure PrivCord is open on their device and that they are online.",
            fallback,
        )
    }
    return null
}

private val CANDIDATE = Regex("a=candidate:[^\\r\\n]* typ (host|srflx|relay)\\b")

fun countSdpCandidates(sdp: String): CandidateCounts {
    var host = 0; var srflx = 0; var relay = 0
    for (m in CANDIDATE.findAll(sdp)) when (m.groupValues[1]) { "host" -> host++; "srflx" -> srflx++; else -> relay++ }
    return CandidateCounts(host, srflx, relay)
}
