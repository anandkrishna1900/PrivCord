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
    /** The contact's ECDH identity key; needed to seal blobs to them. Null for pins from older versions. */
    val dh: PublicJwk? = null,
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

    @Volatile
    private var dhPrivate: PrivateKey? = null

    fun hasIdentity(): Boolean = readKey("identity.sign") != null && readKey("identity.dh") != null &&
        !prefs.getString("identity.proof", null).isNullOrEmpty()

    /**
     * Create (or replace) the identity from the 12-word phrase. The phrase is never stored; only the
     * derived private keys are, encrypted under a non-exportable Android Keystore AES key (the same
     * scheme the local message store uses). Returns the uid.
     */
    @Synchronized
    fun createFromPhrase(phrase: String, passphrase: String = ""): String {
        val keys = RecoveryIdentity.derive(phrase, passphrase)
        writeKey("identity.sign", StoredKey(keys.signD, keys.signPub.x, keys.signPub.y))
        writeKey("identity.dh", StoredKey(keys.dhD, keys.dhPub.x, keys.dhPub.y))
        prefs.edit()
            .putString("identity.proof", EcKeys.sign(keys.signD, IdentityCodec.identityProofPayload(keys.dhPub)))
            .apply()
        signPrivate = null
        dhPrivate = null
        return keys.uid
    }

    /** The stored identity, or null on first run (the app then forces the 12-word phrase flow). */
    @Synchronized
    fun load(): DeviceIdentity? {
        val sign = readKey("identity.sign") ?: return null
        val dh = readKey("identity.dh") ?: return null
        val proof = prefs.getString("identity.proof", null)
        if (proof.isNullOrEmpty()) return null
        signPrivate = privateKeyFrom(sign.d)
        dhPrivate = privateKeyFrom(dh.d)
        val dhPublic = PublicJwk(dh.x, dh.y)
        return DeviceIdentity(IdentityCodec.uidFor(dhPublic), deviceId(), PublicJwk(sign.x, sign.y), dhPublic, proof)
    }

    /** ECDH with our identity DH key (used to open sealed blobs). */
    fun dhAgree(peer: PublicJwk): ByteArray =
        EcKeys.agree(dhPrivate ?: error("Identity is not loaded."), peer)

    /** ECDSA-SHA256 over raw bytes with our identity signing key (base64url r||s). */
    fun signRaw(message: ByteArray): String = signBytes(message)

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
        dhPrivate = null
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
    fun pinPeer(uid: String, deviceId: String, key: PublicJwk, dh: PublicJwk? = null) {
        val editor = prefs.edit()
        prefs.all.keys.filter { it.startsWith("peer.") || it.startsWith("peerdh.") }.forEach { editor.remove(it) }
        editor.putString("peer.$uid.$deviceId", key.fingerprint())
        if (dh != null) editor.putString("peerdh.$uid", dh.fingerprint())
        editor.apply()
    }

    fun loadPinnedPeer(): PinnedPeer? {
        for ((name, value) in prefs.all) {
            if (!name.startsWith("peer.")) continue
            val rest = name.removePrefix("peer.")
            val dot = rest.indexOf('.')
            if (dot <= 0 || dot == rest.lastIndex) continue
            val key = PublicJwk.fromFingerprint(value as? String ?: "") ?: continue
            val uid = rest.substring(0, dot)
            val dh = prefs.getString("peerdh.$uid", null)?.let { PublicJwk.fromFingerprint(it) }
            return PinnedPeer(uid, rest.substring(dot + 1), key, dh)
        }
        return null
    }

    /**
     * Kill switch helper: remove the pinned peer (or only entries for [uid]).
     * Returns the number of removed pref entries.
     */
    fun erasePeerKey(uid: String?): Int {
        val doomed = prefs.all.keys.filter { key ->
            if (uid.isNullOrEmpty()) key.startsWith("peer.") || key.startsWith("peerdh.")
            else key.startsWith("peer.$uid.") || key == "peerdh.$uid"
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
