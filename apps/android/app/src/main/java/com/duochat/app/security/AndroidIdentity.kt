package com.duochat.app.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.UUID

data class PublicJwk(val x: String, val y: String) {
    fun thumbprintInput(): String = """{"crv":"P-256","kty":"EC","x":"$x","y":"$y"}"""

    fun fingerprint(): String = "$x|$y"

    companion object {
        fun fromFingerprint(value: String): PublicJwk? {
            val parts = value.split('|')
            if (parts.size != 2 || parts[0].isEmpty() || parts[1].isEmpty()) return null
            return PublicJwk(parts[0], parts[1])
        }
    }
}

data class DeviceIdentity(
    val uid: String,
    val deviceId: String,
    val publicJwk: PublicJwk,
)

data class ResolvedPeerKey(
    val key: PublicJwk,
    val source: String,
)

class AndroidIdentityManager(context: Context) {
    private val appContext = context.applicationContext
    private val prefs =
        appContext.getSharedPreferences("duochat.identity.v1", Context.MODE_PRIVATE)

    fun deviceId(): String {
        val existing = prefs.getString("deviceId", null)
        if (existing != null && existing.isNotEmpty()) return existing
        val created = UUID.randomUUID().toString()
        prefs.edit().putString("deviceId", created).apply()
        return created
    }

    fun loadOrCreate(uid: String): DeviceIdentity {
        val alias = aliasFor(uid)
        val keyStore = keyStore()
        if (!keyStore.containsAlias(alias)) {
            val generator = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC,
                "AndroidKeyStore",
            )
            val spec = KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
            )
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build()
            generator.initialize(spec)
            generator.generateKeyPair()
        }
        val certificate = keyStore.getCertificate(alias)
            ?: error("Android Keystore did not return the device certificate.")
        val publicKey = certificate.publicKey as ECPublicKey
        val point = publicKey.w
        val publicJwk = PublicJwk(
            x = SignatureCodec.base64UrlEncode(normalize(point.affineX.toByteArray())),
            y = SignatureCodec.base64UrlEncode(normalize(point.affineY.toByteArray())),
        )
        return DeviceIdentity(uid, deviceId(), publicJwk)
    }

    fun sign(uid: String, challenge: String): String {
        val key = keyStore().getKey(aliasFor(uid), null) as? PrivateKey
            ?: error("Device signing key is unavailable.")
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(key)
        signature.update(challenge.toByteArray(Charsets.UTF_8))
        val raw = SignatureCodec.derToP1363(signature.sign())
        return SignatureCodec.base64UrlEncode(raw)
    }

    /**
     * Kill switch helper: delete the hardware-backed identity signing key for
     * a uid from the Android Keystore. This is cryptographic erasure — the
     * private key becomes unrecoverable even to the app itself.
     */
    fun deleteIdentityKey(uid: String) {
        val alias = aliasFor(uid)
        val keystore = keyStore()
        if (keystore.containsAlias(alias)) {
            keystore.deleteEntry(alias)
        }
    }

    fun verify(publicJwk: PublicJwk, challenge: String, signatureBase64: String): Boolean {
        return try {
            val publicKey = publicKeyFrom(publicJwk)
            val signature = Signature.getInstance("SHA256withECDSA")
            signature.initVerify(publicKey)
            signature.update(challenge.toByteArray(Charsets.UTF_8))
            val bytes = SignatureCodec.signatureBytesToVerify(
                SignatureCodec.base64UrlDecode(signatureBase64),
            )
            signature.verify(bytes)
        } catch (_: Exception) {
            false
        }
    }

    fun cachePeerKey(uid: String, deviceId: String, key: PublicJwk) {
        prefs.edit().putString("peer.$uid.$deviceId", key.fingerprint()).apply()
    }

    fun cachedPeerKey(uid: String, deviceId: String): PublicJwk? =
        PublicJwk.fromFingerprint(prefs.getString("peer.$uid.$deviceId", null) ?: "")

    /**
     * Kill switch helper: remove every locally cached peer trust record for
     * one contact (or all contacts when uid is null). Returns the number of
     * removed pref entries.
     */
    fun erasePeerKey(uid: String?): Int {
        val doomed = prefs.all.keys.filter { key ->
            if (uid == null) key.startsWith("peer.") else key.startsWith("peer.$uid.")
        }
        for (key in doomed) prefs.edit().remove(key).apply()
        return doomed.size
    }

    fun publicKeysEqual(first: PublicJwk?, second: PublicJwk?): Boolean =
        first != null && second != null && first.x == second.x && first.y == second.y

    fun deriveSafetyNumber(first: PublicJwk, second: PublicJwk): String {
        val a = hex(sha256(first.thumbprintInput().toByteArray(Charsets.UTF_8)))
        val b = hex(sha256(second.thumbprintInput().toByteArray(Charsets.UTF_8)))
        val ordered = listOf(a, b).sorted()
        val digest = sha256("${ordered[0]}|${ordered[1]}".toByteArray(Charsets.UTF_8))
        val groups = ArrayList<String>(6)
        for (i in 0 until 6) {
            val offset = i * 3
            val raw = ((digest[offset].toInt() and 0xff) shl 16) or
                ((digest[offset + 1].toInt() and 0xff) shl 8) or
                (digest[offset + 2].toInt() and 0xff)
            val value = raw % 100000
            groups += value.toString().padStart(5, '0')
        }
        return groups.joinToString(" ")
    }

    private fun aliasFor(uid: String): String = "duochat-ec-$uid"

    private fun keyStore(): KeyStore =
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun publicKeyFrom(publicJwk: PublicJwk): PublicKey {
        val parameters = AlgorithmParameters.getInstance("EC").apply {
            init(ECGenParameterSpec("secp256r1"))
        }.getParameterSpec(ECParameterSpec::class.java)
        val x = BigInteger(1, SignatureCodec.base64UrlDecode(publicJwk.x))
        val y = BigInteger(1, SignatureCodec.base64UrlDecode(publicJwk.y))
        val spec = ECPublicKeySpec(ECPoint(x, y), parameters)
        return KeyFactory.getInstance("EC").generatePublic(spec)
    }

    private fun normalize(value: ByteArray): ByteArray {
        var start = 0
        while (start < value.size - 1 && value[start] == 0.toByte()) start += 1
        val trimmed = value.copyOfRange(start, value.size)
        return if (trimmed.size >= 32) {
            trimmed.copyOfRange(trimmed.size - 32, trimmed.size)
        } else {
            ByteArray(32 - trimmed.size) + trimmed
        }
    }

    private fun sha256(data: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(data)

    private fun hex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it) }
}
