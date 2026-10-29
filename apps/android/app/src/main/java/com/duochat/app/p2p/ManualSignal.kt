package com.duochat.app.p2p

import com.duochat.app.data.MANUAL_SIGNAL_PREFIX
import com.duochat.app.data.PROTOCOL_VERSION
import com.duochat.app.security.PublicJwk
import com.duochat.app.security.SignatureCodec
import org.json.JSONObject

const val MAX_MANUAL_SIGNAL_BYTES = 64 * 1024

data class ManualSignal(
    val kind: String,
    val conversationId: String,
    val fromUid: String,
    val fromDeviceId: String,
    val publicKeyJwk: PublicJwk,
    val sdp: String,
    val nonce: String,
    val createdAt: Long,
)

object ManualSignalCodec {
    fun encode(signal: ManualSignal): String {
        val json = JSONObject()
            .put("v", PROTOCOL_VERSION)
            .put("kind", signal.kind)
            .put("conversationId", signal.conversationId)
            .put("fromUid", signal.fromUid)
            .put("fromDeviceId", signal.fromDeviceId)
            .put(
                "publicKeyJwk",
                JSONObject()
                    .put("kty", "EC")
                    .put("crv", "P-256")
                    .put("x", signal.publicKeyJwk.x)
                    .put("y", signal.publicKeyJwk.y),
            )
            .put("sdp", signal.sdp)
            .put("nonce", signal.nonce)
            .put("createdAt", signal.createdAt)
        return MANUAL_SIGNAL_PREFIX + SignatureCodec.base64UrlEncode(
            json.toString().toByteArray(Charsets.UTF_8),
        )
    }

    fun decode(encoded: String, expectedConversationId: String): ManualSignal {
        val trimmed = encoded.trim()
        if (!trimmed.startsWith(MANUAL_SIGNAL_PREFIX)) {
            throw IllegalArgumentException("This is not a DuoChat connection code.")
        }
        val base64 = trimmed.removePrefix(MANUAL_SIGNAL_PREFIX)
        if (base64.length > MAX_MANUAL_SIGNAL_BYTES) {
            throw IllegalArgumentException("Connection code is too large.")
        }
        val json = try {
            String(SignatureCodec.base64UrlDecode(base64), Charsets.UTF_8)
        } catch (_: Exception) {
            throw IllegalArgumentException("Connection code is malformed.")
        }
        val signal = try {
            JSONObject(json)
        } catch (_: Exception) {
            throw IllegalArgumentException("Connection code is malformed.")
        }
        if (signal.optInt("v", -1) != PROTOCOL_VERSION) {
            throw IllegalArgumentException("Unsupported connection code version.")
        }
        val kind = signal.optString("kind")
        if (kind != "offer" && kind != "answer") {
            throw IllegalArgumentException("Connection code has an invalid type.")
        }
        if (signal.optString("conversationId") != expectedConversationId) {
            throw IllegalArgumentException("Connection code belongs to another conversation.")
        }
        val fromUid = signal.optString("fromUid")
        if (fromUid.isEmpty()) throw IllegalArgumentException("Connection code has no sender.")
        val fromDeviceId = signal.optString("fromDeviceId")
        if (fromDeviceId.isEmpty()) throw IllegalArgumentException("Connection code has no device.")
        val keyObject = signal.optJSONObject("publicKeyJwk")
        if (
            keyObject == null ||
            keyObject.optString("kty") != "EC" ||
            keyObject.optString("crv") != "P-256" ||
            keyObject.optString("x").length < 40 ||
            keyObject.optString("y").length < 40
        ) {
            throw IllegalArgumentException("Connection code has an invalid identity key.")
        }
        val sdp = signal.optString("sdp")
        if (sdp.length < 20 || sdp.length > MAX_MANUAL_SIGNAL_BYTES || !sdp.contains("v=0")) {
            throw IllegalArgumentException("Connection code has an invalid session description.")
        }
        val nonce = signal.optString("nonce")
        if (nonce.length < 16) {
            throw IllegalArgumentException("Connection code has an invalid nonce.")
        }
        val createdAt = (signal.opt("createdAt") as? Number)?.toLong() ?: 0L
        if (createdAt <= 0) {
            throw IllegalArgumentException("Connection code has an invalid timestamp.")
        }
        return ManualSignal(
            kind = kind,
            conversationId = expectedConversationId,
            fromUid = fromUid,
            fromDeviceId = fromDeviceId,
            publicKeyJwk = PublicJwk(keyObject.getString("x"), keyObject.getString("y")),
            sdp = sdp,
            nonce = nonce,
            createdAt = createdAt,
        )
    }
}
