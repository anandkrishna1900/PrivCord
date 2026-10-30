package com.duochat.app.groups

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test

/** Kotlin ports of the TypeScript simulations in packages/protocol/test/groups.test.ts. */
class GroupSimulationTest {
    private fun chain(n: Int, prefix: String): Pair<SimNet, List<SimNode>> {
        val people = List(n) { TestPerson.numbered(it, "$prefix$it") }
        val net = SimNet()
        val nodes = people.map { net.add(SimNode(it)) }
        // Real-world meetings: a chain, so nobody except neighbours has ever exchanged a card with anyone else.
        for (i in 1 until n) {
            nodes[i].pin(people[i - 1])
            nodes[i - 1].pin(people[i])
        }
        net.reconcile()
        return net to nodes
    }

    @Test
    fun `A adds B, B adds C - A and C link automatically with no code sharing`() {
        val (a, b, c) = List(3) { TestPerson.numbered(it, "ABC"[it].toString()) }
        val net = SimNet()
        val nA = net.add(SimNode(a)); val nB = net.add(SimNode(b)); val nC = net.add(SimNode(c))
        nA.pin(b); nB.pin(a); nB.pin(c); nC.pin(b)
        net.reconcile()
        assertTrue(net.isLinked(a.uid, b.uid))
        assertFalse(net.isLinked(a.uid, c.uid))

        val created = nA.coord.createGroup("Trip", listOf(b.card))
        net.run(nA, created.result)
        assertTrue(nB.joined.contains(created.groupId))
        assertEquals(0, nC.coord.myGroups().size)

        net.run(nB, nB.coord.addMember(created.groupId, c.card))
        assertTrue(nC.joined.contains(created.groupId))
        assertTrue(nA.known.contains(c.uid))
        assertEquals(b.uid, nA.introducedBy[c.uid])
        assertTrue(nC.known.contains(a.uid))
        // C was brought in by B; A was added by... A is the creator, so A's own addedBy is A.
        assertEquals(a.uid, nC.introducedBy[a.uid])
        assertTrue(net.isLinked(a.uid, c.uid))
        val want = listOf(a.uid, b.uid, c.uid).sorted().joinToString(",")
        for (n in listOf(nA, nB, nC)) assertEquals(want, rosterOf(GroupLog.fromJson(created.groupId, n.coord.export()[created.groupId]!!)))
    }

    @Test
    fun `a member added while another is offline catches up on reconnect`() {
        val (a, b, c) = List(3) { TestPerson.numbered(it + 40) }
        val net = SimNet()
        val nA = net.add(SimNode(a)); val nB = net.add(SimNode(b)); val nC = net.add(SimNode(c))
        nA.pin(b); nB.pin(a); nB.pin(c); nC.pin(b)
        net.reconcile()
        val created = nA.coord.createGroup("Trip", listOf(b.card))
        net.run(nA, created.result)
        net.setOnline(nA, false)
        net.run(nB, nB.coord.addMember(created.groupId, c.card))
        assertFalse(nA.known.contains(c.uid))
        net.setOnline(nA, true)
        net.reconcile()
        assertTrue(nA.known.contains(c.uid))
        assertTrue(net.isLinked(a.uid, c.uid))
    }

    @Test
    fun `spam from a contact who never made us a member is dropped and non-members cannot pull history`() {
        val (a, b, x) = List(3) { TestPerson.numbered(it + 60) }
        val net = SimNet()
        val nA = net.add(SimNode(a)); val nB = net.add(SimNode(b)); val nX = net.add(SimNode(x))
        nA.pin(b); nB.pin(a); nA.pin(x); nX.pin(a)
        net.reconcile()
        val g = nB.coord.createGroup("Spam", emptyList())
        net.dispatch(nB, listOf(OutgoingFrame(a.uid, GroupFrame.Events(nB.coord.export()[g.groupId]!!.map { GroupEvent(it) }))))
        assertEquals(0, nA.coord.groupIds().size)

        val gA = nA.coord.createGroup("Private", listOf(b.card))
        net.run(nA, gA.result)
        val reply = nA.coord.handle(x.uid, GroupFrame.Have(listOf(gA.groupId to emptyList())))
        assertEquals(0, reply.outgoing.size)
    }

