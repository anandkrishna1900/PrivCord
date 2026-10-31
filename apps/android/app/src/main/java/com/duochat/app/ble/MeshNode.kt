package com.duochat.app.ble

import com.duochat.app.security.SealedBlob
import org.json.JSONObject

/**
 * Bluetooth mesh relaying (multi-hop). Port of packages/protocol/src/mesh/node.ts; read the comment there.
 * Radio-independent: validate, drop repeats, count hops, flood to neighbours, carry messages for neighbours that
 * show up later, refuse spammers. The radio layer (MeshBle) only moves the JSON between phones.
 */
const val MESH_MAX_TTL = 7
const val MESH_MAX_PACKET_BYTES = 8 * 1024
const val MESH_CARRY_MS = 30 * 60_000L

class MeshPacket(val id: String, val ttl: Int, val blob: SealedBlob) {
    fun toJson(): JSONObject = JSONObject().put("v", 1).put("kind", "mesh").put("id", id).put("ttl", ttl).put("blob", blob.toJson())

    companion object {
        fun idOf(blob: SealedBlob): String = blob.sig.take(24)

        fun make(blob: SealedBlob, ttl: Int = MESH_MAX_TTL) = MeshPacket(idOf(blob), ttl.coerceIn(1, MESH_MAX_TTL), blob)

        /** Null for anything that is not a well-formed packet. A neighbour cannot raise the hop limit by writing a bigger ttl. */
        fun parse(json: JSONObject?): MeshPacket? {
            if (json == null || json.optInt("v", -1) != 1 || json.optString("kind") != "mesh") return null
            val id = json.opt("id") as? String ?: return null
            val ttl = (json.opt("ttl") as? Number)?.toInt() ?: return null
            if (ttl < 1) return null
            val blob = SealedBlob.fromJson(json.optJSONObject("blob")) ?: return null
            if (id != idOf(blob)) return null
            if (json.toString().length > MESH_MAX_PACKET_BYTES) return null
            return MeshPacket(id, minOf(ttl, MESH_MAX_TTL), blob)
        }
    }
}

class MeshOutgoing(val link: String, val packet: MeshPacket)

class MeshHandled(val accepted: SealedBlob?, val forward: List<MeshOutgoing>)

class MeshNode(
    private val perSenderPerMinute: Int = 30,
    private val seenCapacity: Int = 4000,
    private val carryMs: Long = MESH_CARRY_MS,
    private val carryCapacity: Int = 300,
) {
    private class Carried(val packet: MeshPacket, val storedAt: Long, val sentTo: MutableSet<String> = HashSet())

    private val links = LinkedHashSet<String>()
    private val seen = LinkedHashMap<String, Long>()
    private val carried = LinkedHashMap<String, Carried>()
    private val senderWindow = LinkedHashMap<String, MutableList<Long>>()

    val neighbours: List<String> @Synchronized get() = links.toList()

    /** A message we wrote: send it to every neighbour and keep it for ones that arrive later. */
    @Synchronized
    fun inject(blob: SealedBlob, now: Long): List<MeshOutgoing> {
        val packet = MeshPacket.make(blob)
        remember(packet.id, now)
        val entry = carry(packet, now)
        return links.map { MeshOutgoing(it, packet).also { _ -> entry?.sentTo?.add(it) } }
    }

    /** A packet from a neighbour. */
    @Synchronized
    fun handle(json: JSONObject?, from: String, now: Long): MeshHandled {
        val packet = MeshPacket.parse(json)
        if (packet == null || seen.containsKey(packet.id)) return MeshHandled(null, emptyList())
        remember(packet.id, now)
        if (!allowSender(packet.blob.from, now)) return MeshHandled(null, emptyList())
        val forward = ArrayList<MeshOutgoing>()
        if (packet.ttl > 1) {
            val next = MeshPacket(packet.id, packet.ttl - 1, packet.blob)
            val entry = carry(next, now)
            entry?.sentTo?.add(from)
            for (link in links) {
                if (link == from) continue
                forward.add(MeshOutgoing(link, next))
                entry?.sentTo?.add(link)
            }
        }
        return MeshHandled(packet.blob, forward)
    }

    /** A new neighbour: hand it everything we are carrying that it has not been given. */
    @Synchronized
    fun linkUp(link: String, now: Long): List<MeshOutgoing> {
        links.add(link)
        expire(now)
        val out = ArrayList<MeshOutgoing>()
        for (c in carried.values) {
            if (!c.sentTo.add(link)) continue
            out.add(MeshOutgoing(link, c.packet))
        }
        return out
    }

    @Synchronized
    fun linkDown(link: String) {
        links.remove(link)
        // A link that drops may have dropped a packet in flight: forget what we "sent" over it so the next link-up
        // hands everything over again (the other phone ignores copies it already has).
        for (c in carried.values) c.sentTo.remove(link)
    }

    private fun remember(id: String, now: Long) {
        seen[id] = now
        if (seen.size > seenCapacity) seen.remove(seen.keys.first())
    }

    private fun carry(packet: MeshPacket, now: Long): Carried? {
        if (packet.ttl < 1) return null
        expire(now)
        val entry = Carried(packet, now)
        carried[packet.id] = entry
        if (carried.size > carryCapacity) carried.remove(carried.keys.first())
        return entry
    }

    private fun expire(now: Long) {
        val it = carried.entries.iterator()
        while (it.hasNext()) if (now - it.next().value.storedAt > carryMs) it.remove()
    }

    /** At most [perSenderPerMinute] new messages from one sender are passed on; the rest are ignored. */
    private fun allowSender(from: String, now: Long): Boolean {
        val recent = (senderWindow[from] ?: mutableListOf()).filter { now - it < 60_000 }.toMutableList()
        if (recent.size >= perSenderPerMinute) {
            senderWindow[from] = recent
            return false
        }
        recent.add(now)
        senderWindow[from] = recent
        if (senderWindow.size > 2000) senderWindow.remove(senderWindow.keys.first())
        return true
    }
}
