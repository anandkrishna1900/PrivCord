package com.duochat.app.security

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec
import javax.crypto.KeyAgreement

/** Small JCA wrappers around raw P-256 private scalars (what the identity store keeps). */
object EcKeys {
    fun privateKey(d: ByteArray): PrivateKey {
        val parameters = AlgorithmParameters.getInstance("EC").apply {
            init(ECGenParameterSpec("secp256r1"))
        }.getParameterSpec(ECParameterSpec::class.java)
        return KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, d), parameters))
    }

    /** ECDSA-SHA256, base64url of the raw r||s (what WebCrypto produces and verifies). */
    fun sign(d: ByteArray, message: ByteArray): String = sign(privateKey(d), message)

    fun sign(key: PrivateKey, message: ByteArray): String {
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(key)
        signature.update(message)
        return SignatureCodec.base64UrlEncode(SignatureCodec.derToP1363(signature.sign()))
    }

    /** ECDH shared secret (32 bytes, the x coordinate) with a peer public key. */
    fun agree(d: ByteArray, peer: PublicJwk): ByteArray = agree(privateKey(d), peer)

    fun agree(key: PrivateKey, peer: PublicJwk): ByteArray {
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(key)
        agreement.doPhase(IdentityCodec.publicKeyFrom(peer), true)
        return agreement.generateSecret()
    }

    class Ephemeral(val privateKey: PrivateKey, val public: PublicJwk)

    fun generateEphemeral(): Ephemeral {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val pair = generator.generateKeyPair()
        val point = (pair.public as ECPublicKey).w
        return Ephemeral(
            pair.private,
            PublicJwk(
                SignatureCodec.base64UrlEncode(P256.toBytes(point.affineX)),
                SignatureCodec.base64UrlEncode(P256.toBytes(point.affineY)),
            ),
        )
    }
}
