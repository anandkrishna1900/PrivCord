package com.duochat.app.ble

import org.json.JSONObject
import java.util.Collections

/**
 * PrivCord Android BLE Multi-hop Mesh Router
 *
 * Implements:
 * - TTL decrementing and maximum hop validation
 * - Anti-loop cache / deduplication of 16-byte packetIds
 * - Relaying ciphertext to neighbors without decrypting or possessing message keys
 * - Store-carry-forward cache for delayed opportunistic delivery
 */
class AndroidMeshRouter(
    private val ownUid: String,
    private val maxCacheSize: Int = 1000,
    private val defaultTtl: Int = 5,
) {
    data class MeshPacket(
        val packetId: String,
        val originUid: String,
        val destUid: String,
        val ttl: Int,
        val maxHops: Int,
        val timestamp: Long,
        val payload: String,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("v", 1)
            .put("kind", "mesh_pkt")
            .put("packetId", packetId)
            .put("originUid", originUid)
            .put("destUid", destUid)
            .put("ttl", ttl)
            .put("maxHops", maxHops)
            .put("timestamp", timestamp)
            .put("payload", payload)

        companion object {
            fun fromJson(json: JSONObject): MeshPacket? = try {
                if (json.optInt("v") != 1 || json.optString("kind") != "mesh_pkt") null
                else MeshPacket(
                    packetId = json.getString("packetId"),
                    originUid = json.getString("originUid"),
                    destUid = json.getString("destUid"),
                    ttl = json.getInt("ttl"),
                    maxHops = json.optInt("maxHops", 5),
                    timestamp = json.getLong("timestamp"),
                    payload = json.getString("payload"),
                )
            } catch (_: Exception) {
                null
            }
        }
    }

    enum class Action { CONSUME, FORWARD, DROP }

    private val seenPackets = Collections.synchronizedSet(LinkedHashSet<String>())
    private val storeCache = Collections.synchronizedMap(LinkedHashMap<String, Pair<MeshPacket, Long>>())

    fun processPacket(packet: MeshPacket, nowMs: Long = System.currentTimeMillis()): Action {
        if (packet.ttl <= 0) return Action.DROP
        if (nowMs - packet.timestamp > 24 * 3600 * 1000L) return Action.DROP // Expired > 24 hours

        synchronized(seenPackets) {
            if (!seenPackets.add(packet.packetId)) return Action.DROP // Duplicate / Loop
            if (seenPackets.size > maxCacheSize * 2) {
                val it = seenPackets.iterator()
                var removed = 0
                while (it.hasNext() && removed < 500) {
                    it.next()
                    it.remove()
                    removed++
                }
            }
        }

        if (packet.destUid == ownUid || packet.destUid == "*") {
            return Action.CONSUME
        }

        return Action.FORWARD
    }

    fun nextHop(packet: MeshPacket): MeshPacket? {
        if (packet.ttl <= 1) return null
        return packet.copy(ttl = packet.ttl - 1)
    }

    fun store(packet: MeshPacket, ttlMs: Long = 3600 * 1000L) {
        synchronized(storeCache) {
            if (storeCache.size >= maxCacheSize) {
                val firstKey = storeCache.keys.firstOrNull()
                if (firstKey != null) storeCache.remove(firstKey)
            }
            storeCache[packet.packetId] = packet to (System.currentTimeMillis() + ttlMs)
        }
    }

    fun getPacketsFor(peerUid: String, nowMs: Long = System.currentTimeMillis()): List<MeshPacket> {
        val result = mutableListOf<MeshPacket>()
        synchronized(storeCache) {
            val it = storeCache.entries.iterator()
            while (it.hasNext()) {
                val entry = it.next()
                if (entry.value.second < nowMs) {
                    it.remove()
                    continue
                }
                val pkt = entry.value.first
                if (pkt.destUid == peerUid || pkt.destUid == "*") {
                    result.add(pkt)
                }
            }
        }
        return result
    }
}
