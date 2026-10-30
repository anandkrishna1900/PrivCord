package com.duochat.app.engine

import com.duochat.app.data.MAX_CONNECTING
import com.duochat.app.data.MAX_LINKS
import com.duochat.app.signaling.reconnectDelayMs

/** What the scheduler needs to know about one contact's link. Pure data, so the policy is unit-tested. */
data class LinkInfo(
    val uid: String,
    val ready: Boolean,
    val connecting: Boolean,
    /** Last time we tried to reach them (0 = never), and how many tries in a row failed. */
    val lastAttemptAt: Long,
    val attempts: Int,
    /** Both of us know each other's keys (always true for saved contacts). */
    val dialable: Boolean = true,
)

/** Initiator rule per pair: the lower uid sends the offer, the other side just announces it is online. */
fun isInitiator(selfUid: String, peerUid: String): Boolean = selfUid < peerUid

object LinkScheduler {
    /**
     * Which contacts to reach out to now. At most [MAX_CONNECTING] attempts run at once, never more than
     * [MAX_LINKS] links are open, each contact backs off on its own (5 s doubling to 120 s) and the
     * longest-waiting contact goes first so nobody starves in a big group.
     */
    fun due(links: List<LinkInfo>, now: Long, maxConnecting: Int = MAX_CONNECTING, maxLinks: Int = MAX_LINKS): List<String> {
        val open = links.count { it.ready }
        var connecting = links.count { it.connecting }
        var room = maxLinks - open - connecting
        val out = ArrayList<String>()
        val candidates = links.filter { it.dialable && !it.ready && !it.connecting && now - it.lastAttemptAt >= reconnectDelayMs(it.attempts) }
            .sortedBy { it.lastAttemptAt }
        for (c in candidates) {
            if (connecting >= maxConnecting || room <= 0) break
            out.add(c.uid)
            connecting += 1
            room -= 1
        }
        return out
    }

    /** Accept an offer a contact sent us? Not beyond the soft link cap. */
    fun acceptIncoming(openLinks: Int, maxLinks: Int = MAX_LINKS): Boolean = openLinks < maxLinks
}

/** Group messages that arrived before we knew the group or the sender: held briefly, then dropped. */
class PendingGroupBuffer<T>(private val holdMs: Long = HOLD_MS, private val capacity: Int = 200) {
    private class Entry<T>(val groupId: String, val from: String, val item: T, val at: Long)

    private val entries = ArrayList<Entry<T>>()

    val size: Int get() = entries.size

    /** False if the buffer is full (the message is dropped; the sender retries because no ack is sent). */
    fun hold(groupId: String, from: String, item: T, now: Long): Boolean {
        if (entries.size >= capacity) return false
        entries.add(Entry(groupId, from, item, now))
        return true
    }

    /** Remove and return what [ready] now accepts; expired entries are discarded. */
    fun release(now: Long, ready: (groupId: String, from: String) -> Boolean): List<Triple<String, String, T>> {
        entries.removeAll { now - it.at > holdMs }
        val out = ArrayList<Triple<String, String, T>>()
        val iterator = entries.iterator()
        while (iterator.hasNext()) {
            val e = iterator.next()
            if (ready(e.groupId, e.from)) {
                out.add(Triple(e.groupId, e.from, e.item))
                iterator.remove()
            }
        }
        return out
    }

    fun expire(now: Long): Int {
        val before = entries.size
        entries.removeAll { now - it.at > holdMs }
        return before - entries.size
    }

    companion object {
        const val HOLD_MS = 60_000L
    }
}

/** Remembers recent sealed-blob signatures so a relayed blob is passed on at most once. */
class SeenSet(private val capacity: Int = 2000) {
    private val seen = LinkedHashSet<String>()

    /** True the first time [id] is offered. */
    fun firstTime(id: String): Boolean {
        if (!seen.add(id)) return false
        if (seen.size > capacity) seen.remove(seen.first())
        return true
    }
}

/** "Delivered to 3 of 5": group state from how many recipients are still pending. */
fun groupDeliveryDetail(total: Int, pending: Int): Pair<Int, Int> = (total - pending).coerceIn(0, total) to total
