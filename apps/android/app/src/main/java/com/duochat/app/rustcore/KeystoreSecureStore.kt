package com.duochat.app.rustcore

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import uniffi.privcord_ffi.DatabaseKeyRead
import uniffi.privcord_ffi.SecureStoreCallbacks
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Where the Rust engine keeps the identity's private scalars (64 bytes). They are encrypted with an AES-GCM key that never
 * leaves the Android Keystore; only the ciphertext is stored (in app-private preferences). [slot] names both the key and
 * the preferences file, so a throwaway instance (the probe) never shares anything with the real one.
 */
class KeystoreSecureStore(context: Context, private val slot: String) : SecureStoreCallbacks {
    private val prefs = context.applicationContext.getSharedPreferences("rust_secure_$slot", Context.MODE_PRIVATE)
    private val alias = "duochat_rust_$slot"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    override fun loadIdentity(): ByteArray? {
        val stored = prefs.getString("identity", null) ?: return null
        return runCatching {
            val raw = Base64.decode(stored, Base64.NO_WRAP)
            val iv = raw.copyOfRange(0, 12)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            cipher.doFinal(raw, 12, raw.size - 12)
        }.getOrNull()
    }

    override fun saveIdentity(secrets: ByteArray): Boolean = runCatching {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val out = cipher.iv + cipher.doFinal(secrets)
        prefs.edit().putString("identity", Base64.encodeToString(out, Base64.NO_WRAP)).commit()
    }.getOrDefault(false)

    override fun deleteIdentity() {
        prefs.edit().remove("identity").commit()
        runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias) }
    }

    /*
     * The database key (SQLCipher) lives in its own Keystore key and preference, so deleting the identity can never
     * make the database unreadable. Only wiping the app's data (or the emergency erase, which deletes the database
     * too) removes it.
     */
    private val dbAlias = "${alias}_database"

    private fun dbKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(dbAlias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(dbAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    /**
     * Only a key that is not there, or can never be read again, is [DatabaseKeyRead.Missing] (the engine then sets the
     * old database aside and starts a new one). Anything that may pass (the Keystore busy or failing right now) is
     * [DatabaseKeyRead.Unavailable]: the engine does not start and nothing is replaced, so "Try again" can still open
     * the chats.
     */
    override fun loadDatabaseKey(): DatabaseKeyRead {
        val stored = prefs.getString("database", null) ?: return DatabaseKeyRead.Missing
        return try {
            val raw = Base64.decode(stored, Base64.NO_WRAP)
            if (raw.size <= 12 + 16) return DatabaseKeyRead.Missing
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            // Reading never creates a key: a missing Keystore key means this one is gone for good.
            val secret = ks.getKey(dbAlias, null) as? SecretKey ?: return DatabaseKeyRead.Missing
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(128, raw, 0, 12))
            DatabaseKeyRead.Found(cipher.doFinal(raw, 12, raw.size - 12))
        } catch (gone: android.security.keystore.KeyPermanentlyInvalidatedException) {
            DatabaseKeyRead.Missing
        } catch (gone: java.security.UnrecoverableKeyException) {
            DatabaseKeyRead.Missing
        } catch (gone: javax.crypto.AEADBadTagException) {
            DatabaseKeyRead.Missing
        } catch (gone: IllegalArgumentException) {
            DatabaseKeyRead.Missing // the stored text is not base64: it can never be read
        } catch (busy: Exception) {
            DatabaseKeyRead.Unavailable
        }
    }

    /** Crypto-erasure of the database key (emergency erase, after the database file is deleted). */
    fun deleteDatabaseKey() {
        prefs.edit().remove("database").commit()
        runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(dbAlias) }
    }

    override fun saveDatabaseKey(key: ByteArray): Boolean = runCatching {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, dbKey())
        val out = cipher.iv + cipher.doFinal(key)
        prefs.edit().putString("database", Base64.encodeToString(out, Base64.NO_WRAP)).commit()
    }.getOrDefault(false)
}
