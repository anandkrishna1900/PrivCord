package com.duochat.app.groups

import com.duochat.app.data.MAX_GROUP_MEMBERS
import com.duochat.app.data.MAX_TEXT_LENGTH
import com.duochat.app.data.ReplyRef
import com.duochat.app.data.countCodePoints
import com.duochat.app.data.isValidClientMessageId
import com.duochat.app.security.ContactCard
import com.duochat.app.security.IdentityCodec
import com.duochat.app.security.Seal
import org.json.JSONArray
import org.json.JSONObject

/* ---------------- wire frames (all travel over an already-authenticated pairwise channel) ---------------- */

const val MAX_EVENTS_PER_FRAME = 40
const val MAX_RELAY_HOPS = 2

sealed class GroupFrame {
    abstract fun toJson(): JSONObject

    class Push(val event: GroupEvent) : GroupFrame() {
        override fun toJson() = JSONObject().put("v", 1).put("kind", "group_push").put("event", event.toJson())
    }

    class Events(val events: List<GroupEvent>) : GroupFrame() {
        override fun toJson() = JSONObject().put("v", 1).put("kind", "group_events")
            .put("events", JSONArray().also { a -> events.forEach { a.put(it.toJson()) } })
    }

    /** [full]: sent when a link opens; `groups` is everything the sender has, so groups missing from it are unknown to them. */
    class Have(val groups: List<Pair<String, List<String>>>, val full: Boolean = false) : GroupFrame() {
        override fun toJson() = JSONObject().put("v", 1).put("kind", "group_have").put(
            "groups",
            JSONArray().also { a ->
                groups.forEach { (id, ids) -> a.put(JSONObject().put("groupId", id).put("ids", JSONArray(ids))) }
            },
        ).also { if (full) it.put("full", true) }
    }

    class Message(
        val groupId: String, val messageId: String, val text: String, val clientCreatedAt: Long,
        val replyTo: ReplyRef? = null,
    ) : GroupFrame() {
        override fun toJson() = JSONObject().put("v", 1).put("kind", "gmsg").put("groupId", groupId)
            .put("messageId", messageId).put("text", text).put("clientCreatedAt", clientCreatedAt)
            .also { if (replyTo != null) it.put("replyTo", replyTo.toJson()) }
    }

    /** Ask a mutual contact to pass a sealed blob on to someone we cannot reach directly. */
    class RelayBlob(val blob: JSONObject, val hops: Int) : GroupFrame() {
        override fun toJson() = JSONObject().put("v", 1).put("kind", "relay_blob").put("blob", blob).put("hops", hops)
    }
}

/** Null for anything that is not a well-formed group frame (port of `parseGroupFrame`). */
fun parseGroupFrame(value: Any?): GroupFrame? {
    val f = value as? JSONObject ?: return null
    if ((f.opt("v") as? Number)?.toDouble() != 1.0) return null
    return try {
        when (f.opt("kind")) {
            "group_push" -> f.opt("event").takeIf { GroupEvents.isShape(it) }?.let { GroupFrame.Push(GroupEvent(it as JSONObject)) }
            "group_events" -> {
                val a = f.opt("events") as? JSONArray ?: return null
                if (a.length() > MAX_EVENTS_PER_FRAME || (0 until a.length()).any { !GroupEvents.isShape(a.opt(it)) }) null
                else GroupFrame.Events(List(a.length()) { GroupEvent(a.getJSONObject(it)) })
            }
            "group_have" -> {
                val a = f.opt("groups") as? JSONArray ?: return null
                if (a.length() > 200) return null
                val groups = ArrayList<Pair<String, List<String>>>()
                for (i in 0 until a.length()) {
                    val g = a.opt(i) as? JSONObject ?: return null
                    val gid = g.opt("groupId") as? String ?: return null
                    val ids = g.opt("ids") as? JSONArray ?: return null
                    if (ids.length() > 6000) return null
                    groups.add(gid to List(ids.length()) { k -> ids.opt(k) as? String ?: return null })
                }
                GroupFrame.Have(groups, f.opt("full") == true)
            }
            "gmsg" -> {
                val gid = f.opt("groupId") as? String ?: return null
                val mid = f.opt("messageId") as? String
                val text = f.opt("text") as? String ?: return null
                val at = (f.opt("clientCreatedAt") as? Number)?.toDouble() ?: return null
                if (!isValidClientMessageId(mid) || text.trim().isEmpty() || countCodePoints(text) > MAX_TEXT_LENGTH) null
                else if (at.isNaN() || at.isInfinite() || at <= 0) null
                else {
                    val reply = if (f.has("replyTo")) ReplyRef.fromJson(f.opt("replyTo")) ?: return null else null
                    GroupFrame.Message(gid, mid!!, text, at.toLong(), reply)
                }
            }
            "relay_blob" -> {
                val blob = f.opt("blob") as? JSONObject ?: return null
                val hops = (f.opt("hops") as? Number)?.toInt() ?: return null
                if (hops < 0 || hops > MAX_RELAY_HOPS || !blobShapeOk(blob)) null else GroupFrame.RelayBlob(blob, hops)
            }
            else -> null
        }
    } catch (_: Exception) {
        null
    }
}

