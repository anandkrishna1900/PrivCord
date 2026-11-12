package com.duochat.app.ui

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Saves a received file into the phone's shared storage, with no file picker: photos into Pictures/DuoCord, videos into
 * Movies/DuoCord (both show in the gallery), everything else (voice notes too) into Download/DuoCord.
 * Returns where it went ("Photos", "Downloads"), or null on Android 9 and older, where writing there needs a storage
 * permission: the caller then opens the system "save as" screen instead.
 */
suspend fun saveToDevice(context: Context, name: String, mime: String, bytes: ByteArray): Result<String>? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
    return withContext(Dispatchers.IO) {
        runCatching {
            val type = mime.lowercase()
            val (collection, folder, label) = when {
                type.startsWith("image/") -> Triple(
                    MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), Environment.DIRECTORY_PICTURES, "Photos",
                )
                type.startsWith("video/") -> Triple(
                    MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), Environment.DIRECTORY_MOVIES, "Photos",
                )
                else -> Triple(
                    MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), Environment.DIRECTORY_DOWNLOADS, "Downloads",
                )
            }
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name.ifBlank { "duocord-file" })
                put(MediaStore.MediaColumns.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
                put(MediaStore.MediaColumns.RELATIVE_PATH, "$folder/DuoCord")
                // Hidden from other apps until it is completely written.
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = resolver.insert(collection, values) ?: error("no media entry")
            try {
                resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("no stream")
                resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            } catch (e: Exception) {
                resolver.delete(uri, null, null)
                throw e
            }
            label
        }
    }
}