    @Test
    fun `removing a member stops traffic to them and they learn they are out`() {
        val (a, b, c) = List(3) { TestPerson.numbered(it + 80) }
        val net = SimNet()
        val nA = net.add(SimNode(a)); val nB = net.add(SimNode(b)); val nC = net.add(SimNode(c))
        nA.pin(b); nB.pin(a); nA.pin(c); nC.pin(a)
        net.reconcile()
        val created = nA.coord.createGroup("G", listOf(b.card, c.card))
        net.run(nA, created.result)
        assertEquals(listOf(b.uid, c.uid).sorted(), nA.coord.recipients(created.groupId).sorted())
        net.run(nA, nA.coord.removeMember(created.groupId, c.uid))
        assertTrue(nC.left.contains(created.groupId))
        assertEquals(listOf(b.uid), nA.coord.recipients(created.groupId))
        assertEquals(MessageVerdict.NOT_MEMBER, nC.coord.checkMessage(a.uid, created.groupId))
        assertEquals(MessageVerdict.NOT_MEMBER, nB.coord.checkMessage(c.uid, created.groupId))
        assertEquals(MessageVerdict.OK, nB.coord.checkMessage(a.uid, created.groupId))
        assertEquals(MessageVerdict.UNKNOWN_GROUP, nB.coord.checkMessage(a.uid, "nope"))
    }

    @Test
    fun `25 members each added by their neighbour all converge and connect to each other`() {
        val n = 25
        val (net, nodes) = chain(n, "P")
        val first = nodes[0].coord.createGroup("Everyone", listOf(nodes[1].p.card))
        net.run(nodes[0], first.result)
        val groupId = first.groupId
        for (i in 2 until n) net.run(nodes[i - 1], nodes[i - 1].coord.addMember(groupId, nodes[i].p.card))

        val expected = nodes.map { it.p.uid }.sorted().joinToString(",")
        for (node in nodes) {
            assertEquals(expected, rosterOf(GroupLog.fromJson(groupId, node.coord.export()[groupId]!!)))
            assertEquals(n - 1, node.known.size)
            assertEquals(n - 1, node.coord.recipients(groupId).size)
        }
        var links = 0
        for (a in nodes) for (b in nodes) if (a !== b && net.isLinked(a.p.uid, b.p.uid)) links += 1
        assertEquals(n * (n - 1), links) // full mesh, no manual step
    }

    @Test
    fun `growth survives members dropping offline and converges after they return`() {
        val n = 12
        val (net, nodes) = chain(n, "Q")
        val first = nodes[0].coord.createGroup("Flaky", listOf(nodes[1].p.card))
        net.run(nodes[0], first.result)
        val groupId = first.groupId
        for (i in 2 until n) {
            val off = nodes.filterIndexed { k, _ -> k % 3 == 0 && k != i - 1 && k != i }
            off.forEach { net.setOnline(it, false) }
            net.run(nodes[i - 1], nodes[i - 1].coord.addMember(groupId, nodes[i].p.card))
            off.forEach { net.setOnline(it, true) }
            net.reconcile()
        }
        net.reconcile()
        val expected = nodes.map { it.p.uid }.sorted().joinToString(",")
        for (node in nodes) assertEquals(expected, rosterOf(GroupLog.fromJson(groupId, node.coord.export()[groupId]!!)))
    }

    @Test
    fun `only admin removes others, anyone may leave, and a double add is refused`() {
        val (a, b) = List(2) { TestPerson.numbered(it + 100) }
        val coordA = GroupCoordinator(a.uid, a.card, a.signer, { emptySet() })
        val g = coordA.createGroup("G", listOf(b.card))
        try { coordA.addMember(g.groupId, b.card); org.junit.Assert.fail() } catch (_: GroupException) {}
        val coordB = GroupCoordinator(b.uid, b.card, b.signer, { setOf(a.uid) })
        for (f in g.result.outgoing) coordB.handle(a.uid, f.frame)
        try { coordB.removeMember(g.groupId, a.uid); org.junit.Assert.fail() } catch (_: GroupException) {}
        val left = coordB.leave(g.groupId)
        assertEquals(listOf(g.groupId), left.left)
        assertNull(coordB.myGroups().firstOrNull())
    }
}
