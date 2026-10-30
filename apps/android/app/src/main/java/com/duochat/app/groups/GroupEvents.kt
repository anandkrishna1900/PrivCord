package com.duochat.app.groups

import com.duochat.app.security.CanonicalJson
import com.duochat.app.security.ContactCard
import com.duochat.app.security.IdentityCodec
import com.duochat.app.security.PublicJwk
import com.duochat.app.security.Seal
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/**
 * Port of packages/protocol/src/groups/events.ts. A group is a signed, causally ordered log of
 * membership events. Event ids and signatures cover canonical JSON that must match the TypeScript
 * implementation byte for byte, so an event keeps the exact JSON it was received as ([raw]) and the
 * signed body is rebuilt from those fields (card keys exactly as received, `v:1`, absent fields omitted).
 */
class GroupEvent(val raw: JSONObject) {
    val eventId: String get() = raw.getString("eventId")
    val groupId: String get() = raw.getString("groupId")
    val type: String get() = raw.getString("type")
    val actor: String get() = raw.getString("actor")
    val deps: List<String> get() = raw.getJSONArray("deps").let { a -> List(a.length()) { a.getString(it) } }
    val target: String? get() = if (raw.has("target")) raw.getString("target") else null
    val name: String? get() = if (raw.has("name")) raw.getString("name") else null
    val sig: String get() = raw.getString("sig")
    val cardJson: JSONObject? get() = raw.optJSONObject("card")

    fun toJson(): JSONObject = JSONObject(raw.toString())
}

object GroupEvents {
    const val MAX_GROUP_NAME = 60
    private val ID = Regex("^[0-9a-f]{64}$")
    private val TYPES = setOf("create", "add", "remove", "rename")

