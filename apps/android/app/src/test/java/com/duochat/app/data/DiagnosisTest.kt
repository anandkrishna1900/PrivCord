package com.duochat.app.data

import com.duochat.app.signaling.SignalingStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DiagnosisTest {
    private val base = ConnectionFacts(SignalingStatus.ONLINE, 3, true, CandidateCounts(2, 1, 0), null, false, false)

    @Test fun quietWhenEarly() {
        assertNull(diagnoseConnection(base.copy(attempts = 1)))
        assertNull(diagnoseConnection(base.copy(attempts = 0, signaling = SignalingStatus.ERROR)))
    }

    @Test fun signalingCases() {
        assertEquals("no-signaling", diagnoseConnection(base.copy(signaling = SignalingStatus.IDLE))?.code)
        assertEquals("signaling-down", diagnoseConnection(base.copy(signaling = SignalingStatus.ERROR, attempts = 1))?.code)
    }

    @Test fun noAnswerOffersStoreForwardOnlyWhenOff() {
        val d = diagnoseConnection(base.copy(sawPeerReply = false), "Ben")!!
        assertEquals("no-answer", d.code)
        assertEquals(listOf(DiagnosisAction.ENABLE_STORE_FORWARD), d.actions)
        assertEquals(emptyList<DiagnosisAction>(), diagnoseConnection(base.copy(sawPeerReply = false, storeForward = true))!!.actions)
    }

    @Test fun addressAndBlockedNetworks() {
        assertEquals("no-public-address", diagnoseConnection(base.copy(localCandidates = CandidateCounts(2, 0, 0)))?.code)
        val f = diagnoseConnection(base.copy(iceState = "failed"))!!
        assertEquals("blocked-networks", f.code)
        assertEquals(listOf(DiagnosisAction.ADD_TURN, DiagnosisAction.ENABLE_STORE_FORWARD), f.actions)
        assertEquals("no-answer", diagnoseConnection(base.copy(hasTurn = true, localCandidates = CandidateCounts(2, 0, 0), sawPeerReply = false))?.code)
    }

    @Test fun countsCandidates() {
        val sdp = "a=candidate:1 1 udp 1 1.1.1.1 1 typ host\r\na=candidate:2 1 udp 1 2.2.2.2 1 typ srflx raddr x\r\na=candidate:3 1 udp 1 3.3.3.3 1 typ relay\r\na=candidate:4 1 udp 1 4 1 typ host"
        assertEquals(CandidateCounts(2, 1, 1), countSdpCandidates(sdp))
        assertEquals(CandidateCounts(0, 0, 0), countSdpCandidates("v=0"))
    }
}
