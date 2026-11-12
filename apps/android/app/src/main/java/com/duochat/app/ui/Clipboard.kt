package com.duochat.app.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle

/**
 * Copies [text] marked sensitive: Android 13+ hides it from the clipboard preview and keyboards' suggestions. With
 * [clearAfterMs], the copy is removed again after that long, if it is still ours (invite words and connection codes do
 * not belong in clipboard history).
 */
fun copySensitive(context: Context, label: String, text: String, clearAfterMs: Long? = null) {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
    val clip = ClipData.newPlainText(label, text)
    clip.description.extras = PersistableBundle().apply {
        val key = if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE"
        putBoolean(key, true)
    }
    runCatching { clipboard.setPrimaryClip(clip) }
    if (clearAfterMs != null) {
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            runCatching {
                val now = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()
                if (now == text) {
                    if (Build.VERSION.SDK_INT >= 28) clipboard.clearPrimaryClip()
                    else clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
                }
            }
        }, clearAfterMs)
    }
}
