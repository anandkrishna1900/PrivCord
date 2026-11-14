package com.duochat.app.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Weekly encrypted backups into a folder the person chose (on the phone, an SD card, or a synced cloud folder). The
 * backup passphrase is kept on the phone encrypted with a Keystore key that never leaves it, so backups can be made
 * with nobody there. The three newest files are kept.
 */
object AutoBackup {
    private const val PREFS = "duochat.autobackup"
    private const val ALIAS = "duochat_autobackup"
    private const val EVERY_MS = 7L * 24 * 3600 * 1000
    private const val KEEP = 3
    private const val PREFIX = "DuoCord-backup-"

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun folder(c: Context): Uri? = prefs(c).getString("tree", null)?.let(Uri::parse)
    fun lastAt(c: Context): Long = prefs(c).getLong("lastAt", 0L)
    fun lastError(c: Context): String? = prefs(c).getString("error", null)

    /** Turn automatic backups on: keep access to [tree] and the passphrase (encrypted). */
    fun enable(c: Context, tree: Uri, passphrase: String) {
        c.contentResolver.takePersistableUriPermission(
            tree, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        prefs(c).edit().putString("tree", tree.toString()).putString("pass", seal(passphrase))
            .putLong("lastAt", 0L).remove("error").commit()
    }

    fun disable(c: Context) {
        folder(c)?.let { runCatching { c.contentResolver.releasePersistableUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) } }
        prefs(c).edit().clear().commit()
        runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS) }
    }

    /** Makes a backup when one is due (or [force]). Returns null when nothing was due, else whether it worked. */
    suspend fun runIfDue(c: Context, export: suspend (String) -> Result<String>, force: Boolean = false): Boolean? {
        val tree = folder(c) ?: return null
        val now = System.currentTimeMillis()
        if (!force && now - lastAt(c) < EVERY_MS) return null
        val pass = prefs(c).getString("pass", null)?.let(::open)
        val result = runCatching {
            checkNotNull(pass) { "The saved passphrase could not be read. Turn automatic backups off and on again." }
            val text = export(pass).getOrThrow()
            val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
            val name = PREFIX + java.text.SimpleDateFormat("yyyy-MM-dd-HHmm", java.util.Locale.ROOT).format(java.util.Date(now)) + ".txt"
            val doc = DocumentsContract.createDocument(c.contentResolver, parent, "text/plain", name)
                ?: error("The folder refused a new file. Choose the folder again.")
            c.contentResolver.openOutputStream(doc)?.use { it.write(text.toByteArray()) } ?: error("Could not write the file.")
            prune(c, tree)
        }
        prefs(c).edit().apply {
            if (result.isSuccess) putLong("lastAt", now).remove("error") else putString("error", result.exceptionOrNull()?.message ?: "Backup failed.")
        }.commit()
        return result.isSuccess
    }

    /** Keep the newest [KEEP] backups this made; older ones go. */
    private fun prune(c: Context, tree: Uri) {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val ours = mutableListOf<Pair<String, String>>()
        c.contentResolver.query(
            children,
            arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME),
            null, null, null,
        )?.use { cur ->
            while (cur.moveToNext()) {
                val name = cur.getString(1) ?: continue
                if (name.startsWith(PREFIX)) ours += cur.getString(0) to name
            }
        }
        for ((id, _) in ours.sortedByDescending { it.second }.drop(KEEP)) {
            runCatching { DocumentsContract.deleteDocument(c.contentResolver, DocumentsContract.buildDocumentUriUsingTree(tree, id)) }
        }
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun seal(text: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return Base64.encodeToString(cipher.iv + cipher.doFinal(text.toByteArray()), Base64.NO_WRAP)
    }

    private fun open(stored: String): String? = runCatching {
        val raw = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
        String(cipher.doFinal(raw, 12, raw.size - 12))
    }.getOrNull()
}
