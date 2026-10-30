package com.duochat.app.groups

import com.duochat.app.security.Bip39
import com.duochat.app.security.ContactCard
import com.duochat.app.security.EcKeys
import com.duochat.app.security.IdentityCodec
import com.duochat.app.security.RecoveryIdentity
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import org.junit.Assert.assertNotNull

/** A test identity made from a fixed (public, test-only) phrase. */
class TestPerson(val name: String, val phrase: String) {
    private val keys = RecoveryIdentity.derive(phrase)
    val uid: String = keys.uid
    val card = ContactCard(
        keys.signPub, keys.dhPub,
        EcKeys.sign(keys.signD, IdentityCodec.identityProofPayload(keys.dhPub)), name,
    )
    val signer: (ByteArray) -> String = { EcKeys.sign(keys.signD, it) }

    companion object {
        fun numbered(i: Int, name: String = "P$i") = TestPerson(name, Bip39.fromEntropy(ByteArray(16) { (it + i * 7 + 1).toByte() }))
    }
}

object GroupVectors {
    val all: JSONObject by lazy {
        val file = listOf("../../../docs/group-vectors.json", "../../docs/group-vectors.json", "docs/group-vectors.json")
            .map(::File).first { it.exists() }
        JSONObject(file.readText(Charsets.UTF_8))
    }
}

fun JSONArray.objs(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }

/** A device in the simulation: its coordinator, the contacts it has pinned, and what it learned. */
class SimNode(val p: TestPerson) {
    val known = HashSet<String>()
    val cards = HashMap<String, ContactCard>()
    val introducedBy = HashMap<String, String>()
    var online = true
    val joined = ArrayList<String>()
    val left = ArrayList<String>()
    val coord = GroupCoordinator(p.uid, p.card, p.signer, { known })

    fun pin(other: TestPerson) {
        known.add(other.uid)
        cards[other.uid] = other.card
    }
}

/** In-memory network: frames are only delivered over links where both sides know each other and are online. */
class SimNet {
    val nodes = LinkedHashMap<String, SimNode>()
    private val linked = HashSet<String>()
    var frames = 0
    var dropped = 0

    fun add(n: SimNode) = n.also { nodes[n.p.uid] = it }
    private fun key(a: String, b: String) = if (a < b) "$a|$b" else "$b|$a"
    fun isLinked(a: String, b: String) = linked.contains(key(a, b))

    fun reconcile() {
        var changed = true
        while (changed) {
            changed = false
            for (a in nodes.values.toList()) for (b in nodes.values.toList()) {
                if (a === b || !a.online || !b.online) continue
                if (a.known.contains(b.p.uid) && b.known.contains(a.p.uid) && !isLinked(a.p.uid, b.p.uid)) {
                    linked.add(key(a.p.uid, b.p.uid))
                    changed = true
                    dispatch(a, a.coord.onLinkOpen(b.p.uid))
                    dispatch(b, b.coord.onLinkOpen(a.p.uid))
                }
            }
        }
    }

    fun setOnline(n: SimNode, online: Boolean) {
        n.online = online
        if (!online) linked.removeAll { it.split('|').contains(n.p.uid) }
    }

    fun dispatch(from: SimNode, out: List<OutgoingFrame>) {
        val queue = ArrayDeque(out.map { from to it })
        while (queue.isNotEmpty()) {
            val (sender, frame) = queue.removeFirst()
            val target = nodes[frame.to]
            if (target == null || !isLinked(sender.p.uid, target.p.uid)) {
                dropped += 1
                continue
            }
            frames += 1
            // Frames cross the wire as JSON.
            val parsed = parseGroupFrame(JSONObject(frame.frame.toJson().toString()))
            assertNotNull("frame must parse: ${frame.frame.toJson()}", parsed)
            absorb(target, target.coord.handle(sender.p.uid, parsed!!), queue)
        }
    }

    private fun absorb(n: SimNode, r: GroupResult, queue: ArrayDeque<Pair<SimNode, OutgoingFrame>>) {
        n.joined.addAll(r.joined)
        n.left.addAll(r.left)
        for (c in r.newContacts) {
            n.known.add(c.uid)
            n.cards[c.uid] = c.card
            n.introducedBy[c.uid] = c.introducedBy
        }
        for (f in r.outgoing) queue.addLast(n to f)
        if (r.newContacts.isNotEmpty()) reconcile()
    }

    /** Run a locally authored change: apply its result on the author, then deliver. */
    fun run(author: SimNode, result: GroupResult) {
        absorb(author, result, ArrayDeque())
        dispatch(author, result.outgoing)
        reconcile()
    }
}

fun rosterOf(log: GroupLog): String = (log.state()?.members?.keys ?: emptySet<String>()).sorted().joinToString(",")
