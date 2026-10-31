package com.duochat.app.ble

import com.duochat.app.groups.TestPerson
import com.duochat.app.security.Channels
import com.duochat.app.security.SealedBlob
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

private class Sim {
    val nodes = HashMap<String, MeshNode>()
    val got = HashMap<String, MutableList<SealedBlob>>()
    var sent = 0
    var now = 1_000_000L
    val edges = HashSet<String>()

    fun add(vararg ids: String) = ids.forEach { nodes[it] = MeshNode(); got[it] = mutableListOf() }
    private fun key(a: String, b: String) = if (a < b) "$a|$b" else "$b|$a"
    fun connect(a: String, b: String) {
        edges.add(key(a, b))
        deliver(a, nodes[a]!!.linkUp(b, now))
        deliver(b, nodes[b]!!.linkUp(a, now))
    }
    fun disconnect(a: String, b: String) {
        edges.remove(key(a, b))
        nodes[a]!!.linkDown(b)
        nodes[b]!!.linkDown(a)
    }

    fun deliver(from: String, outs: List<MeshOutgoing>) {
        val queue = ArrayDeque(outs.map { from to it })
        while (queue.isNotEmpty()) {
            val (src, o) = queue.removeFirst()
            if (key(src, o.link) !in edges) continue
            sent++
            val r = nodes[o.link]!!.handle(JSONObject(o.packet.toJson().toString()), src, now)
            r.accepted?.let { got[o.link]!!.add(it) }
            r.forward.forEach { queue.addLast(o.link to it) }
        }
    }

    fun send(origin: String, blob: SealedBlob) = deliver(origin, nodes[origin]!!.inject(blob, now))
}

private fun message(text: String, who: Int = 70): SealedBlob {
    val p = TestPerson.numbered(who, "Ann")
    return Channels.seal(Channels.derive("general"), text, 1L, p.card, p.uid, p.signer)
}

class MeshTest {
    @Test
    fun `crosses several phones and is never echoed back to its author`() {
        val sim = Sim()
        sim.add("A", "B", "C", "D", "E")
        listOf("A" to "B", "B" to "C", "C" to "D", "D" to "E").forEach { (x, y) -> sim.connect(x, y) }
        sim.send("A", message("from A"))
        for (id in listOf("B", "C", "D", "E")) assertEquals(id, 1, sim.got[id]!!.size)
        assertEquals(0, sim.got["A"]!!.size)
    }

    @Test
    fun `stops after the hop limit`() {
        val sim = Sim()
        val ids = List(12) { "N$it" }
        sim.add(*ids.toTypedArray())
        for (i in 0 until 11) sim.connect(ids[i], ids[i + 1])
        sim.send("N0", message("long way"))
        assertEquals(MESH_MAX_TTL, ids.count { sim.got[it]!!.isNotEmpty() })
        assertEquals(0, sim.got["N8"]!!.size)
    }

    @Test
    fun `delivers once per phone even with loops`() {
        val sim = Sim()
        val ids = listOf("A", "B", "C", "D", "E", "F")
        sim.add(*ids.toTypedArray())
        for (i in 0 until 6) sim.connect(ids[i], ids[(i + 1) % 6])
        sim.connect("A", "D"); sim.connect("B", "E"); sim.connect("C", "F")
        sim.send("A", message("loops"))
        ids.drop(1).forEach { assertEquals(it, 1, sim.got[it]!!.size) }
        assertTrue(sim.sent <= sim.edges.size * 2)
    }

    @Test
    fun `carries a message for a phone that shows up later, once only, and forgets it after the carry time`() {
        val sim = Sim()
        sim.add("A", "B", "C", "D")
        sim.connect("A", "B")
        sim.send("A", message("wait for me"))
        sim.now += 10 * 60_000
        sim.disconnect("A", "B")
        sim.connect("B", "C")
        assertEquals(1, sim.got["C"]!!.size)
        sim.disconnect("B", "C"); sim.connect("B", "C")
        assertEquals(1, sim.got["C"]!!.size)
        sim.now += 31 * 60_000
        sim.connect("B", "D")
        assertEquals(0, sim.got["D"]!!.size)
    }

