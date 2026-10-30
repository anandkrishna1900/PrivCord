package com.duochat.app.security

import org.json.JSONObject

/** Public identity handed to a friend (QR / paste). Contains no secrets. Same format as the desktop card. */
data class ContactCard(val sign: PublicJwk, val dh: PublicJwk, val proof: String, val name: String? = null)

data class Contact(val uid: String, val card: ContactCard)

object ContactCards {
    const val PREFIX = "DUOID1:"

    private fun jwk(key: PublicJwk) = JSONObject().put("kty", "EC").put("crv", "P-256").put("x", key.x).put("y", key.y)

    fun encode(card: ContactCard): String {
        val json = JSONObject().put("v", 1).put("sign", jwk(card.sign)).put("dh", jwk(card.dh)).put("proof", card.proof)
        if (!card.name.isNullOrEmpty()) json.put("name", card.name.take(40))
        return PREFIX + SignatureCodec.base64UrlEncode(CanonicalJson.of(json).toByteArray(Charsets.UTF_8))
    }

    /** Parses and cryptographically validates a card. Null if anything is off. */
    fun decode(text: String): Contact? = try {
        val trimmed = text.trim()
        if (!trimmed.startsWith(PREFIX)) null
        else {
            val json = JSONObject(String(SignatureCodec.base64UrlDecode(trimmed.removePrefix(PREFIX)), Charsets.UTF_8))
            val sign = json.optJSONObject("sign")?.let(Seal::jwkOrNull)
            val dh = json.optJSONObject("dh")?.let(Seal::jwkOrNull)
            val proof = json.opt("proof") as? String
            val name = if (json.has("name")) (json.opt("name") as? String ?: return null).take(40) else null
            if (json.optInt("v", -1) != 1 || sign == null || dh == null || proof == null) null
            else if (!IdentityCodec.verifyIdentityProof(sign, dh, proof)) null
            else Contact(IdentityCodec.uidFor(dh), ContactCard(sign, dh, proof, name?.ifEmpty { null }))
        }
    } catch (_: Exception) {
        null
    }
}
