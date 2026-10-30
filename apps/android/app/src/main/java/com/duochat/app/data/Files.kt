package com.duochat.app.data

import com.duochat.app.security.SignatureCodec
import org.json.JSONObject
import java.security.MessageDigest

/*
 * Replies and file sharing. Port of packages/protocol/src/files.ts and the reply parts of message.ts;
 * the frames are byte-compatible (see docs/file-vectors.json and FilesTest).
 *
 * A file goes straight to each recipient over the already-authenticated WebRTC link, so it gets the same
 * end-to-end protection as a message. No server stores it. Not sent over Bluetooth or the offline relay.
 * Flow: file_offer -> file_chunk x N (in order) -> receiver verifies size + SHA-256 -> `ack` (DELIVERED).
 */

/** Hard limit on group size, including the creator. */
const val MAX_GROUP_MEMBERS = 10
const val MAX_FILE_BYTES = 8 * 1024 * 1024
const val FILE_CHUNK_BYTES = 12 * 1024
const val MAX_REPLY_PREVIEW = 120
const val MAX_FILE_NAME = 120
const val MAX_INCOMING_PER_PEER = 2
const val MAX_FILE_CHUNKS = (MAX_FILE_BYTES + FILE_CHUNK_BYTES - 1) / FILE_CHUNK_BYTES

enum class MessageType(val wire: String) {
    TEXT("text"),
    FILE("file");

    companion object {
        fun fromWire(value: String?): MessageType = entries.firstOrNull { it.wire == value } ?: TEXT
    }
}

/** What a reply quotes. The snippet travels with the reply so it still shows if the original is missing. */
data class ReplyRef(val id: String, val author: String, val preview: String) {
    fun toJson(): JSONObject = JSONObject().put("id", id).put("author", author).put("preview", preview)

    companion object {
        fun fromJson(value: Any?): ReplyRef? {
            val o = value as? JSONObject ?: return null
            val id = o.opt("id") as? String
            val author = o.opt("author") as? String
            val preview = o.opt("preview") as? String
            if (!isValidClientMessageId(id) || author.isNullOrEmpty() || author.length > 128) return null
            if (preview == null || countCodePoints(preview) > MAX_REPLY_PREVIEW) return null
            return ReplyRef(id!!, author, preview)
        }
    }
}

fun makeReplyRef(message: ChatMessage): ReplyRef {
    val cut = message.text.offsetByCodePoints(0, minOf(MAX_REPLY_PREVIEW, countCodePoints(message.text)))
    return ReplyRef(message.messageId, message.senderId, message.text.substring(0, cut))
}

data class FileMeta(val name: String, val mime: String, val size: Int, val sha256: String) {
    fun toJson(): JSONObject = JSONObject().put("name", name).put("mime", mime).put("size", size).put("sha256", sha256)

    companion object {
        fun fromJson(o: JSONObject?): FileMeta? =
            if (o == null) null else FileMeta(o.optString("name"), o.optString("mime"), o.optInt("size"), o.optString("sha256"))
    }
}

/** The receiver refused a message or file. */
enum class DeclineReason(val wire: String) {
    DIRECT_NOT_ACCEPTED("direct_not_accepted"),
    TOO_LARGE("too_large"),
    BAD_FILE("bad_file"),
    BUSY("busy");

    companion object {
        fun fromWire(value: String?): DeclineReason? = entries.firstOrNull { it.wire == value }
    }
}

fun declinedFrame(messageId: String, reason: DeclineReason): JSONObject =
    JSONObject().put("v", 1).put("kind", "declined").put("messageId", messageId).put("reason", reason.wire)

fun parseDeclined(frame: JSONObject): Pair<String, DeclineReason>? {
    if (frame.optString("kind") != "declined") return null
    val id = frame.optString("messageId")
    if (!isValidClientMessageId(id)) return null
    val reason = DeclineReason.fromWire(frame.optString("reason")) ?: return null
    return id to reason
}

/** Image types that are safe to preview inline. SVG is excluded on purpose: it can carry script. */
private val INLINE_IMAGES = setOf("image/png", "image/jpeg", "image/gif", "image/webp")

fun isInlineImage(mime: String): Boolean = mime.lowercase() in INLINE_IMAGES