    private fun sha256Hex(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    /** The canonical unsigned body (TS `body()`). */
    fun body(
        groupId: String, type: String, actor: String, ts: Any, deps: List<String>,
        target: String?, card: JSONObject?, name: String?,
    ): String {
        val o = JSONObject()
            .put("v", 1).put("kind", "group_event").put("groupId", groupId).put("type", type)
            .put("actor", actor).put("ts", ts).put("deps", JSONArray(deps.sorted()))
        if (target != null) o.put("target", target)
        if (card != null) {
            val c = JSONObject().put("v", 1).put("sign", card.get("sign")).put("dh", card.get("dh")).put("proof", card.get("proof"))
            if (card.has("name")) c.put("name", card.get("name"))
            o.put("card", c)
        }
        if (name != null) o.put("name", name)
        return CanonicalJson.of(o)
    }

    private fun bodyOf(e: JSONObject, groupId: String): String = body(
        groupId, e.getString("type"), e.getString("actor"), e.get("ts"),
        e.getJSONArray("deps").let { a -> List(a.length()) { a.getString(it) } },
        if (e.has("target")) e.getString("target") else null, e.optJSONObject("card"),
        if (e.has("name")) e.getString("name") else null,
    )

    fun cardJson(card: ContactCard): JSONObject {
        fun jwk(k: PublicJwk) = JSONObject().put("kty", "EC").put("crv", "P-256").put("x", k.x).put("y", k.y)
        val o = JSONObject().put("v", 1).put("sign", jwk(card.sign)).put("dh", jwk(card.dh)).put("proof", card.proof)
        if (!card.name.isNullOrEmpty()) o.put("name", card.name.take(40))
        return o
    }

    fun cardFromJson(json: JSONObject?): ContactCard? {
        if (json == null) return null
        val sign = json.optJSONObject("sign")?.let(Seal::jwkOrNull) ?: return null
        val dh = json.optJSONObject("dh")?.let(Seal::jwkOrNull) ?: return null
        val proof = json.opt("proof") as? String ?: return null
        val name = (json.opt("name") as? String)?.take(40)?.ifEmpty { null }
        return ContactCard(sign, dh, proof, name)
    }

    /**
     * Build and sign an event. [sign] signs raw bytes with the actor's identity signing key and returns
     * base64url(r||s). For `create`, [groupId] is ignored: the group id becomes the event id.
     */
    fun sign(
        groupId: String, type: String, actor: String, ts: Long, deps: List<String>,
        target: String? = null, card: ContactCard? = null, name: String? = null,
        sign: (ByteArray) -> String,
    ): GroupEvent {
        val cj = card?.let(::cardJson)
        val sortedDeps = deps.sorted()
        val gid = if (type == "create") "" else groupId
        val eventId = sha256Hex(body(gid, type, actor, ts, sortedDeps, target, cj, name))
        val finalGroup = if (type == "create") eventId else groupId
        val finalBody = body(finalGroup, type, actor, ts, sortedDeps, target, cj, name)
        val text = if (type == "create") "$finalBody|$eventId" else finalBody
        val raw = JSONObject()
            .put("v", 1).put("kind", "group_event").put("eventId", eventId).put("groupId", finalGroup)
            .put("type", type).put("actor", actor).put("ts", ts).put("deps", JSONArray(sortedDeps))
        if (target != null) raw.put("target", target)
        if (cj != null) raw.put("card", cj)
        if (name != null) raw.put("name", name)
        raw.put("sig", sign(text.toByteArray(Charsets.UTF_8)))
        return GroupEvent(raw)
    }

    fun isShape(value: Any?): Boolean {
        val e = value as? JSONObject ?: return false
        try {
            if ((e.opt("v") as? Number)?.toDouble() != 1.0 || e.opt("kind") != "group_event") return false
            val id = e.opt("eventId") as? String ?: return false
            if (!ID.matches(id)) return false
            if (e.opt("groupId") !is String) return false
            if ((e.opt("actor") as? String).isNullOrEmpty()) return false
            val type = e.opt("type") as? String ?: return false
            if (type !in TYPES) return false
            val ts = (e.opt("ts") as? Number)?.toDouble() ?: return false
            if (ts.isNaN() || ts.isInfinite()) return false
            val deps = e.opt("deps") as? JSONArray ?: return false
            if (deps.length() > 64 || (0 until deps.length()).any { deps.opt(it) !is String }) return false
            if (e.has("target") && e.opt("target") !is String) return false
            if (e.has("name")) {
                val n = e.opt("name") as? String ?: return false
                // JS string length counts UTF-16 units, as does Kotlin's.
                if (n.isEmpty() || n.length > MAX_GROUP_NAME) return false
            }
            if (e.opt("sig") !is String) return false
            if ((type == "add" || type == "remove") && e.optString("target").isEmpty()) return false
            if ((type == "create" || type == "add") && !(e.opt("card") is JSONObject)) return false
            if ((type == "create" || type == "rename") && e.optString("name").isEmpty()) return false
            if (e.opt("card") is JSONObject) {
                val c = e.getJSONObject("card")
                if (c.opt("sign") !is JSONObject || c.opt("dh") !is JSONObject || c.opt("proof") !is String) return false
            }
            return true
        } catch (_: Exception) {
            return false
        }
    }

    /** Recompute the id; for `create` the group id must equal the event id. */
    fun eventIdMatches(e: GroupEvent): Boolean {
        val gid = if (e.type == "create") "" else e.groupId
        val id = sha256Hex(bodyOf(e.raw, gid))
        return id == e.eventId && (e.type != "create" || e.groupId == id)
    }

    fun cardIsValid(card: JSONObject?, expectedUid: String): Boolean {
        val c = cardFromJson(card) ?: return false
        return try {
            IdentityCodec.verifyIdentityProof(c.sign, c.dh, c.proof) && IdentityCodec.uidFor(c.dh) == expectedUid
        } catch (_: Exception) {
            false
        }
    }

    fun signatureValid(e: GroupEvent, signer: PublicJwk): Boolean = try {
        val b = bodyOf(e.raw, e.groupId)
        val text = if (e.type == "create") "$b|${e.eventId}" else b
        IdentityCodec.verify(signer, text.toByteArray(Charsets.UTF_8), e.sig)
    } catch (_: Exception) {
        false
    }
}