private fun blobShapeOk(b: JSONObject): Boolean =
    (b.opt("v") as? Number)?.toDouble() == 1.0 && b.opt("to") is String && b.opt("from") is String &&
        b.optJSONObject("epk")?.let(Seal::jwkOrNull) != null &&
        b.opt("iv") is String && b.opt("ct") is String && b.opt("sig") is String

/* ---------------- coordinator ---------------- */

class OutgoingFrame(val to: String, val frame: GroupFrame)

class NewContact(
    val card: ContactCard,
    val uid: String,
    /** The member who brought them into the group: what the user sees as "introduced by". */
    val introducedBy: String,
    val groupId: String,
)

class GroupResult {
    val outgoing = ArrayList<OutgoingFrame>()
    val changed = ArrayList<String>()
    val newContacts = ArrayList<NewContact>()
    val joined = ArrayList<String>()
    val left = ArrayList<String>()
}

enum class MessageVerdict { OK, UNKNOWN_GROUP, NOT_MEMBER }

class GroupException(message: String) : Exception(message)

class GroupCoordinator(
    private val ownUid: String,
    private val ownCard: ContactCard,
    /** Signs raw bytes with our identity signing key; returns base64url(r||s). */
    private val signer: (ByteArray) -> String,
    /** uids we already hold a contact for. Anyone else in a roster becomes a `newContacts` entry. */
    private val knownUids: () -> Set<String>,
    private val trusted: ((String) -> Boolean)? = null,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val logs = LinkedHashMap<String, GroupLog>()

    fun groupIds(): List<String> = logs.keys.toList()
    fun state(groupId: String): GroupState? = logs[groupId]?.state()
    fun myGroups(): List<GroupState> = logs.values.mapNotNull { it.state() }.filter { it.members.containsKey(ownUid) }
    fun isMember(groupId: String, uid: String) = state(groupId)?.members?.containsKey(uid) ?: false
    fun recipients(groupId: String): List<String> = state(groupId)?.members?.keys?.filter { it != ownUid } ?: emptyList()
    fun eventCount(groupId: String) = logs[groupId]?.size ?: 0

    /** Persistable form: every event of every group, in causal order. */
    fun export(): Map<String, List<JSONObject>> = logs.mapValues { it.value.toJson() }

    fun exportGroup(groupId: String): List<JSONObject>? = logs[groupId]?.toJson()

    fun load(saved: Map<String, List<Any?>>) {
        for ((groupId, events) in saved) logs[groupId] = GroupLog.fromJson(groupId, events)
    }

    /* ---- authoring ---- */

    class Created(val groupId: String, val result: GroupResult)

    fun createGroup(name: String, initialMembers: List<ContactCard> = emptyList()): Created {
        if (initialMembers.size + 1 > MAX_GROUP_MEMBERS) {
            throw GroupException("A group can have at most $MAX_GROUP_MEMBERS members, including you.")
        }
        val create = GroupEvents.sign(
            "", "create", ownUid, now(), emptyList(), card = ownCard, name = name.trim().take(60), sign = signer,
        )
        val log = GroupLog(create.groupId)
        logs[create.groupId] = log
        log.add(create)
        val result = GroupResult()
        result.changed.add(create.groupId)
        result.joined.add(create.groupId)
        for (card in initialMembers) result.outgoing.addAll(addMember(create.groupId, card).outgoing)
        return Created(create.groupId, result)
    }

    private fun author(groupId: String, type: String, target: String? = null, card: ContactCard? = null, name: String? = null): GroupResult {
        val log = logs[groupId]
        val state = log?.state()
        if (log == null || state == null || !state.members.containsKey(ownUid)) throw GroupException("You are not a member of this group.")
        val event = GroupEvents.sign(groupId, type, ownUid, now(), log.heads(), target, card, name, signer)
        if (log.add(event) != AddStatus.APPLIED || !log.isEffective(event.eventId)) {
            throw GroupException("That change is not allowed (for example, only an admin can remove other members).")
        }
        val result = GroupResult()
        result.changed.add(groupId)
        // Push to everyone who is a member now, plus the removed member so they learn they are out.
        val audience = LinkedHashSet<String>(log.state()!!.members.keys)
        if (target != null) audience.add(target)
        audience.remove(ownUid)
        for (uid in audience) {
            // A newly added member gets the whole history of the roster so they can verify and meet everyone.
            if (type == "add" && uid == target) result.outgoing.addAll(chunk(uid, log.all()))
            else result.outgoing.add(OutgoingFrame(uid, GroupFrame.Push(event)))
        }
        if (!log.state()!!.members.containsKey(ownUid)) result.left.add(groupId)
        return result
    }

    fun addMember(groupId: String, card: ContactCard): GroupResult {
        val uid = IdentityCodec.uidFor(card.dh)
        if (isMember(groupId, uid)) throw GroupException("Already in this group.")
        if ((state(groupId)?.members?.size ?: 0) >= MAX_GROUP_MEMBERS) {
            throw GroupException("This group is full ($MAX_GROUP_MEMBERS members is the limit).")
        }
        return author(groupId, "add", target = uid, card = card)
    }

    fun removeMember(groupId: String, uid: String) = author(groupId, "remove", target = uid)
    fun leave(groupId: String) = author(groupId, "remove", target = ownUid)
    fun rename(groupId: String, name: String) = author(groupId, "rename", name = name.trim().take(60))

    /* ---- link lifecycle ---- */

    /** Call when a verified link to [peerUid] opens: tell them what we have for groups they belong to. */
    fun onLinkOpen(peerUid: String): List<OutgoingFrame> {
        val groups = logs.entries.filter { it.value.state()?.members?.containsKey(peerUid) == true }
            .map { it.key to it.value.ids() }
        // Always sent, even when empty: the peer pushes us the groups we do not have yet (see `handle`).
        return listOf(OutgoingFrame(peerUid, GroupFrame.Have(groups, full = true)))
    }

    /* ---- receiving ---- */

    fun handle(fromUid: String, frame: GroupFrame): GroupResult {
        val result = GroupResult()
        when (frame) {
            is GroupFrame.Push -> applyEvents(fromUid, listOf(frame.event), result)
            is GroupFrame.Events -> applyEvents(fromUid, frame.events, result)
            is GroupFrame.Have -> {
              for ((groupId, ids) in frame.groups) {
                val log = logs[groupId]
                val s = log?.state()
                // Only members may pull a group's history; everyone else learns nothing, not even that it exists.
                if (log == null || s == null || !s.members.containsKey(fromUid)) continue
                val missing = log.missingFor(ids)
                if (missing.isNotEmpty()) result.outgoing.addAll(chunk(fromUid, missing))
                // If they know events we lack, ask them for those by replying with what we have.
                val mine = log.ids().toHashSet()
                if (ids.any { it !in mine }) {
                    result.outgoing.add(OutgoingFrame(fromUid, GroupFrame.Have(listOf(groupId to log.ids()))))
                }
              }
              if (frame.full) {
                // They listed everything they have: any group of ours they belong to but did not list is new to them.
                val listed = frame.groups.map { it.first }.toHashSet()
                for ((groupId, log) in logs) {
                    if (groupId in listed || log.state()?.members?.containsKey(fromUid) != true) continue
                    result.outgoing.addAll(chunk(fromUid, log.missingFor(emptyList())))
                }
              }
            }
            else -> Unit
        }
        return result
    }

    fun checkMessage(fromUid: String, groupId: String): MessageVerdict {
        val s = state(groupId) ?: return MessageVerdict.UNKNOWN_GROUP
        return if (s.members.containsKey(fromUid) && s.members.containsKey(ownUid)) MessageVerdict.OK else MessageVerdict.NOT_MEMBER
    }

    /** Ask a peer for the group's history (used when a message arrives for a group/sender we do not know yet). */
    fun requestSync(peerUid: String, groupId: String? = null): List<OutgoingFrame> {
        val groups = logs.entries.filter { groupId == null || it.key == groupId }.map { it.key to it.value.ids() }
        return listOf(OutgoingFrame(peerUid, GroupFrame.Have(groups)))
    }

    private fun chunk(to: String, events: List<GroupEvent>): List<OutgoingFrame> =
        events.chunked(MAX_EVENTS_PER_FRAME).map { OutgoingFrame(to, GroupFrame.Events(it)) }

    private fun canAccept(fromUid: String, groupId: String): Boolean {
        if (logs[groupId]?.state()?.members?.containsKey(fromUid) == true) return true
        return trusted?.invoke(fromUid) ?: knownUids().contains(fromUid)
    }

    private fun applyEvents(fromUid: String, events: List<GroupEvent>, result: GroupResult) {
        val touched = LinkedHashSet<String>()
        // Decide per group BEFORE applying anything: within one batch the sender may only become a member
        // (and so pass the check) after an earlier event of the same batch is applied.
        val accepted = HashMap<String, Boolean>()
        for (event in events) accepted.getOrPut(event.groupId) { canAccept(fromUid, event.groupId) }
        for (event in events) {
            if (accepted[event.groupId] != true) continue
            var log = logs[event.groupId]
            val isNew = log == null
            if (log == null) {
                log = GroupLog(event.groupId)
                logs[event.groupId] = log
            }
            val wasMember = log.state()?.members?.containsKey(ownUid) ?: false
            val status = log.add(event)
            if (isNew && status == AddStatus.INVALID) {
                logs.remove(event.groupId)
                continue
            }
            if (status == AddStatus.APPLIED) {
                touched.add(event.groupId)
                if (!wasMember && log.state()?.members?.containsKey(ownUid) == true) result.joined.add(event.groupId)
                // Gossip the news: members we may be linked to but the author could not reach.
                log.state()?.let { s ->
                    for (uid in s.members.keys) {
                        if (uid != ownUid && uid != fromUid && uid != event.actor) {
                            result.outgoing.add(OutgoingFrame(uid, GroupFrame.Push(event)))
                        }
                    }
                }
            } else if (status == AddStatus.BUFFERED) {
                // We are missing earlier events: ask this peer for the whole group.
                result.outgoing.addAll(requestSync(fromUid, event.groupId))
            }
        }
        for (groupId in touched) {
            val log = logs[groupId]!!
            val s = log.state()
            if (s == null || !s.members.containsKey(ownUid)) {
                // Never a member (spam from a contact): forget it. Previously a member: keep it, we were removed.
                val everMember = log.all().any { (it.type == "add" && it.target == ownUid) || (it.type == "create" && it.actor == ownUid) }
                if (!everMember) {
                    logs.remove(groupId)
                    continue
                }
                if (s != null && groupId !in result.left) result.left.add(groupId)
            }
            result.changed.add(groupId)
            if (s != null && s.members.containsKey(ownUid)) {
                val known = knownUids()
                for (m in s.members.values) {
                    if (m.uid != ownUid && m.uid !in known && result.newContacts.none { it.uid == m.uid }) {
                        result.newContacts.add(NewContact(m.card, m.uid, m.addedBy, groupId))
                    }
                }
            }
        }
    }
}
