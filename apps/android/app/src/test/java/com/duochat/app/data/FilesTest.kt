package com.duochat.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

private fun bytesOf(n: Int) = ByteArray(n) { ((it * 31 + 7) and 0xff).toByte() }

private fun assemble(bytes: ByteArray, tamper: ((FileChunk, Int) -> FileChunk)? = null): AssembleResult {
    val offer = FileOffer.create("file-1", null, "a.bin", "application/octet-stream", bytes, 1L, null)
    val rx = FileAssembler()
    assertNull(rx.begin(FileOffer.parse(JSONObject(offer.toJson().toString()))!!))
    var last: AssembleResult = AssembleResult.More
    for ((i, c) in fileChunks("file-1", bytes).withIndex()) {
        val wire = FileChunk.parse(JSONObject((tamper?.invoke(c, i) ?: c).toJson().toString())) ?: return AssembleResult.Failed(DeclineReason.BAD_FILE)
        last = rx.chunk(wire)
        if (last !is AssembleResult.More) break
    }
    return last
}

class FilesTest {
    @Test
    fun `reassembles files of awkward sizes byte for byte`() {
        for (size in listOf(1, FILE_CHUNK_BYTES - 1, FILE_CHUNK_BYTES, FILE_CHUNK_BYTES + 1, 100_000)) {
            val bytes = bytesOf(size)
            val r = assemble(bytes)
            assertTrue("size $size", r is AssembleResult.Done)
            assertTrue((r as AssembleResult.Done).bytes.contentEquals(bytes))
        }
    }

    @Test
    fun `handles exactly 8 MB and refuses one byte more`() {
        assertTrue(assemble(bytesOf(MAX_FILE_BYTES)) is AssembleResult.Done)
        assertNull(validateFileSize(MAX_FILE_BYTES))
        assertEquals("Files can be at most 8.0 MB.", validateFileSize(MAX_FILE_BYTES + 1))
        assertEquals("That file is empty.", validateFileSize(0))
        assertTrue(runCatching { FileOffer.create("m", null, "x", "a/b", bytesOf(MAX_FILE_BYTES + 1), 1L, null) }.isFailure)
        val big = JSONObject().put("v", 1).put("kind", "file_offer").put("messageId", "big").put("name", "x").put("mime", "a/b")
            .put("size", MAX_FILE_BYTES + 1).put("sha256", "a".repeat(43)).put("clientCreatedAt", 1)
        assertEquals(DeclineReason.TOO_LARGE, FileAssembler().begin(FileOffer.parse(big)!!))
    }

    @Test
    fun `rejects corrupted skipped and short chunks`() {
        val bytes = bytesOf(FILE_CHUNK_BYTES * 3 + 10)
        val flipped = assemble(bytes) { c, i -> if (i == 1) c.copy(data = (if (c.data[0] == 'A') "B" else "A") + c.data.drop(1)) else c }
        assertTrue(flipped is AssembleResult.Failed)
        assertTrue(assemble(bytes) { c, i -> if (i == 1) c.copy(index = 2) else c } is AssembleResult.Failed)
        assertTrue(assemble(bytes) { c, i -> if (i == 0) c.copy(data = c.data.take(20)) else c } is AssembleResult.Failed)
    }

    @Test
    fun `a third simultaneous incoming transfer is refused and stray chunks are ignored`() {
        val rx = FileAssembler()
        fun offer(id: String) = FileOffer.parse(
            JSONObject().put("v", 1).put("kind", "file_offer").put("messageId", id).put("name", "x").put("mime", "a/b")
                .put("size", 10).put("sha256", "a".repeat(43)).put("clientCreatedAt", 1),
        )!!
        assertNull(rx.begin(offer("a")))
        assertNull(rx.begin(offer("b")))
        assertEquals(DeclineReason.BUSY, rx.begin(offer("c")))
        assertTrue(rx.chunk(FileChunk("zzz", 0, "AAAA")) is AssembleResult.Failed)
    }

    @Test
    fun `cleans names and types that arrive from a stranger`() {
        assertEquals("_.._etc_passwd", sanitizeFileName("../../etc/passwd"))
        assertFalse(sanitizeFileName("C:\\Windows\\evil.exe").contains(Regex("[\\\\/:]")))
        assertEquals("a_b_c.txt", sanitizeFileName("a\u0000b\nc.txt"))
        assertEquals("file", sanitizeFileName("   "))
        val long = sanitizeFileName("x".repeat(500) + ".png")
        assertTrue(long.length <= 120 && long.endsWith(".png"))
        assertEquals("application/octet-stream", sanitizeMime("text/html; charset=utf-8"))
        assertEquals("image/png", sanitizeMime("IMAGE/PNG"))
        assertTrue(isInlineImage("image/png"))
        assertFalse(isInlineImage("image/svg+xml"))
        assertTrue(isInlineVideo("video/mp4"))
        assertTrue(isInlineVideo("VIDEO/WEBM"))
        assertFalse(isInlineVideo("application/pdf"))
        assertFalse(isInlineVideo("image/png"))
    }

