package com.duochat.app.security

import android.content.Context
import org.json.JSONObject
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.util.UUID

/** Fixed key-slot name: the key itself is the identity, there is no account to name. */
const val LOCAL_ID = "local"

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

/**
 * [publicJwk] is the ECDSA sign key, [dhJwk] the ECDH identity key, and
 * [identityProof] the sign-key signature binding them. uid is the fingerprint
 * of [dhJwk], so nobody can claim an id without holding its key.
 */
data class DeviceIdentity(
    val uid: String,
    val deviceId: String,
    val publicJwk: PublicJwk,
    val dhJwk: PublicJwk,
    val identityProof: String,
)

/** The one contact whose key is pinned on this device. */
data class PinnedPeer(
    val uid: String,
    val deviceId: String,
    val key: PublicJwk,
)

class AndroidIdentityManager(context: Context) {
    private val appContext = context.applicationContext
    private val prefs =
        appContext.getSharedPreferences("duochat.identity.v1", Context.MODE_PRIVATE)
    private val crypto = LocalCrypto(appContext, LOCAL_ID)

    @Volatile
    private var signPrivate: PrivateKey? = null

    fun deviceId(): String {
        val existing = prefs.getString("deviceId", null)
        if (existing != null && existing.isNotEmpty()) return existing
        val created = UUID.randomUUID().toString()
        prefs.edit().putString("deviceId", created).apply()
        return created
    }

    /**
     * Identity keys are software P-256 keys, stored encrypted under a
     * non-exportable Android Keystore AES key (the same scheme the local
     * message store uses), so a recovery-phrase-derived identity can replace
     * them later.
     */
    @Synchronized
    fun loadOrCreate(): DeviceIdentity {
        var sign = readKey("identity.sign")
        var dh = readKey("identity.dh")
        if (sign == null || dh == null) {
            sign = generateKey().also { writeKey("identity.sign", it) }
            dh = generateKey().also { writeKey("identity.dh", it) }
            prefs.edit().remove("identity.proof").apply()
        }
        signPrivate = privateKeyFrom(sign.d)
        val signPublic = PublicJwk(sign.x, sign.y)
        val dhPublic = PublicJwk(dh.x, dh.y)
        var proof = prefs.getString("identity.proof", null)
        if (proof.isNullOrEmpty()) {
            proof = signBytes(IdentityCodec.identityProofPayload(dhPublic))
            prefs.edit().putString("identity.proof", proof).apply()
        }
        return DeviceIdentity(IdentityCodec.uidFor(dhPublic), deviceId(), signPublic, dhPublic, proof)
    }

    fun sign(challenge: String): String = signBytes(challenge.toByteArray(Charsets.UTF_8))

    fun verify(publicJwk: PublicJwk, challenge: String, signatureBase64: String): Boolean =
        IdentityCodec.verify(publicJwk, challenge.toByteArray(Charsets.UTF_8), signatureBase64)

    fun verifyIdentityProof(sign: PublicJwk, dh: PublicJwk, proof: String): Boolean =
        IdentityCodec.verifyIdentityProof(sign, dh, proof)

    fun uidFor(dh: PublicJwk): String = IdentityCodec.uidFor(dh)

    /**
     * Kill switch helper: delete the identity keys. Without them the old
     * identity can never be used again (restoring needs the recovery phrase).
     */
    fun deleteIdentityKey() {
        signPrivate = null
        prefs.edit()
            .remove("identity.sign")
            .remove("identity.dh")
            .remove("identity.proof")
            .apply()
        val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keystore.containsAlias("duochat-ec-$LOCAL_ID")) {
            keystore.deleteEntry("duochat-ec-$LOCAL_ID")
        }
    }

    /** Pin [key] as the one trusted peer; any previously pinned peer is forgotten. */
    fun pinPeer(uid: String, deviceId: String, key: PublicJwk) {
        val editor = prefs.edit()
        prefs.all.keys.filter { it.startsWith("peer.") }.forEach { editor.remove(it) }
        editor.putString("peer.$uid.$deviceId", key.fingerprint()).apply()
    }

    fun loadPinnedPeer(): PinnedPeer? {
        for ((name, value) in prefs.all) {
            if (!name.startsWith("peer.")) continue
            val rest = name.removePrefix("peer.")
            val dot = rest.indexOf('.')
            if (dot <= 0 || dot == rest.lastIndex) continue
            val key = PublicJwk.fromFingerprint(value as? String ?: "") ?: continue
            return PinnedPeer(rest.substring(0, dot), rest.substring(dot + 1), key)
        }
        return null
    }

    /**
     * Kill switch helper: remove the pinned peer (or only entries for [uid]).
     * Returns the number of removed pref entries.
     */
    fun erasePeerKey(uid: String?): Int {
        val doomed = prefs.all.keys.filter { key ->
            if (uid.isNullOrEmpty()) key.startsWith("peer.") else key.startsWith("peer.$uid.")
        }
        val editor = prefs.edit()
        for (key in doomed) editor.remove(key)
        editor.apply()
        return doomed.size
    }

    fun publicKeysEqual(first: PublicJwk?, second: PublicJwk?): Boolean =
        first != null && second != null && first.x == second.x && first.y == second.y

    fun deriveSafetyNumber(first: PublicJwk, second: PublicJwk): String =
        IdentityCodec.safetyNumber(first, second)

    private class StoredKey(val d: ByteArray, val x: String, val y: String)

    private fun generateKey(): StoredKey {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val pair = generator.generateKeyPair()
        val point = (pair.public as ECPublicKey).w
        return StoredKey(
            d = normalize((pair.private as ECPrivateKey).s.toByteArray()),
            x = SignatureCodec.base64UrlEncode(normalize(point.affineX.toByteArray())),
            y = SignatureCodec.base64UrlEncode(normalize(point.affineY.toByteArray())),
        )
    }

    private fun writeKey(name: String, key: StoredKey) {
        val json = JSONObject()
            .put("d", SignatureCodec.base64UrlEncode(key.d))
            .put("x", key.x)
            .put("y", key.y)
        prefs.edit().putString(name, crypto.encrypt(json.toString())).apply()
    }

    private fun readKey(name: String): StoredKey? {
        val stored = prefs.getString(name, null) ?: return null
        return try {
            val json = JSONObject(crypto.decrypt(stored))
            StoredKey(
                SignatureCodec.base64UrlDecode(json.getString("d")),
                json.getString("x"),
                json.getString("y"),
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun privateKeyFrom(d: ByteArray): PrivateKey {
        val parameters = AlgorithmParameters.getInstance("EC").apply {
            init(ECGenParameterSpec("secp256r1"))
        }.getParameterSpec(ECParameterSpec::class.java)
        return KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, d), parameters))
    }

    private fun signBytes(message: ByteArray): String {
        val key = signPrivate ?: error("Device signing key is unavailable.")
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(key)
        signature.update(message)
        return SignatureCodec.base64UrlEncode(SignatureCodec.derToP1363(signature.sign()))
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
}
