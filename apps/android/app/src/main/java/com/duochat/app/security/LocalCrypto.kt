package com.duochat.app.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class LocalCrypto(context: Context, uid: String) {
    private val alias = "duochat-aes-$uid"

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = keyStore.getKey(alias, null) as? SecretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore",
        )
        val spec = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        generator.init(spec)
        return generator.generateKey()
    }

    fun encrypt(text: String): String {
        if (text.isEmpty()) return text
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val ciphertext = cipher.doFinal(text.toByteArray(Charsets.UTF_8))
        val iv = SignatureCodec.base64UrlEncode(cipher.iv)
        val body = SignatureCodec.base64UrlEncode(ciphertext)
        return PREFIX + iv + "." + body
    }

    /**
     * Kill switch helper: delete the AES local-encryption key from the
     * Android Keystore. Any ciphertext previously sealed with it becomes
     * permanently undecryptable (crypto-erasure).
     */
    fun deleteKey() {
        val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keystore.containsAlias(alias)) {
            keystore.deleteEntry(alias)
        }
    }

    fun decrypt(payload: String): String {
        if (!payload.startsWith(PREFIX)) return payload
        val parts = payload.removePrefix(PREFIX).split('.')
        require(parts.size == 2) { "Malformed encrypted message." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            secretKey(),
            GCMParameterSpec(128, SignatureCodec.base64UrlDecode(parts[0])),
        )
        val plaintext = cipher.doFinal(SignatureCodec.base64UrlDecode(parts[1]))
        return String(plaintext, Charsets.UTF_8)
    }

    private companion object {
        const val PREFIX = "enc1."
    }
}
