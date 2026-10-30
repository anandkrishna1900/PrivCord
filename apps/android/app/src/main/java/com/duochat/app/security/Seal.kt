package com.duochat.app.security

import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * A signed, encrypted payload addressed to one contact. Relays only ever see this. Mirrors
 * packages/protocol/src/connectivity/seal.ts exactly (ECDH P-256 -> HKDF -> AES-256-GCM, ECDSA signature).
 */
class SealedBlob(
    val to: String,
    val from: String,
    /** Kept as received: the signature covers whatever fields the sender put here. */
    val epk: JSONObject,
    val iv: String,
    val ct: String,
    val sig: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("v", 1).put("to", to).put("from", from).put("epk", epk)
        .put("iv", iv).put("ct", ct).put("sig", sig)
}

object Seal {
    const val MAX_BLOB_BYTES = 64 * 1024
    private const val SEAL_SALT = "duochat-seal-v1"
    private const val MAILBOX_PREFIX = "duochat-mailbox-v1|"
    private val random = SecureRandom()

    fun mailboxFor(uid: String): String =
        MessageDigest.getInstance("SHA-256").digest((MAILBOX_PREFIX + uid).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    private fun signedPart(v: Int, to: String, from: String, epk: JSONObject, iv: String, ct: String): ByteArray =
        CanonicalJson.of(
            mapOf("v" to v, "to" to to, "from" to from, "epk" to epk, "iv" to iv, "ct" to ct),
        ).toByteArray(Charsets.UTF_8)

    private fun key(secret: ByteArray, to: String, from: String): SecretKeySpec = SecretKeySpec(
        RecoveryIdentity.hkdf(secret, SEAL_SALT.toByteArray(Charsets.UTF_8), "$to|$from".toByteArray(Charsets.UTF_8), 32),
        "AES",
    )

    private fun gcm(mode: Int, key: SecretKeySpec, iv: ByteArray, aad: ByteArray): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, key, GCMParameterSpec(128, iv))
            updateAAD(aad)
        }

    /** [sign] signs raw bytes with the sender's ECDSA identity key and returns base64url(r||s). */
    fun seal(payload: JSONObject, fromUid: String, toUid: String, toDh: PublicJwk, sign: (ByteArray) -> String): SealedBlob {
        val eph = EcKeys.generateEphemeral()
        val spec = key(EcKeys.agree(eph.privateKey, toDh), toUid, fromUid)
        val iv = ByteArray(12).also { random.nextBytes(it) }
        val aad = "$toUid|$fromUid".toByteArray(Charsets.UTF_8)
        val ct = gcm(Cipher.ENCRYPT_MODE, spec, iv, aad).doFinal(payload.toString().toByteArray(Charsets.UTF_8))
        val epk = JSONObject().put("kty", "EC").put("crv", "P-256").put("x", eph.public.x).put("y", eph.public.y)
        val ivB64 = SignatureCodec.base64UrlEncode(iv)
        val ctB64 = SignatureCodec.base64UrlEncode(ct)
        val sig = sign(signedPart(1, toUid, fromUid, epk, ivB64, ctB64))
        val blob = SealedBlob(toUid, fromUid, epk, ivB64, ctB64, sig)
        require(encode(blob).length <= MAX_BLOB_BYTES) { "Payload too large to seal." }
        return blob
    }

    /**
     * The payload, or null for anything not addressed to us, not from the pinned sender, or tampered.
     * [agree] is ECDH with our identity DH private key.
     */
    fun open(blob: SealedBlob, ownUid: String, agree: (PublicJwk) -> ByteArray, senderSign: PublicJwk, senderUid: String): JSONObject? {
        return try {
            if (blob.to != ownUid || blob.from != senderUid) return null
            val epk = jwkOrNull(blob.epk) ?: return null
            if (!IdentityCodec.verify(senderSign, signedPart(1, blob.to, blob.from, blob.epk, blob.iv, blob.ct), blob.sig)) return null
            val spec = key(agree(epk), blob.to, blob.from)
            val plain = gcm(
                Cipher.DECRYPT_MODE, spec, SignatureCodec.base64UrlDecode(blob.iv),
                "${blob.to}|${blob.from}".toByteArray(Charsets.UTF_8),
            ).doFinal(SignatureCodec.base64UrlDecode(blob.ct))
            JSONObject(String(plain, Charsets.UTF_8))
        } catch (_: Exception) {
            null
        }
    }

    fun encode(blob: SealedBlob): String =
        SignatureCodec.base64UrlEncode(blob.toJson().toString().toByteArray(Charsets.UTF_8))

    fun decode(text: String): SealedBlob? = try {
        val json = JSONObject(String(SignatureCodec.base64UrlDecode(text), Charsets.UTF_8))
        val epk = json.optJSONObject("epk")
        if (json.optInt("v", -1) != 1 || epk == null || jwkOrNull(epk) == null) null
        else SealedBlob(
            json.getString("to"), json.getString("from"), epk,
            json.getString("iv"), json.getString("ct"), json.getString("sig"),
        )
    } catch (_: Exception) {
        null
    }

    fun jwkOrNull(json: JSONObject): PublicJwk? =
        if (json.optString("kty") == "EC" && json.optString("crv") == "P-256" &&
            json.optString("x").isNotEmpty() && json.optString("y").isNotEmpty()
        ) PublicJwk(json.getString("x"), json.getString("y")) else null
}
