package com.duochat.app.p2p

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.duochat.app.data.ConnectionPath
import com.duochat.app.data.classifyConnectionPath
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStatsReport
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.nio.ByteBuffer
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class WebRtcTransport(
    private val iceServers: List<PeerConnection.IceServer>,
    private val forceRelay: Boolean,
    private val handlers: Handlers,
) : LinkTransport {
    interface Handlers {
        fun onOpen()
        fun onClose()
        fun onFrame(data: String)
        fun onError(message: String)
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var peerConnection: PeerConnection? = null
    private var dataChannel: DataChannel? = null
    private var closedByUs = false
    private var iceGatherContinuation: kotlinx.coroutines.CancellableContinuation<Unit>? = null

    /** What the last offer or answer contained and how ICE ended up; used only to explain failures. */
    @Volatile var lastCandidates: com.duochat.app.data.CandidateCounts? = null
        private set
    @Volatile var iceState: String? = null
        private set

    @Volatile
    override var isOpen: Boolean = false
        private set

    suspend fun createOffer(): String {
        close()
        closedByUs = false
        val pc = createPeerConnection()
        val init = DataChannel.Init().apply { ordered = true }
        val channel = pc.createDataChannel("duochat", init)
        bindChannel(channel)
        val offer = pc.createOfferSuspending()
        pc.setLocalDescriptionSuspending(offer)
        waitForIceGathering(pc)
        return (pc.localDescription?.description
            ?: throw IllegalStateException("Failed to create a connection offer.")).also { lastCandidates = com.duochat.app.data.countSdpCandidates(it) }
    }

    suspend fun acceptOffer(offerSdp: String): String {
        close()
        closedByUs = false
        val pc = createPeerConnection()
        pc.setRemoteDescriptionSuspending(
            SessionDescription(SessionDescription.Type.OFFER, offerSdp),
        )
        val answer = pc.createAnswerSuspending()
        pc.setLocalDescriptionSuspending(answer)
        waitForIceGathering(pc)
        return (pc.localDescription?.description
            ?: throw IllegalStateException("Failed to create a connection answer.")).also { lastCandidates = com.duochat.app.data.countSdpCandidates(it) }
    }

    suspend fun applyAnswer(answerSdp: String) {
        val pc = peerConnection ?: throw IllegalStateException("No pending connection offer.")
        pc.setRemoteDescriptionSuspending(
            SessionDescription(SessionDescription.Type.ANSWER, answerSdp),
        )
    }

    override suspend fun awaitWritable(): Boolean {
        val channel = dataChannel ?: return false
        val deadline = System.currentTimeMillis() + 20_000
        while (isOpen && channel.bufferedAmount() > HIGH_WATER_BYTES) {
            if (System.currentTimeMillis() > deadline) return false
            kotlinx.coroutines.delay(15)
        }
        return isOpen
    }

    override fun sendJson(value: String): Boolean {
        val channel = dataChannel ?: return false
        return try {
            channel.send(
                DataChannel.Buffer(
                    ByteBuffer.wrap(value.toByteArray(Charsets.UTF_8)),
                    false,
                ),
            )
        } catch (error: Exception) {
            handlers.onError("Direct send failed: ${error.message}")
            false
        }
    }

    /**
     * Reads the nominated ICE candidate pair and classifies it. Returns null if
     * stats are not available yet. Never inferred from configuration.
     */
    override suspend fun connectionPath(): ConnectionPath? {
        val pc = peerConnection ?: return null
        val report = withTimeoutOrNull(3_000) {
            suspendCancellableCoroutine<RTCStatsReport?> { continuation ->
                pc.getStats { result -> if (continuation.isActive) continuation.resume(result) }
            }
        } ?: return null
        val stats = report.statsMap
        val selectedId = stats.values.firstOrNull { it.type == "transport" }
            ?.members?.get("selectedCandidatePairId") as? String
        val pair = stats[selectedId]
            ?: stats.values.firstOrNull {
                it.type == "candidate-pair" &&
                    it.members["state"] == "succeeded" &&
                    it.members["nominated"] == true
            }
            ?: return null
        val local = stats[pair.members["localCandidateId"] as? String]
            ?.members?.get("candidateType") as? String
        val remote = stats[pair.members["remoteCandidateId"] as? String]
            ?.members?.get("candidateType") as? String
        return classifyConnectionPath(local, remote)
    }

    override fun close() {
        closedByUs = true
        isOpen = false
        iceGatherContinuation?.cancel()
        iceGatherContinuation = null
        dataChannel?.let { channel ->
            try {
                channel.unregisterObserver()
                channel.close()
                channel.dispose()
            } catch (_: Exception) {
                // Ignore double-close.
            }
        }
        dataChannel = null
        peerConnection?.let { pc ->
            try {
                pc.close()
                pc.dispose()
            } catch (_: Exception) {
                // Ignore double-close.
            }
        }
        peerConnection = null
    }

    private fun createPeerConnection(): PeerConnection {
        val configuration = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            if (forceRelay) iceTransportsType = PeerConnection.IceTransportsType.RELAY
        }
        val pc = PeerConnectionFactoryHolder.factory().createPeerConnection(
            configuration,
            object : PeerConnection.Observer {
                override fun onSignalingChange(state: PeerConnection.SignalingState?) = Unit

                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                    iceState = state?.name?.lowercase()
                }

                override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit

                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
                    if (state == PeerConnection.IceGatheringState.COMPLETE) {
                        iceGatherContinuation?.let { continuation ->
                            iceGatherContinuation = null
                            if (continuation.isActive) continuation.resume(Unit)
                        }
                    }
                }

                override fun onIceCandidate(candidate: IceCandidate?) {
                    if (candidate == null) {
                        iceGatherContinuation?.let { continuation ->
                            iceGatherContinuation = null
                            if (continuation.isActive) continuation.resume(Unit)
                        }
                    }
                }

                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) = Unit

                override fun onAddStream(stream: MediaStream?) = Unit

                override fun onRemoveStream(stream: MediaStream?) = Unit

                override fun onDataChannel(channel: DataChannel?) {
                    channel?.let { bindChannel(it) }
                }

                override fun onRenegotiationNeeded() = Unit

                override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) = Unit

                override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
                    if (
                        (newState == PeerConnection.PeerConnectionState.FAILED ||
                            newState == PeerConnection.PeerConnectionState.CLOSED) &&
                        !closedByUs
                    ) {
                        mainHandler.post { handlers.onClose() }
                    }
                }
            },
        ) ?: throw IllegalStateException("Could not create a peer connection.")
        peerConnection = pc
        return pc
    }

    private fun bindChannel(channel: DataChannel) {
        dataChannel = channel
        channel.registerObserver(
            object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) = Unit

                override fun onStateChange() {
                    when (channel.state()) {
                        DataChannel.State.OPEN -> {
                            isOpen = true
                            mainHandler.post { handlers.onOpen() }
                        }

                        DataChannel.State.CLOSED -> {
                            isOpen = false
                            if (!closedByUs) mainHandler.post { handlers.onClose() }
                        }

                        else -> Unit
                    }
                }

                override fun onMessage(buffer: DataChannel.Buffer) {
                    val data = buffer.data
                    val bytes = ByteArray(data.remaining())
                    data.get(bytes)
                    val text = String(bytes, Charsets.UTF_8)
                    mainHandler.post { handlers.onFrame(text) }
                }
            },
        )
    }

    private suspend fun waitForIceGathering(pc: PeerConnection) {
        if (pc.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE) return
        withTimeoutOrNull(8_000) {
            suspendCancellableCoroutine<Unit> { continuation ->
                iceGatherContinuation = continuation
                continuation.invokeOnCancellation {
                    if (iceGatherContinuation === continuation) iceGatherContinuation = null
                }
            }
        }
    }

    private suspend fun PeerConnection.createOfferSuspending(): SessionDescription =
        suspendCancellableCoroutine { continuation ->
            createOffer(
                object : SdpObserver {
                    override fun onCreateSuccess(sdp: SessionDescription?) {
                        if (sdp != null && continuation.isActive) continuation.resume(sdp)
                        else if (continuation.isActive) {
                            continuation.resumeWithException(
                                IllegalStateException("Failed to create a connection offer."),
                            )
                        }
                    }

                    override fun onCreateFailure(error: String?) {
                        if (continuation.isActive) {
                            continuation.resumeWithException(
                                IllegalStateException(error ?: "Offer creation failed."),
                            )
                        }
                    }

                    override fun onSetSuccess() = Unit
                    override fun onSetFailure(error: String?) = Unit
                },
                MediaConstraints(),
            )
        }

    private suspend fun PeerConnection.createAnswerSuspending(): SessionDescription =
        suspendCancellableCoroutine { continuation ->
            createAnswer(
                object : SdpObserver {
                    override fun onCreateSuccess(sdp: SessionDescription?) {
                        if (sdp != null && continuation.isActive) continuation.resume(sdp)
                        else if (continuation.isActive) {
                            continuation.resumeWithException(
                                IllegalStateException("Failed to create a connection answer."),
                            )
                        }
                    }

                    override fun onCreateFailure(error: String?) {
                        if (continuation.isActive) {
                            continuation.resumeWithException(
                                IllegalStateException(error ?: "Answer creation failed."),
                            )
                        }
                    }

                    override fun onSetSuccess() = Unit
                    override fun onSetFailure(error: String?) = Unit
                },
                MediaConstraints(),
            )
        }

    private suspend fun PeerConnection.setLocalDescriptionSuspending(
        description: SessionDescription,
    ) = suspendCancellableCoroutine<Unit> { continuation ->
        setLocalDescription(
            object : SdpObserver {
                override fun onCreateSuccess(sdp: SessionDescription?) = Unit
                override fun onCreateFailure(error: String?) = Unit
                override fun onSetSuccess() {
                    if (continuation.isActive) continuation.resume(Unit)
                }

                override fun onSetFailure(error: String?) {
                    if (continuation.isActive) {
                        continuation.resumeWithException(
                            IllegalStateException(error ?: "Could not apply the local description."),
                        )
                    }
                }
            },
            description,
        )
    }

    private suspend fun PeerConnection.setRemoteDescriptionSuspending(
        description: SessionDescription,
    ) = suspendCancellableCoroutine<Unit> { continuation ->
        setRemoteDescription(
            object : SdpObserver {
                override fun onCreateSuccess(sdp: SessionDescription?) = Unit
                override fun onCreateFailure(error: String?) = Unit
                override fun onSetSuccess() {
                    if (continuation.isActive) continuation.resume(Unit)
                }

                override fun onSetFailure(error: String?) {
                    if (continuation.isActive) {
                        continuation.resumeWithException(
                            IllegalStateException(error ?: "Could not apply the remote description."),
                        )
                    }
                }
            },
            description,
        )
    }
}

object PeerConnectionFactoryHolder {
    @Volatile
    private var peerConnectionFactory: PeerConnectionFactory? = null

    fun initialize(context: Context) {
        if (peerConnectionFactory != null) return
        synchronized(this) {
            if (peerConnectionFactory != null) return
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                    .createInitializationOptions(),
            )
            peerConnectionFactory = PeerConnectionFactory.builder().createPeerConnectionFactory()
        }
    }

    fun factory(): PeerConnectionFactory =
        peerConnectionFactory
            ?: throw IllegalStateException("WebRTC has not been initialized.")
}

private const val HIGH_WATER_BYTES = 1_000_000L