    @Test
    fun `replies round trip and malformed ones are rejected`() {
        val original = createOutgoingMessage("alice", "lunch at 12?")
        val ref = makeReplyRef(original)
        assertEquals(ref, ReplyRef.fromJson(JSONObject(ref.toJson().toString())))
        assertNull(ReplyRef.fromJson(JSONObject().put("id", "x")))
        assertEquals(MAX_REPLY_PREVIEW, makeReplyRef(createOutgoingMessage("a", "x".repeat(1000))).preview.length)
        assertNotNull(parseDeclined(declinedFrame("m", DeclineReason.TOO_LARGE)))
        assertNull(parseDeclined(JSONObject().put("kind", "declined").put("messageId", "m").put("reason", "nope")))
    }

    @Test
    fun `camera orientation tags map to the right rotation`() {
        assertEquals(0 to false, exifTransform(1))
        assertEquals(90 to false, exifTransform(6)) // the common portrait photo
        assertEquals(180 to false, exifTransform(3))
        assertEquals(270 to false, exifTransform(8))
        assertEquals(0 to true, exifTransform(2))
        assertEquals(0 to false, exifTransform(0))
        assertEquals(0 to false, exifTransform(99))
    }

    /** The 7-person case from the product rules: A opted out and paired only with C and F. */
    @Test
    fun `group-only opt-out leaves only manual pairs able to message`() {
        val people = listOf("A", "B", "C", "D", "E", "F", "G")
        val optedOut = setOf("A")
        val paired = setOf(setOf("A", "C"), setOf("A", "F"))
        fun trust(me: String, other: String) = if (setOf(me, other) in paired) ContactTrust.VERIFIED else ContactTrust.INTRODUCED
        fun dm(x: String, y: String) = canStartDirect(trust(x, y), x in optedOut, y in optedOut) && acceptsDirect(trust(y, x), y in optedOut)
        for (o in people.filter { it != "A" }) {
            val expected = o == "C" || o == "F"
            assertEquals("$o->A", expected, dm(o, "A"))
            assertEquals("A->$o", expected, dm("A", o))
        }
        for (x in people.filter { it != "A" }) for (y in people.filter { it != "A" && it != x }) assertTrue("$x->$y", dm(x, y))
        assertTrue(canStartDirect(ContactTrust.VERIFIED, true, true))
        assertFalse(canStartDirect(ContactTrust.INTRODUCED, false, true))
        assertTrue(canStartDirect(ContactTrust.INTRODUCED, false, null))
    }
}

/** Every assertion compares Kotlin against values the TypeScript code produced (docs/file-vectors.json). */
class FileVectorsTest {
    private val v: JSONObject by lazy {
        val f = listOf("../../../docs/file-vectors.json", "../../docs/file-vectors.json", "docs/file-vectors.json").map(::File).first { it.exists() }
        JSONObject(f.readText(Charsets.UTF_8))
    }

    private val source get() = ByteArray(v.getJSONObject("file").getInt("size")) { ((it * 131 + 17) and 0xff).toByte() }

    @Test
    fun `TypeScript offer and chunks reassemble to the same bytes`() {
        val file = v.getJSONObject("file")
        val offer = FileOffer.parse(file.getJSONObject("offer"))!!
        val rx = FileAssembler()
        assertNull(rx.begin(offer))
        var last: AssembleResult = AssembleResult.More
        val chunks = file.getJSONArray("chunks")
        for (i in 0 until chunks.length()) last = rx.chunk(FileChunk.parse(chunks.getJSONObject(i))!!)
        assertTrue(last is AssembleResult.Done)
        assertTrue((last as AssembleResult.Done).bytes.contentEquals(source))
        assertEquals("group-xyz", offer.groupId)
        assertEquals("quoted text", offer.replyTo!!.preview)
    }