    @Test
    fun `refuses a flooding sender, garbage and a ttl above the limit`() {
        val node = MeshNode(perSenderPerMinute = 5)
        node.linkUp("x", 0)
        var accepted = 0
        val p = TestPerson.numbered(71, "Spammer")
        val ch = Channels.derive("general")
        for (i in 0 until 12) {
            val blob = Channels.seal(ch, "spam $i", (i + 1).toLong(), p.card, p.uid, p.signer)
            if (node.handle(MeshPacket.make(blob).toJson(), "x", 1000L + i).accepted != null) accepted++
        }
        assertEquals(5, accepted)
        val good = MeshPacket.make(message("x")).toJson()
        assertNotNull(MeshPacket.parse(good))
        assertNull(MeshPacket.parse(JSONObject(good.toString()).put("id", "other")))
        assertNull(MeshPacket.parse(JSONObject(good.toString()).put("ttl", 0)))
        assertEquals(MESH_MAX_TTL, MeshPacket.parse(JSONObject(good.toString()).put("ttl", 9999))!!.ttl)
        assertNull(MeshPacket.parse(null))
        assertNull(node.handle(null, "x", 1).accepted)
    }
}

/** Channel messages against the TypeScript implementation (docs/file-vectors.json). */
class ChannelVectorsTest {
    private val v: JSONObject by lazy {
        val f = listOf("../../../docs/file-vectors.json", "../../docs/file-vectors.json", "docs/file-vectors.json").map(::File).first { it.exists() }
        JSONObject(f.readText(Charsets.UTF_8)).getJSONObject("channel")
    }

    @Test
    fun `the same name gives the same mailbox and tag as TypeScript`() {
        val keys = Channels.derive(v.getString("name"))
        assertEquals(v.getString("mailbox"), keys.mailbox)
        assertEquals(v.getString("tag"), keys.tag)
    }

    @Test
    fun `Kotlin opens a channel message made by TypeScript, and its mesh packet parses`() {
        val keys = Channels.derive("general")
        val blob = SealedBlob.fromJson(v.getJSONObject("blob"))!!
        val m = Channels.open(keys, blob)!!
        assertEquals(v.getString("text"), m.text)
        assertEquals(v.getLong("at"), m.at)
        assertEquals(v.getString("uid"), m.contact.uid)
        assertNull(Channels.open(Channels.derive("other-room"), blob))
        val packet = MeshPacket.parse(v.getJSONObject("packet"))!!
        assertEquals(MeshPacket.idOf(blob), packet.id)
    }

    @Test
    fun `name normalization matches TypeScript`() {
        val names = v.getJSONArray("names")
        for (i in 0 until names.length()) {
            val pair = names.getJSONArray(i)
            val expected = if (pair.isNull(1)) null else pair.getString(1)
            assertEquals(pair.getString(0), expected, Channels.normalize(pair.getString(0)))
        }
    }

    @Test
    fun `Kotlin messages open in Kotlin, cannot be forged and cannot be read in another room`() {
        val ann = TestPerson.numbered(72, "Ann")
        val mallory = TestPerson.numbered(73, "Mallory")
        val keys = Channels.derive("general")
        val blob = Channels.seal(keys, "hi all", 5L, ann.card, ann.uid, ann.signer)
        assertEquals("hi all", Channels.open(keys, blob)!!.text)
        assertNull(Channels.open(Channels.derive("secret-club"), blob))
        val forged = Channels.seal(keys, "I am Ann", 5L, ann.card, ann.uid, mallory.signer)
        assertNull(Channels.open(keys, forged))
        assertFalse(Channels.normalize("###") != null)
    }
}
