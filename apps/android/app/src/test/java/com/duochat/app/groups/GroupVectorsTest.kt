package com.duochat.app.groups

import com.duochat.app.security.IdentityCodec
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Every assertion compares Kotlin against values the TypeScript group core produced (docs/group-vectors.json). */
class GroupVectorsTest {
    private val v = GroupVectors.all
    private val people = v.getJSONArray("people").objs()
    private val groupId = v.getString("groupId")

    private fun status(s: AddStatus) = s.name.lowercase()
    private fun events(a: org.json.JSONArray) = a.objs().map { GroupEvent(it) }

    @Test
    fun `phrases give the same uids as TypeScript and TS cards verify`() {
        for (p in people) {
            val mine = TestPerson(p.getString("name"), p.getString("phrase"))
            assertEquals(p.getString("uid"), mine.uid)
            assertTrue(GroupEvents.cardIsValid(p.getJSONObject("card"), p.getString("uid")))
            assertFalse(GroupEvents.cardIsValid(p.getJSONObject("card"), "someone-else"))
        }
    }

    @Test
    fun `event ids of TS events are reproduced by Kotlin from their fields`() {
        val all = events(v.getJSONArray("base")) + events(v.getJSONObject("concurrent").getJSONArray("events")) +
            events(v.getJSONObject("linear").getJSONArray("events")) +
            v.getJSONArray("rejects").objs().filter { it.getString("label") != "tampered" }.map { GroupEvent(it.getJSONObject("event")) }
        assertTrue(all.size > 15)
        val signer = TestPerson(people[0].getString("name"), people[0].getString("phrase")).signer
        for (e in all) {
            assertTrue("shape ${e.eventId}", GroupEvents.isShape(e.raw))
            if (e.groupId == groupId || e.type == "create") assertTrue("id ${e.type}", GroupEvents.eventIdMatches(e))
            val again = GroupEvents.sign(
                if (e.type == "create") "" else e.groupId, e.type, e.actor, e.raw.getLong("ts"), e.deps, e.target,
                GroupEvents.cardFromJson(e.cardJson), e.name, signer,
            )
            if (e.groupId == groupId) assertEquals("same id for ${e.type} ${e.raw.getLong("ts")}", e.eventId, again.eventId)
            assertEquals(e.groupId, again.groupId)
        }
    }

    @Test
    fun `replaying TS traces gives the same statuses rosters order and heads`() {
        val cases = listOf(
            "concurrent" to (events(v.getJSONArray("base")) + events(v.getJSONObject("concurrent").getJSONArray("events")) to v.getJSONObject("concurrent").getJSONObject("expected")),
            "linear" to (events(v.getJSONObject("linear").getJSONArray("events")) to v.getJSONObject("linear").getJSONObject("expected")),
            "buffered" to (events(v.getJSONObject("buffered").getJSONArray("base")) + events(v.getJSONObject("buffered").getJSONArray("events")) to v.getJSONObject("buffered").getJSONObject("expected")),
        ) + v.getJSONArray("rejects").objs().map { r ->
            r.getString("label") to (events(v.getJSONArray("base")) + GroupEvent(r.getJSONObject("event")) to r.getJSONObject("expected"))
        }
        for ((label, pair) in cases) {
            val (evs, expected) = pair
            val log = GroupLog(groupId)
            val steps = expected.getJSONArray("steps").objs()
            assertEquals(label, steps.size, evs.size)
            evs.forEachIndexed { i, e ->
                val st = log.add(e)
                val s = steps[i]
                assertEquals("$label step $i status", s.getString("status"), status(st))
                assertEquals("$label step $i effective", s.getBoolean("effective"), log.isEffective(e.eventId))
                assertEquals("$label step $i roster", s.getJSONArray("roster").strings().joinToString(","), rosterOf(log))
            }
            assertEquals(label, expected.getJSONArray("order").strings(), log.all().map { it.eventId })
            assertEquals(label, expected.getJSONArray("heads").strings(), log.heads())
            assertEquals(label, expected.getJSONArray("effective").strings(), log.all().filter { log.isEffective(it.eventId) }.map { it.eventId })
            assertEquals(label, expected.opt("name")?.takeIf { it is String }, log.state()?.name)
        }
    }

    @Test
    fun `concurrent add and remove converges for every arrival order and remove wins`() {
        val expected = v.getJSONObject("concurrent").getJSONObject("expected")
        val all = events(v.getJSONArray("base")) + events(v.getJSONObject("concurrent").getJSONArray("events"))
        val results = HashSet<String>()
        for (seed in 1..12) {
            val log = GroupLog(groupId)
            for (e in shuffle(all, seed)) log.add(e)
            results.add(rosterOf(log) + "#" + log.all().joinToString { it.eventId })
            assertEquals(expected.getJSONArray("order").strings(), log.all().map { it.eventId })
        }
        assertEquals(1, results.size)
        assertEquals(expected.getJSONArray("roster").strings().joinToString(","), rosterOf(GroupLog(groupId).also { l -> all.forEach { l.add(it) } }))
        assertEquals(v.getString("groupName"), GroupLog(groupId).also { l -> all.forEach { l.add(it) } }.state()!!.name)
    }

