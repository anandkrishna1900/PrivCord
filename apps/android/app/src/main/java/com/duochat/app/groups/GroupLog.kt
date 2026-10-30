package com.duochat.app.groups

import com.duochat.app.data.MAX_GROUP_MEMBERS
import com.duochat.app.security.ContactCard
import org.json.JSONObject

/** Port of packages/protocol/src/groups/log.ts. */
data class GroupMemberInfo(
    val uid: String,
    val card: ContactCard,
    val role: String, // "admin" | "member"
    /** Who introduced this member to the group; shown to users as "added by". */
    val addedBy: String,
)

class GroupState(val groupId: String, var name: String, val createdBy: String, val members: LinkedHashMap<String, GroupMemberInfo>)

enum class AddStatus { APPLIED, BUFFERED, DUPLICATE, INVALID }

const val MAX_EVENTS_PER_GROUP = 5000
const val MAX_PENDING_EVENTS = 300

/**
 * The replicated log of one group. Events form a DAG (each lists the heads its author had seen) and the
 * roster is a deterministic fold of it, so every replica holding the same events computes the same roster.
 * Concurrent conflicts: removals are applied first ("remove wins"), then the rest by event id.
 */
class GroupLog(val groupId: String) {
    private val events = LinkedHashMap<String, GroupEvent>()
    private val pending = LinkedHashMap<String, GroupEvent>()
    private val sigCache = HashMap<String, Boolean>()
    private val cardCache = HashMap<String, Boolean>()
    private var current: GroupState? = null
    private var validIds = HashSet<String>()

    val size: Int get() = events.size
    fun state(): GroupState? = current
    fun has(eventId: String) = events.containsKey(eventId)
    fun isEffective(eventId: String) = validIds.contains(eventId)
    fun ids(): List<String> = events.keys.toList()

    /** Events nobody else lists as a dependency: what a new event should depend on. */
    fun heads(): List<String> {
        val referenced = HashSet<String>()
        for (e in events.values) referenced.addAll(e.deps)
        return events.keys.filter { it !in referenced }.sorted()
    }

    fun all(): List<GroupEvent> = order()

    fun missingFor(theirIds: Iterable<String>): List<GroupEvent> {
        val have = theirIds.toHashSet()
        return order().filter { it.eventId !in have }
    }

    fun add(event: GroupEvent): AddStatus {
        if (!GroupEvents.isShape(event.raw)) return AddStatus.INVALID
        if (event.groupId != groupId) return AddStatus.INVALID
        if (events.containsKey(event.eventId) || pending.containsKey(event.eventId)) return AddStatus.DUPLICATE
        if (!GroupEvents.eventIdMatches(event)) return AddStatus.INVALID
        if (events.size >= MAX_EVENTS_PER_GROUP) return AddStatus.INVALID
        if (event.type != "create" && event.deps.isEmpty()) return AddStatus.INVALID
        if (event.deps.any { !events.containsKey(it) }) {
            if (pending.size >= MAX_PENDING_EVENTS) return AddStatus.INVALID
            pending[event.eventId] = event
            return AddStatus.BUFFERED
        }
        events[event.eventId] = event
        drainPending()
        refold()
        return AddStatus.APPLIED
    }

    /** Parses untrusted JSON; invalid shapes are rejected like the TS `add(unknown)`. */
    fun addJson(json: Any?): AddStatus =
        if (json is JSONObject && GroupEvents.isShape(json)) add(GroupEvent(json)) else AddStatus.INVALID

    fun missingDeps(): List<String> {
        val out = LinkedHashSet<String>()
        for (e in pending.values) for (d in e.deps) if (!events.containsKey(d) && !pending.containsKey(d)) out.add(d)
        return out.toList()
    }

    private fun drainPending() {
        var progressed = true
        while (progressed) {
            progressed = false
            for ((id, e) in pending.entries.toList()) {
                if (e.deps.all { events.containsKey(it) }) {
                    pending.remove(id)
                    events[id] = e
                    progressed = true
                }
            }
        }
    }

    private fun order(): List<GroupEvent> {
        val indeg = LinkedHashMap<String, Int>()
        val children = HashMap<String, MutableList<String>>()
        for (e in events.values) {
            indeg[e.eventId] = e.deps.size
            for (d in e.deps) children.getOrPut(d) { mutableListOf() }.add(e.eventId)
        }
        val cmp = compareBy<String>({ if (events[it]!!.type == "remove") 0 else 1 }, { it })
        val ready = indeg.filter { it.value == 0 }.keys.toMutableList()
        val out = ArrayList<GroupEvent>()
        while (ready.isNotEmpty()) {
            ready.sortWith(cmp)
            val id = ready.removeAt(0)
            out.add(events[id]!!)
            for (c in children[id] ?: emptyList<String>()) {
                val n = (indeg[c] ?: 0) - 1
                indeg[c] = n
                if (n == 0) ready.add(c)
            }
        }
        return out
    }

    private fun verifySig(e: GroupEvent, signer: ContactCard): Boolean =
        sigCache.getOrPut("${e.eventId}|${signer.sign.x}.${signer.sign.y}") { GroupEvents.signatureValid(e, signer.sign) }

    private fun cardOk(card: JSONObject?, uid: String): Boolean =
        cardCache.getOrPut("$uid|${card}") { GroupEvents.cardIsValid(card, uid) }

    private fun refold() {
        var state: GroupState? = null
        val valid = HashSet<String>()
        for (e in order()) {
            if (e.type == "create") {
                if (state != null || e.deps.isNotEmpty() || e.groupId != e.eventId) continue
                val card = GroupEvents.cardFromJson(e.cardJson)
                if (card == null || !cardOk(e.cardJson, e.actor) || !verifySig(e, card)) continue
                state = GroupState(
                    e.groupId, e.name!!, e.actor,
                    linkedMapOf(e.actor to GroupMemberInfo(e.actor, card, "admin", e.actor)),
                )
                valid.add(e.eventId)
                continue
            }
            if (state == null) continue
            val author = state.members[e.actor]
            if (author == null || !verifySig(e, author.card)) continue
            when (e.type) {
                "add" -> {
                    val target = e.target!!
                    if (!cardOk(e.cardJson, target)) continue
                    // Hard size limit. The fold order is deterministic, so every replica drops the same overflow adds.
                    if (!state.members.containsKey(target) && state.members.size >= MAX_GROUP_MEMBERS) continue
                    if (!state.members.containsKey(target)) {
                        val card = GroupEvents.cardFromJson(e.cardJson) ?: continue
                        state.members[target] = GroupMemberInfo(target, card, "member", e.actor)
                    }
                    valid.add(e.eventId)
                }
                "remove" -> {
                    val target = e.target!!
                    val selfLeave = e.actor == target
                    if (!selfLeave && author.role != "admin") continue
                    if (!state.members.containsKey(target)) continue
                    state.members.remove(target)
                    valid.add(e.eventId)
                }
                "rename" -> {
                    if (author.role != "admin") continue
                    state.name = e.name!!
                    valid.add(e.eventId)
                }
            }
        }
        current = state
        validIds = valid
    }

    fun toJson(): List<JSONObject> = order().map { it.toJson() }

    companion object {
        fun fromJson(groupId: String, events: List<Any?>): GroupLog =
            GroupLog(groupId).also { log -> events.forEach { log.addJson(it) } }
    }
}
