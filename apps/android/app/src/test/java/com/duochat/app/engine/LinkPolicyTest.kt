package com.duochat.app.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkPolicyTest {
    private fun info(uid: String, ready: Boolean = false, connecting: Boolean = false, last: Long = 0, attempts: Int = 0) =
        LinkInfo(uid, ready, connecting, last, attempts)

    @Test
    fun `lower uid initiates`() {
        assertTrue(isInitiator("a", "b"))
        assertFalse(isInitiator("b", "a"))
    }

    @Test
    fun `at most three attempts run at once and the longest waiting go first`() {
        val links = (1..10).map { info("u$it", last = it * 1000L) }
        assertEquals(listOf("u1", "u2", "u3"), LinkScheduler.due(links, now = 1_000_000))
        val busy = links.take(2).map { it.copy(connecting = true, lastAttempt()) } + links.drop(2)
        assertEquals(listOf("u3"), LinkScheduler.due(busy, now = 1_000_000))
    }

    private fun lastAttempt() = 0L
    private fun LinkInfo.copy(connecting: Boolean, @Suppress("UNUSED_PARAMETER") x: Long) = LinkInfo(uid, ready, connecting, lastAttemptAt, attempts)

    @Test
    fun `each contact backs off on its own, 5 seconds doubling to 2 minutes`() {
        val now = 10_000_000L
        val fresh = info("a")
        val failedOnce = info("b", last = now - 4_000, attempts = 0)      // waited 4 s of 5 s
        val failedThrice = info("c", last = now - 30_000, attempts = 3)   // needs 40 s
        val failedMany = info("d", last = now - 119_000, attempts = 20)   // capped at 120 s
        val ready = info("e", ready = true)
        assertEquals(listOf("a"), LinkScheduler.due(listOf(fresh, failedOnce, failedThrice, failedMany, ready), now))
        assertEquals(listOf("c"), LinkScheduler.due(listOf(failedThrice), now + 10_000))
        assertEquals(listOf("d"), LinkScheduler.due(listOf(failedMany), now + 1_000))
    }

    @Test
    fun `soft cap on open links`() {
        val open = (1..30).map { info("o$it", ready = true) }
        assertTrue(LinkScheduler.due(open + info("new"), now = 1_000_000).isEmpty())
        assertFalse(LinkScheduler.acceptIncoming(30))
        assertTrue(LinkScheduler.acceptIncoming(29))
        // 28 open + 1 connecting leaves room for exactly one more.
        val some = (1..28).map { info("o$it", ready = true) } + info("c", connecting = true) + info("x") + info("y")
        assertEquals(listOf("x"), LinkScheduler.due(some, now = 1_000_000))
    }

    @Test
    fun `contacts that cannot be dialled are skipped`() {
        assertTrue(LinkScheduler.due(listOf(LinkInfo("a", false, false, 0, 0, dialable = false)), 1_000_000).isEmpty())
    }

    @Test
    fun `held group messages are released when the group arrives and dropped after 60 seconds`() {
        val buffer = PendingGroupBuffer<String>()
        assertTrue(buffer.hold("g1", "alice", "m1", now = 0))
        assertTrue(buffer.hold("g2", "alice", "m2", now = 10_000))
        assertTrue(buffer.release(now = 20_000) { _, _ -> false }.isEmpty())
        val ready = buffer.release(now = 30_000) { g, _ -> g == "g1" }
        assertEquals(listOf(Triple("g1", "alice", "m1")), ready)
        assertEquals(1, buffer.size)
        assertTrue(buffer.release(now = 80_000) { _, _ -> true }.isEmpty()) // m2 expired at 70 s
        assertEquals(0, buffer.size)
    }

    @Test
    fun `buffer is bounded`() {
        val buffer = PendingGroupBuffer<Int>(capacity = 3)
        repeat(3) { assertTrue(buffer.hold("g", "a", it, 0)) }
        assertFalse(buffer.hold("g", "a", 99, 0))
    }

    @Test
    fun `a relayed blob is passed on once`() {
        val seen = SeenSet(capacity = 2)
        assertTrue(seen.firstTime("s1"))
        assertFalse(seen.firstTime("s1"))
        assertTrue(seen.firstTime("s2"))
        assertTrue(seen.firstTime("s3")) // s1 evicted
        assertTrue(seen.firstTime("s1"))
    }

    @Test
    fun `group delivery detail`() {
        assertEquals(3 to 5, groupDeliveryDetail(5, 2))
        assertEquals(0 to 5, groupDeliveryDetail(5, 9))
        assertEquals(5 to 5, groupDeliveryDetail(5, 0))
    }
}