/** Video types that play inline. Decoding is done by the system's own media stack. */
private val INLINE_VIDEOS = setOf("video/mp4", "video/webm", "video/quicktime", "video/ogg")

fun isInlineVideo(mime: String): Boolean = mime.lowercase() in INLINE_VIDEOS

/** A file name that is safe to show and to save under: no path, no control characters, bounded length. */
fun sanitizeFileName(raw: String): String {
    var name = raw.replace(Regex("[\\u0000-\\u001f\\u007f\\\\/:*?\"<>|]"), "_")
        .replace(Regex("^[.\\s]+"), "").trim()
    if (countCodePoints(name) > MAX_FILE_NAME) {
        val dot = name.lastIndexOf('.')
        val ext = if (dot > 0 && name.length - dot <= 12) name.substring(dot) else ""
        val keep = MAX_FILE_NAME - countCodePoints(ext)
        name = name.substring(0, name.offsetByCodePoints(0, keep)) + ext
    }
    return name.ifEmpty { "file" }
}

private val MIME_RE = Regex("^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$", RegexOption.IGNORE_CASE)

/** Only well-formed `type/subtype` strings are kept; anything else is treated as unknown. */
fun sanitizeMime(raw: String): String = if (MIME_RE.matches(raw)) raw.lowercase() else "application/octet-stream"

fun validateFileSize(size: Int): String? = when {
    size <= 0 -> "That file is empty."
    size > MAX_FILE_BYTES -> "Files can be at most ${formatBytes(MAX_FILE_BYTES)}."
    else -> null
}

fun formatBytes(n: Int): String = when {
    n < 1024 -> "$n B"
    n < 1024 * 1024 -> String.format(java.util.Locale.US, "%.${if (n < 10 * 1024) 1 else 0}f KB", n / 1024.0)
    else -> String.format(java.util.Locale.US, "%.1f MB", n / (1024.0 * 1024.0))
}

fun filePreviewText(name: String): String = "📎 $name".let {
    it.substring(0, it.offsetByCodePoints(0, minOf(MAX_REPLY_PREVIEW, countCodePoints(it))))
}

fun sha256B64(bytes: ByteArray): String =
    SignatureCodec.base64UrlEncode(MessageDigest.getInstance("SHA-256").digest(bytes))

data class FileOffer(
    val messageId: String,
    val groupId: String?,
    val name: String,
    val mime: String,
    val size: Int,
    val sha256: String,
    val clientCreatedAt: Long,
    val replyTo: ReplyRef?,
) {
    fun toJson(): JSONObject = JSONObject().put("v", 1).put("kind", "file_offer").put("messageId", messageId)
        .also { if (groupId != null) it.put("groupId", groupId) }
        .put("name", name).put("mime", mime).put("size", size).put("sha256", sha256)
        .put("clientCreatedAt", clientCreatedAt)
        .also { if (replyTo != null) it.put("replyTo", replyTo.toJson()) }

    companion object {
        fun create(
            messageId: String, groupId: String?, name: String, mime: String, bytes: ByteArray,
            clientCreatedAt: Long, replyTo: ReplyRef?,
        ): FileOffer {
            validateFileSize(bytes.size)?.let { throw IllegalArgumentException(it) }
            return FileOffer(messageId, groupId, sanitizeFileName(name), sanitizeMime(mime), bytes.size, sha256B64(bytes), clientCreatedAt, replyTo)
        }

        fun parse(f: JSONObject): FileOffer? {
            if (f.optString("kind") != "file_offer" || (f.opt("v") as? Number)?.toInt() != 1) return null
            val id = f.opt("messageId") as? String
            if (!isValidClientMessageId(id)) return null
            val groupId = if (f.has("groupId")) (f.opt("groupId") as? String)?.takeIf { it.isNotEmpty() && it.length <= 128 } ?: return null else null
            val name = (f.opt("name") as? String)?.takeIf { it.isNotEmpty() && it.length <= 400 } ?: return null
            val mime = (f.opt("mime") as? String)?.takeIf { it.length <= 200 } ?: return null
            val size = (f.opt("size") as? Number)?.takeIf { it.toDouble() == it.toLong().toDouble() && it.toLong() in 1..Int.MAX_VALUE }?.toInt() ?: return null
            val hash = (f.opt("sha256") as? String)?.takeIf { it.length in 40..64 } ?: return null
            val at = (f.opt("clientCreatedAt") as? Number)?.toLong()?.takeIf { it > 0 } ?: return null
            val reply = if (f.has("replyTo")) ReplyRef.fromJson(f.opt("replyTo")) ?: return null else null
            return FileOffer(id!!, groupId, sanitizeFileName(name), sanitizeMime(mime), size, hash, at, reply)
        }
    }
}