    @Test
    fun `Kotlin produces the same offer and chunks as TypeScript`() {
        val file = v.getJSONObject("file")
        val ts = file.getJSONObject("offer")
        val mine = FileOffer.create(
            ts.getString("messageId"), ts.getString("groupId"), "Report ../final?.pdf", "application/pdf", source,
            ts.getLong("clientCreatedAt"), ReplyRef.fromJson(ts.getJSONObject("replyTo")),
        )
        assertEquals(ts.getString("name"), mine.name)
        assertEquals(ts.getString("sha256"), mine.sha256)
        assertEquals(ts.getInt("size"), mine.size)
        val chunks = file.getJSONArray("chunks")
        val kotlin = fileChunks(ts.getString("messageId"), source).toList()
        assertEquals(chunks.length(), kotlin.size)
        for (i in kotlin.indices) assertEquals(chunks.getJSONObject(i).getString("data"), kotlin[i].data)
    }

    @Test
    fun `name and type cleaning matches TypeScript`() {
        val names = v.getJSONArray("sanitizeNames")
        for (i in 0 until names.length()) assertEquals(names.getJSONArray(i).getString(1), sanitizeFileName(names.getJSONArray(i).getString(0)))
        val mimes = v.getJSONArray("sanitizeMimes")
        for (i in 0 until mimes.length()) assertEquals(mimes.getJSONArray(i).getString(1), sanitizeMime(mimes.getJSONArray(i).getString(0)))
    }

    @Test
    fun `the privacy rule gives the same answers as TypeScript for every combination`() {
        val rows = v.getJSONArray("privacy")
        for (i in 0 until rows.length()) {
            val r = rows.getJSONObject(i)
            val trust = ContactTrust.fromWire(r.getString("trust"))
            val peer = if (r.isNull("peer")) null else r.getBoolean("peer")
            assertEquals(r.toString(), r.getBoolean("canStart"), canStartDirect(trust, r.getBoolean("mine"), peer))
            assertEquals(r.toString(), r.getBoolean("accepts"), acceptsDirect(trust, r.getBoolean("mine")))
        }
    }

    @Test
    fun `a TypeScript reply frame is understood and its long quote was cut to 120 characters`() {
        val frame = v.getJSONObject("reply").getJSONObject("frame")
        val reply = ReplyRef.fromJson(frame.getJSONObject("replyTo"))!!
        assertEquals(MAX_REPLY_PREVIEW, reply.preview.length)
        assertEquals(v.getJSONObject("reply").getString("preview"), reply.preview)
    }
}

/** Six-word invite codes against the TypeScript implementation (docs/file-vectors.json). */
class InviteVectorsTest {
    private val v: JSONObject by lazy {
        val f = listOf("../../../docs/file-vectors.json", "../../docs/file-vectors.json", "docs/file-vectors.json").map(::File).first { it.exists() }
        JSONObject(f.readText(Charsets.UTF_8)).getJSONObject("invite")
    }

    private fun words() = v.getJSONArray("words").let { a -> List(a.length()) { a.getString(it) } }

    @Test
    fun `the same words give the same mailbox as TypeScript`() {
        val rv = com.duochat.app.security.InviteCode.derive(words())
        assertEquals(v.getString("mailbox"), rv.mailbox)
    }

    @Test
    fun `Kotlin opens the card a TypeScript phone published`() {
        val rv = com.duochat.app.security.InviteCode.derive(words())
        val j = v.getJSONObject("blob")
        val blob = com.duochat.app.security.Seal.decode(
            com.duochat.app.security.SignatureCodec.base64UrlEncode(j.toString().toByteArray(Charsets.UTF_8)),
        )!!
        val m = com.duochat.app.security.InviteCode.open(rv, blob)!!
        assertEquals(com.duochat.app.security.InviteCode.Kind.CARD, m.kind)
        assertEquals(v.getString("uid"), m.contact.uid)
        assertEquals("Ivy", m.contact.card.name)
        // wrong words and a tampered blob do not open
        assertNull(com.duochat.app.security.InviteCode.open(com.duochat.app.security.InviteCode.derive(listOf("abandon", "ability", "able", "about", "above", "absent")), blob))
    }

    @Test
    fun `words parse from messy typing and bad input is refused`() {
        val w = words()
        assertEquals(w, com.duochat.app.security.InviteCode.parse(w.joinToString(" - ").uppercase()))
        assertNull(com.duochat.app.security.InviteCode.parse(w.take(5).joinToString(" ")))
        assertNull(com.duochat.app.security.InviteCode.parse((w.take(5) + "notaword").joinToString(" ")))
        val fresh = com.duochat.app.security.InviteCode.newWords()
        assertEquals(6, fresh.size)
        assertEquals(fresh, com.duochat.app.security.InviteCode.parse(fresh.joinToString(" ")))
    }
}
