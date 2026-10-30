package com.duochat.app.signaling

import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * BIP-340 Schnorr signatures on secp256k1, only what Nostr events need. Written to the BIP text and
 * checked against vectors from @noble/curves (the library the desktop app uses), both ways.
 * ponytail: affine BigInteger math, not constant time. Event keys are throwaway (a fresh key per
 * event, never reused), so this is acceptable; swap in a constant-time library if long-lived keys are ever signed.
 */
object Schnorr {
    private val P = BigInteger("fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f", 16)
    val N = BigInteger("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16)
    private val G = Point(
        BigInteger("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", 16),
        BigInteger("483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8", 16),
    )
    private val SEVEN = BigInteger.valueOf(7)
    private val random = SecureRandom()

    private data class Point(val x: BigInteger, val y: BigInteger)

    private fun add(p: Point?, q: Point?): Point? {
        if (p == null) return q
        if (q == null) return p
        val lambda = if (p.x == q.x) {
            if ((p.y + q.y).mod(P).signum() == 0) return null
            (BigInteger.valueOf(3) * p.x * p.x).mod(P) * p.y.shiftLeft(1).modInverse(P)
        } else {
            (q.y - p.y).mod(P) * (q.x - p.x).mod(P).modInverse(P)
        }.mod(P)
        val x = (lambda * lambda - p.x - q.x).mod(P)
        return Point(x, (lambda * (p.x - x) - p.y).mod(P))
    }

    private fun mul(point: Point, k: BigInteger): Point? {
        var result: Point? = null
        var addend: Point? = point
        for (i in 0 until k.bitLength()) {
            if (k.testBit(i)) result = add(result, addend)
            addend = add(addend, addend)
        }
        return result
    }

    private fun isEven(p: Point) = !p.y.testBit(0)

    private fun bytes32(v: BigInteger): ByteArray {
        val raw = v.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
        require(raw.size <= 32)
        return ByteArray(32 - raw.size) + raw
    }

    private fun taggedHash(tag: String, vararg parts: ByteArray): ByteArray {
        val sha = MessageDigest.getInstance("SHA-256")
        val tagHash = sha.digest(tag.toByteArray(Charsets.UTF_8))
        sha.update(tagHash)
        sha.update(tagHash)
        for (part in parts) sha.update(part)
        return sha.digest()
    }

    private fun liftX(x: BigInteger): Point? {
        if (x >= P) return null
        val c = (x.pow(3) + SEVEN).mod(P)
        val y = c.modPow(P.add(BigInteger.ONE).shiftRight(2), P)
        if (y.modPow(BigInteger.TWO, P) != c) return null
        return Point(x, if (y.testBit(0)) P - y else y)
    }

    fun newSecretKey(): ByteArray {
        while (true) {
            val candidate = ByteArray(32).also { random.nextBytes(it) }
            val d = BigInteger(1, candidate)
            if (d.signum() > 0 && d < N) return candidate
        }
    }

    /** 32-byte x-only public key. */
    fun publicKey(secretKey: ByteArray): ByteArray {
        val d = BigInteger(1, secretKey)
        require(d.signum() > 0 && d < N) { "Secret key out of range." }
        return bytes32(mul(G, d)!!.x)
    }

    /** [aux] is 32 bytes of randomness; a fixed value gives a reproducible signature (used by tests). */
    fun sign(message: ByteArray, secretKey: ByteArray, aux: ByteArray = ByteArray(32).also { random.nextBytes(it) }): ByteArray {
        require(message.size == 32 && aux.size == 32)
        val d0 = BigInteger(1, secretKey)
        require(d0.signum() > 0 && d0 < N) { "Secret key out of range." }
        val pub = mul(G, d0)!!
        val d = if (isEven(pub)) d0 else N - d0
        val t = bytes32(d).let { dBytes ->
            val h = taggedHash("BIP0340/aux", aux)
            ByteArray(32) { (dBytes[it].toInt() xor h[it].toInt()).toByte() }
        }
        val k0 = BigInteger(1, taggedHash("BIP0340/nonce", t, bytes32(pub.x), message)).mod(N)
        check(k0.signum() != 0) { "Nonce was zero." }
        val r = mul(G, k0)!!
        val k = if (isEven(r)) k0 else N - k0
        val e = BigInteger(1, taggedHash("BIP0340/challenge", bytes32(r.x), bytes32(pub.x), message)).mod(N)
        return bytes32(r.x) + bytes32((k + e * d).mod(N))
    }

    fun verify(signature: ByteArray, message: ByteArray, publicKey: ByteArray): Boolean = try {
        if (signature.size != 64 || message.size != 32 || publicKey.size != 32) false
        else {
            val pub = liftX(BigInteger(1, publicKey))
            val r = BigInteger(1, signature.copyOfRange(0, 32))
            val s = BigInteger(1, signature.copyOfRange(32, 64))
            if (pub == null || r >= P || s >= N) false
            else {
                val e = BigInteger(1, taggedHash("BIP0340/challenge", bytes32(r), bytes32(pub.x), message)).mod(N)
                val sg = mul(G, s)
                val ep = mul(pub, (N - e).mod(N))
                val point = add(sg, ep)
                point != null && isEven(point) && point.x == r
            }
        }
    } catch (_: Exception) {
        false
    }
}
