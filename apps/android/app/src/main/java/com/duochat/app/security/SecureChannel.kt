package com.duochat.app.security

import org.json.JSONObject
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Authenticated, forward-secret encryption for links that are not encrypted themselves (Bluetooth LE).
 * Byte-compatible with packages/protocol/src/connectivity/secureChannel.ts:
 *  - each side sends `sc_hello` = a fresh ephemeral ECDH P-256 key + random nonce, signed with its identity
 *    signing key over `duochat-sc-v1|ownUid|peerUid|canonicalJson(epk)|nonce`;
 *  - the receiver verifies that signature against the PINNED contact's signing key (so only the paired
 *    contact can finish the handshake), then derives one AES-256-GCM key per direction with HKDF-SHA-256
 *    (salt `nonceLow|nonceHigh`, info `duochat-sc-v1|low->high` / `high->low`, low = smaller uid);
 *  - frames are `sc_data` with a strictly increasing counter `n` (IV = 4 zero bytes + 8-byte big-endian n,
 *    AAD `sc|n`); replayed, reordered or tampered frames are rejected.
 * Not thread safe by itself: callers serialize (SecureBleLink holds a lock).
 */
class SecureChannel private constructor(
    private val ownUid: String,
    private val peerUid: String,
    /** Signs raw bytes with our ECDSA identity key; returns base64url(r||s). */
    private val sign: (ByteArray) -> String,
    private val peerSign: PublicJwk,
    private val eph: EcKeys.Ephemeral,
    private val nonce: String,
) {
    private var sendKey: SecretKeySpec? = null
    private var recvKey: SecretKeySpec? = null
    private var sendCounter = 0L
    private var recvCounter = -1L

    val ready: Boolean get() = sendKey != null && recvKey != null

    fun hello(): JSONObject {
        val epk = epkJson(eph.public)
        val sig = sign(helloPayload(ownUid, peerUid, epk, nonce))
        return JSONObject().put("v", 1).put("kind", KIND_HELLO).put("epk", epk).put("nonce", nonce).put("sig", sig)
    }

    /** Verifies the peer's signed ephemeral key and derives both directions' keys. Throws if it is not the pinned contact. */
    fun accept(hello: JSONObject) {
        check(!ready) { "Secure channel already established." }
        val parsed = parseHello(hello) ?: throw IllegalArgumentException("Malformed secure channel hello.")
        val (epk, theirNonce, sig) = parsed
        // The peer signed (its uid | our uid), so the order is swapped when verifying.
        if (!IdentityCodec.verify(peerSign, helloPayload(peerUid, ownUid, epkJson(epk), theirNonce), sig)) {
            throw SecurityException("Secure channel handshake was not signed by the paired contact.")
        }
        val shared = EcKeys.agree(eph.privateKey, epk)
        val lowIsMe = ownUid < peerUid
        val (nLow, nHigh) = if (lowIsMe) nonce to theirNonce else theirNonce to nonce
        val salt = "$nLow|$nHigh".toByteArray(Charsets.UTF_8)
        val low = RecoveryIdentity.hkdf(shared, salt, "duochat-sc-v1|low->high".toByteArray(Charsets.UTF_8), 32)
        val high = RecoveryIdentity.hkdf(shared, salt, "duochat-sc-v1|high->low".toByteArray(Charsets.UTF_8), 32)
        sendKey = SecretKeySpec(if (lowIsMe) low else high, "AES")
        recvKey = SecretKeySpec(if (lowIsMe) high else low, "AES")
    }

    fun encrypt(value: JSONObject): JSONObject = encryptText(value.toString())

    /** [plaintext] is the exact JSON text to protect (TypeScript uses `JSON.stringify(value)`). */
    fun encryptText(plaintext: String): JSONObject {
        val key = sendKey ?: throw IllegalStateException("Secure channel is not established.")
        check(sendCounter < MAX_COUNTER) { "Secure channel exhausted; reconnect." }
        val n = sendCounter++
        val ct = gcm(Cipher.ENCRYPT_MODE, key, n).doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return JSONObject().put("v", 1).put("kind", KIND_DATA).put("n", n).put("ct", SignatureCodec.base64UrlEncode(ct))
    }

    /** Returns the plaintext JSON text. Rejects tampering, wrong keys, and any replayed or reordered counter. */
    fun decryptText(frame: JSONObject): String {
        val key = recvKey ?: throw IllegalStateException("Secure channel is not established.")
        val n = (frame.opt("n") as? Number)?.toLong() ?: throw IllegalArgumentException("Malformed secure channel frame.")
        val ct = frame.optString("ct")
        require(n in 0..MAX_COUNTER && ct.isNotEmpty() && frame.optString("kind") == KIND_DATA) { "Malformed secure channel frame." }
        if (n <= recvCounter) throw SecurityException("Replayed or out-of-order frame.")
        val plain = gcm(Cipher.DECRYPT_MODE, key, n).doFinal(SignatureCodec.base64UrlDecode(ct))
        recvCounter = n
        return String(plain, Charsets.UTF_8)
    }

    private fun gcm(mode: Int, key: SecretKeySpec, n: Long): Cipher {
        val iv = ByteArray(12)
        for (i in 0 until 8) iv[11 - i] = (n ushr (8 * i)).toByte()
        return Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, key, GCMParameterSpec(128, iv))
            updateAAD("sc|$n".toByteArray(Charsets.UTF_8))
        }
    }

    companion object {
        const val KIND_HELLO = "sc_hello"
        const val KIND_DATA = "sc_data"
        private const val MAX_COUNTER = 1L shl 48
        private val random = SecureRandom()

        fun create(
            ownUid: String,
            peerUid: String,
            sign: (ByteArray) -> String,
            peerSign: PublicJwk,
            /** TEST ONLY: fixed ephemeral key and nonce so the exact bytes can be compared with TypeScript. */
            testEphemeral: EcKeys.Ephemeral? = null,
            testNonce: String? = null,
        ): SecureChannel = SecureChannel(
            ownUid, peerUid, sign, peerSign,
            testEphemeral ?: EcKeys.generateEphemeral(),
            testNonce ?: SignatureCodec.base64UrlEncode(ByteArray(16).also { random.nextBytes(it) }),
        )

        fun isHello(frame: JSONObject): Boolean = frame.optInt("v", -1) == 1 && frame.optString("kind") == KIND_HELLO
        fun isData(frame: JSONObject): Boolean = frame.optInt("v", -1) == 1 && frame.optString("kind") == KIND_DATA

        private fun epkJson(key: PublicJwk) = JSONObject().put("kty", "EC").put("crv", "P-256").put("x", key.x).put("y", key.y)

        /** Same text as TypeScript: keys of the ephemeral JWK sorted (crv, kty, x, y). */
        private fun helloPayload(signerUid: String, otherUid: String, epk: JSONObject, nonce: String): ByteArray =
            "duochat-sc-v1|$signerUid|$otherUid|${CanonicalJson.of(mapOf("crv" to epk.optString("crv"), "kty" to epk.optString("kty"), "x" to epk.optString("x"), "y" to epk.optString("y")))}|$nonce"
                .toByteArray(Charsets.UTF_8)

        private fun parseHello(hello: JSONObject): Triple<PublicJwk, String, String>? {
            if (!isHello(hello)) return null
            val epk = hello.optJSONObject("epk")?.let { Seal.jwkOrNull(it) } ?: return null
            val nonce = hello.optString("nonce")
            val sig = hello.optString("sig")
            if (nonce.length < 16 || sig.isEmpty()) return null
            return Triple(epk, nonce, sig)
        }

        /** Builds an Ephemeral from a private scalar and its public JWK (used by tests with fixed keys). */
        fun ephemeralFrom(d: ByteArray, public: PublicJwk) = EcKeys.Ephemeral(EcKeys.privateKey(d), public)
    }
}
