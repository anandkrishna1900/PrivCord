package com.duochat.app.ble

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class BleFramingTest {
    private val vectors: JSONObject = run {
        // Gradle runs unit tests with the module dir (apps/android/app) as the working dir.
        val file = listOf("../../../docs/ble-vectors.json", "../../docs/ble-vectors.json", "docs/ble-vectors.json")
            .map(::File).first { it.exists() }
        JSONObject(file.readText(Charsets.UTF_8))
    }

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    private fun unhex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun JSONArray.strings() = (0 until length()).map { getString(it) }

    @Test
    fun chunkingMatchesSharedVectors() {
        val cases = vectors.getJSONArray("chunking")
        assertTrue(cases.length() > 0)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val max = c.getInt("maxChunk")
            val chunks = BleFraming.chunk(c.getString("text").toByteArray(Charsets.UTF_8), max)
            assertEquals(name, c.getJSONArray("chunksHex").strings(), chunks.map(::hex))
            assertTrue(name, chunks.all { it.size <= max })
            val r = BleReassembler()
            val out = chunks.mapNotNull { r.push(it) }
            assertEquals(name, 1, out.size)
            assertEquals(name, c.getString("text"), out[0].toString(Charsets.UTF_8))
        }
    }

    @Test
    fun reassemblyMatchesSharedVectors() {
        val cases = vectors.getJSONArray("reassembly")
        assertTrue(cases.length() > 0)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val chunks = c.getJSONArray("chunksHex").strings()
            val results = c.getJSONArray("results")
            val r = BleReassembler()
            chunks.forEachIndexed { idx, h ->
                val expected = if (results.isNull(idx)) null else results.getJSONObject(idx)
                when {
                    expected?.has("err") == true -> try {
                        r.push(unhex(h))
                        fail("$name: expected an error at chunk $idx")
                    } catch (_: BleFramingException) {
                    }
                    expected?.has("msg") == true ->
                        assertEquals(name, expected.getString("msg"), r.push(unhex(h))!!.toString(Charsets.UTF_8))
                    else -> assertNull(name, r.push(unhex(h)))
                }
            }
        }
    }

    @Test
    fun roundTripsSixtyFourKiB() {
        val big = vectors.getJSONObject("large")
        val payload = ByteArray(big.getInt("length")) { big.getInt("byte").toByte() }
        val chunks = BleFraming.chunk(payload, big.getInt("maxChunk"))
        assertEquals(big.getInt("chunkCount"), chunks.size)
        val r = BleReassembler()
        var out: ByteArray? = null
        for (c in chunks) out = r.push(c)
        assertArrayEquals(payload, out)
    }

    @Test
    fun usesEverySequenceNumberAtMinimumChunkSize() {
        val chunks = BleFraming.chunk(ByteArray(BleFraming.MAX_MESSAGE_BYTES), 4)
        assertEquals(65_536, chunks.size)
        assertEquals("02ffff", hex(chunks.last().copyOf(3)))
    }

    @Test
    fun rejectsBadInput() {
        val over = vectors.getJSONObject("oversize")
        for (bad in listOf<() -> Unit>(
            { BleFraming.chunk(ByteArray(over.getInt("length")), over.getInt("maxChunk")) },
            { BleFraming.chunk(ByteArray(0), 20) },
            { BleFraming.chunk(ByteArray(1), 3) },
        )) {
            try {
                bad()
                fail("expected BleFramingException")
            } catch (_: BleFramingException) {
            }
        }
    }

    @Test
    fun rejectsStreamPastSixtyFourKiB() {
        val r = BleReassembler()
        fun mk(flags: Int, seq: Int) = byteArrayOf(flags.toByte(), (seq shr 8).toByte(), seq.toByte()) + ByteArray(1000) { 1 }
        r.push(mk(0x01, 0))
        for (i in 1 until 65) r.push(mk(0x00, i))
        try {
            r.push(mk(0x00, 65))
            fail("expected BleFramingException")
        } catch (_: BleFramingException) {
        }
    }

    @Test
    fun chunkJsonIsPlainUtf8() {
        val chunks = BleFraming.chunkJson("{\"v\":1}", 512)
        assertEquals(1, chunks.size)
        assertEquals("{\"v\":1}", chunks[0].copyOfRange(3, chunks[0].size).toString(Charsets.UTF_8))
    }

    @Test
    fun tagsMatchSharedVectors() {
        val t = vectors.getJSONObject("tag")
        val secret = unhex(t.getString("secretHex"))
        val list = t.getJSONArray("vectors")
        for (i in 0 until list.length()) {
            val v = list.getJSONObject(i)
            assertEquals(v.getString("tagHex"), hex(BleTag.tag(secret, v.getLong("epoch"))))
        }
        assertEquals(0L, BleTag.epoch(899_999))
        assertEquals(1L, BleTag.epoch(900_000))
        assertEquals(3, BleTag.acceptTags(secret, 900_000).size)
        assertTrue(hex(BleTag.tag(ByteArray(32), 1)) != list.getJSONObject(1).getString("tagHex"))
    }
}