data class FileChunk(val messageId: String, val index: Int, val data: String) {
    fun toJson(): JSONObject = JSONObject().put("v", 1).put("kind", "file_chunk").put("messageId", messageId).put("index", index).put("data", data)

    companion object {
        fun parse(f: JSONObject): FileChunk? {
            if (f.optString("kind") != "file_chunk" || (f.opt("v") as? Number)?.toInt() != 1) return null
            val id = f.opt("messageId") as? String
            if (!isValidClientMessageId(id)) return null
            val index = (f.opt("index") as? Number)?.toInt()?.takeIf { it in 0 until MAX_FILE_CHUNKS } ?: return null
            val data = (f.opt("data") as? String)?.takeIf { it.isNotEmpty() && it.length <= (FILE_CHUNK_BYTES * 4) / 3 + 4 } ?: return null
            return FileChunk(id!!, index, data)
        }
    }
}

fun fileChunks(messageId: String, bytes: ByteArray): Sequence<FileChunk> = sequence {
    val total = (bytes.size + FILE_CHUNK_BYTES - 1) / FILE_CHUNK_BYTES
    for (i in 0 until total) {
        val from = i * FILE_CHUNK_BYTES
        val to = minOf(bytes.size, from + FILE_CHUNK_BYTES)
        yield(FileChunk(messageId, i, SignatureCodec.base64UrlEncode(bytes.copyOfRange(from, to))))
    }
}

sealed class AssembleResult {
    object More : AssembleResult()
    class Done(val offer: FileOffer, val bytes: ByteArray) : AssembleResult()
    class Failed(val reason: DeclineReason) : AssembleResult()
}

/**
 * Receiving side, one per peer link. Chunks must arrive in order (the data channel is ordered); anything
 * out of order, oversized or failing the SHA-256 check aborts that transfer.
 */
class FileAssembler {
    private class Incoming(val offer: FileOffer) {
        val out = java.io.ByteArrayOutputStream(offer.size)
        var next = 0
    }

    private val active = HashMap<String, Incoming>()

    val activeCount: Int get() = active.size

    /** Starts a transfer, or says why it must be refused. */
    fun begin(offer: FileOffer): DeclineReason? {
        if (active.containsKey(offer.messageId)) return null
        if (validateFileSize(offer.size) != null) return DeclineReason.TOO_LARGE
        if (active.size >= MAX_INCOMING_PER_PEER) return DeclineReason.BUSY
        active[offer.messageId] = Incoming(offer)
        return null
    }

    fun chunk(frame: FileChunk): AssembleResult {
        val t = active[frame.messageId] ?: return AssembleResult.Failed(DeclineReason.BAD_FILE)
        val data = try {
            SignatureCodec.base64UrlDecode(frame.data)
        } catch (_: Exception) {
            active.remove(frame.messageId)
            return AssembleResult.Failed(DeclineReason.BAD_FILE)
        }
        val size = t.offer.size
        val last = (size + FILE_CHUNK_BYTES - 1) / FILE_CHUNK_BYTES - 1
        val expectedLen = if (frame.index == last) size - last * FILE_CHUNK_BYTES else FILE_CHUNK_BYTES
        if (frame.index != t.next || data.size != expectedLen || t.out.size() + data.size > size) {
            active.remove(frame.messageId)
            return AssembleResult.Failed(DeclineReason.BAD_FILE)
        }
        t.out.write(data)
        t.next += 1
        if (t.out.size() < size) return AssembleResult.More
        active.remove(frame.messageId)
        val bytes = t.out.toByteArray()
        return if (sha256B64(bytes) == t.offer.sha256) AssembleResult.Done(t.offer, bytes) else AssembleResult.Failed(DeclineReason.BAD_FILE)
    }

    fun progress(messageId: String): Double? = active[messageId]?.let { it.out.size().toDouble() / it.offer.size }

    fun clear() = active.clear()
}
