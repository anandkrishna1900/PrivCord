package com.duochat.app.security

import java.math.BigInteger
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Identity from the 12-word phrase. Same derivation as packages/protocol/src/recovery/identity.ts,
 * so a phrase gives the same keys and uid on Android and desktop (checked against shared vectors).
 */
object RecoveryIdentity {
    private const val SALT = "DuoChat-Recovery-Trust-v1"
    private const val PREFIX = "duochat-derive-v1"

    class Keys(
        val signD: ByteArray,
        val signPub: PublicJwk,
        val dhD: ByteArray,
        val dhPub: PublicJwk,
    ) {
        val uid: String get() = IdentityCodec.uidFor(dhPub)
    }

    fun derive(phrase: String, passphrase: String = ""): Keys {
        val seed = Bip39.seed(phrase, passphrase)
        val signD = scalar(seed, "identity-sign")
        val dhD = scalar(seed, "identity-agreement")
        return Keys(signD, P256.publicFor(signD), dhD, P256.publicFor(dhD))
    }

    fun keyMaterial(seed: ByteArray, purpose: String): ByteArray =
        hkdf(seed, SALT.toByteArray(Charsets.UTF_8), "$PREFIX/$purpose".toByteArray(Charsets.UTF_8), 32)

    private fun scalar(seed: ByteArray, purpose: String): ByteArray {
        val d = BigInteger(1, keyMaterial(seed, purpose)).mod(P256.N)
        check(d.signum() != 0) { "Derived scalar was zero; use another phrase." }
        return P256.toBytes(d)
    }

    /** RFC 5869 HKDF-SHA-256 (extract then expand). */
    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 1..255 * 32)
        val hmac = Mac.getInstance("HmacSHA256")
        hmac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
        val prk = hmac.doFinal(ikm)
        hmac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = java.io.ByteArrayOutputStream()
        var block = ByteArray(0)
        var counter = 1
        while (out.size() < length) {
            hmac.update(block)
            hmac.update(info)
            hmac.update(counter.toByte())
            block = hmac.doFinal()
            out.write(block)
            counter += 1
        }
        return out.toByteArray().copyOf(length)
    }
}

/**
 * P-256 public point from a private scalar (the JCA cannot do this). Textbook affine double-and-add,
 * only run once per phrase entry. ponytail: not constant time; fine for a one-off local derivation,
 * switch to a constant-time library if this ever runs on attacker-chosen input in a loop.
 */
object P256 {
    val P = BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16)
    val N = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)
    private val B = BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16)
    private val GX = BigInteger("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", 16)
    private val GY = BigInteger("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", 16)
    private val THREE = BigInteger.valueOf(3)

    private data class Point(val x: BigInteger, val y: BigInteger)

    private fun add(p: Point?, q: Point?): Point? {
        if (p == null) return q
        if (q == null) return p
        val lambda = if (p.x == q.x) {
            if ((p.y + q.y).mod(P).signum() == 0) return null
            (THREE * p.x * p.x - THREE).mod(P) * (p.y.shiftLeft(1)).modInverse(P)
        } else {
            (q.y - p.y).mod(P) * (q.x - p.x).mod(P).modInverse(P)
        }.mod(P)
        val x = (lambda * lambda - p.x - q.x).mod(P)
        return Point(x, (lambda * (p.x - x) - p.y).mod(P))
    }

    fun toBytes(value: BigInteger): ByteArray {
        val raw = value.toByteArray()
        val trimmed = raw.dropWhile { it == 0.toByte() }.toByteArray()
        require(trimmed.size <= 32)
        return ByteArray(32 - trimmed.size) + trimmed
    }

    fun publicFor(scalar: ByteArray): PublicJwk {
        require(scalar.size == 32) { "P-256 scalar must be 32 bytes." }
        val d = BigInteger(1, scalar)
        require(d.signum() > 0 && d < N) { "P-256 scalar out of range." }
        var result: Point? = null
        var addend: Point? = Point(GX, GY)
        for (i in 0 until 256) {
            if (d.testBit(i)) result = add(result, addend)
            addend = add(addend, addend)
        }
        val point = result ?: error("Point at infinity.")
        check((point.y * point.y).mod(P) == (point.x * point.x * point.x - THREE * point.x + B).mod(P)) {
            "Derived point is off the curve."
        }
        return PublicJwk(
            SignatureCodec.base64UrlEncode(toBytes(point.x)),
            SignatureCodec.base64UrlEncode(toBytes(point.y)),
        )
    }
}
