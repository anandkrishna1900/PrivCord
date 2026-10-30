package com.duochat.app.security

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec

/**
 * Pure-JVM identity helpers shared with the desktop/protocol implementation
 * (packages/protocol/src/e2ee/x3dh.ts). No Android APIs, so they are unit-testable.
 */
object IdentityCodec {
    private const val IDENTITY_PROOF_PREFIX = "duochat-identity-proof-v1\n"

    /** uid = SHA-256 hex of "EC|P-256|" + x bytes + "|" + y bytes of the ECDH identity key. */
    fun uidFor(dh: PublicJwk): String {
        val input = "EC|P-256|".toByteArray(Charsets.UTF_8) +
            SignatureCodec.base64UrlDecode(dh.x) +
            "|".toByteArray(Charsets.UTF_8) +
            SignatureCodec.base64UrlDecode(dh.y)
        return MessageDigest.getInstance("SHA-256").digest(input)
            .joinToString("") { "%02x".format(it) }
    }

    /** The bytes the sign key signs to bind the ECDH identity key to itself. */
    fun identityProofPayload(dh: PublicJwk): ByteArray =
        (IDENTITY_PROOF_PREFIX + dh.thumbprintInput()).toByteArray(Charsets.UTF_8)

    fun verifyIdentityProof(sign: PublicJwk, dh: PublicJwk, proofB64: String): Boolean =
        verify(sign, identityProofPayload(dh), proofB64)

    fun verify(publicJwk: PublicJwk, message: ByteArray, signatureB64: String): Boolean =
        try {
            val signature = Signature.getInstance("SHA256withECDSA")
            signature.initVerify(publicKeyFrom(publicJwk))
            signature.update(message)
            signature.verify(
                SignatureCodec.signatureBytesToVerify(SignatureCodec.base64UrlDecode(signatureB64)),
            )
        } catch (_: Exception) {
            false
        }

    fun publicKeyFrom(publicJwk: PublicJwk): java.security.PublicKey {
        val parameters = AlgorithmParameters.getInstance("EC").apply {
            init(ECGenParameterSpec("secp256r1"))
        }.getParameterSpec(ECParameterSpec::class.java)
        val x = BigInteger(1, SignatureCodec.base64UrlDecode(publicJwk.x))
        val y = BigInteger(1, SignatureCodec.base64UrlDecode(publicJwk.y))
        return KeyFactory.getInstance("EC")
            .generatePublic(ECPublicKeySpec(ECPoint(x, y), parameters))
    }

    /** Six five-digit groups from both sign keys; both users compare them out of band. */
    fun safetyNumber(first: PublicJwk, second: PublicJwk): String {
        fun sha(data: ByteArray) = MessageDigest.getInstance("SHA-256").digest(data)
        fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
        val a = hex(sha(first.thumbprintInput().toByteArray(Charsets.UTF_8)))
        val b = hex(sha(second.thumbprintInput().toByteArray(Charsets.UTF_8)))
        val ordered = listOf(a, b).sorted()
        val digest = sha("${ordered[0]}|${ordered[1]}".toByteArray(Charsets.UTF_8))
        return (0 until 6).joinToString(" ") { i ->
            val offset = i * 3
            val raw = ((digest[offset].toInt() and 0xff) shl 16) or
                ((digest[offset + 1].toInt() and 0xff) shl 8) or
                (digest[offset + 2].toInt() and 0xff)
            (raw % 100000).toString().padStart(5, '0')
        }
    }
}