    @Test
    fun `a tampered TS event is rejected`() {
        val log = GroupLog(groupId)
        events(v.getJSONArray("base")).forEach { log.add(it) }
        val e = v.getJSONArray("rejects").objs().first { it.getString("label") == "tampered" }.getJSONObject("event")
        assertEquals(AddStatus.INVALID, log.add(GroupEvent(e)))
        // Flipping a signature byte of a good event: accepted into the DAG but never effective.
        val good = GroupEvent(v.getJSONObject("linear").getJSONArray("events").getJSONObject(2))
        val bad = JSONObject(good.raw.toString()).put("sig", good.sig.reversed())
        val log2 = GroupLog(groupId)
        events(v.getJSONObject("linear").getJSONArray("events")).take(2).forEach { log2.add(it) }
        assertEquals(AddStatus.APPLIED, log2.add(GroupEvent(bad)))
        assertFalse(log2.isEffective(good.eventId))
    }

    @Test
    fun `frames parse like TypeScript and round trip`() {
        for (f in v.getJSONArray("frames").objs()) {
            val parsed = parseGroupFrame(f.getJSONObject("frame"))
            assertEquals(f.getJSONObject("frame").toString(), f.getBoolean("valid"), parsed != null)
            if (parsed != null) assertNotNull(parseGroupFrame(JSONObject(parsed.toJson().toString())))
        }
        assertNull(parseGroupFrame(null))
        assertNull(parseGroupFrame("x"))
    }

    @Test
    fun `Kotlin signed events verify in Kotlin and are exported for the TypeScript interop test`() {
        val a = TestPerson(people[0].getString("name"), people[0].getString("phrase"))
        val b = TestPerson(people[1].getString("name"), people[1].getString("phrase"))
        val c = TestPerson(people[2].getString("name"), people[2].getString("phrase"))
        val e = TestPerson(people[4].getString("name"), people[4].getString("phrase"))
        var clock = 1_800_000_000_000L
        val coordA = GroupCoordinator(a.uid, a.card, a.signer, { emptySet() }, now = { clock++ })
        val coordB = GroupCoordinator(b.uid, b.card, b.signer, { setOf(a.uid) }, now = { clock++ })
        val created = coordA.createGroup("Kotlin ☕ group", listOf(b.card))
        val gid = created.groupId
        // Deliver to B, B adds C and E (E has a card without a name), A renames, A removes C.
        for (f in created.result.outgoing) coordB.handle(a.uid, parseGroupFrame(JSONObject(f.frame.toJson().toString()))!!)
        val rB = coordB.addMember(gid, c.card)
        coordB.addMember(gid, e.card)
        for (f in rB.outgoing.filter { it.to == a.uid }) coordA.handle(b.uid, f.frame)
        // A learns E through the full-history sync.
        for (f in coordB.onLinkOpen(a.uid)) coordA.handle(b.uid, f.frame)
        for (f in coordA.onLinkOpen(b.uid)) coordB.handle(a.uid, f.frame)
        for (f in coordA.rename(gid, "Renamed by Kotlin").outgoing.filter { it.to == b.uid }) coordB.handle(a.uid, f.frame)
        val log = GroupLog.fromJson(gid, coordB.export()[gid]!!)
        assertTrue(log.state()!!.members.containsKey(c.uid))
        // The log B exports is signed by Kotlin; re-verify it from JSON alone.
        val copy = GroupLog.fromJson(gid, coordB.export()[gid]!!)
        assertEquals(rosterOf(log), rosterOf(copy))
        assertTrue(copy.all().all { copy.isEffective(it.eventId) })
        assertEquals(5, copy.all().size) // create, add B, add C, add E, rename
        assertEquals("Renamed by Kotlin", copy.state()!!.name)
        val out = JSONObject()
            .put("groupId", gid)
            .put("events", org.json.JSONArray(copy.toJson()))
            .put("roster", org.json.JSONArray(copy.state()!!.members.keys.sorted()))
            .put("people", org.json.JSONArray(listOf(a, b, c, e).map { JSONObject().put("uid", it.uid) }))
        File("build/interop").also { it.mkdirs() }
        File("build/interop/kotlin-group-events.json").writeText(out.toString(2))
        assertEquals(IdentityCodec.uidFor(c.card.dh), c.uid)
    }

    private fun <T> shuffle(items: List<T>, seed: Int): List<T> {
        val a = items.toMutableList()
        var s = seed.toLong()
        for (i in a.size - 1 downTo 1) {
            s = (s * 1103515245L + 12345L) and 0x7fffffffL
            val j = (s % (i + 1)).toInt()
            val t = a[i]; a[i] = a[j]; a[j] = t
        }
        return a
    }
}
