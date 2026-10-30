package com.duochat.app.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * STUN and TURN are separate things. STUN only tells a device its public
 * address (no data passes through it). TURN relays the already end-to-end
 * encrypted stream when no direct path exists. Both are optional and editable.
 * Schema matches docs/CONNECTIVITY.md section 3.
 */
data class TurnServer(
    val urls: List<String>,
    val username: String,
    val credential: String,
)

data class NetworkConfig(
    val stun: List<String> = DEFAULT_STUN,
    val turn: List<TurnServer> = emptyList(),
    /** Only use TURN relay candidates (hides your IP from the peer; needs a TURN server). */
    val forceRelay: Boolean = false,
) {
    fun toJson(): String = JSONObject()
        .put("stun", JSONArray(stun))
        .put(
            "turn",
            JSONArray(
                turn.map {
                    JSONObject()
                        .put("urls", JSONArray(it.urls))
                        .put("username", it.username)
                        .put("credential", it.credential)
                },
            ),
        )
        .put("forceRelay", forceRelay)
        .toString()

    companion object {
        val DEFAULT_STUN = listOf(
            "stun:stun.l.google.com:19302",
            "stun:stun.cloudflare.com:3478",
        )

        fun isStunUrl(value: String) = value.startsWith("stun:") || value.startsWith("stuns:")
        fun isTurnUrl(value: String) = value.startsWith("turn:") || value.startsWith("turns:")

        /** Splits on commas/whitespace and keeps only well-formed STUN urls. */
        fun parseStunList(text: String): List<String> =
            text.split(',', '\n', ' ', ';').map { it.trim() }.filter { it.isNotEmpty() && isStunUrl(it) }

        fun parseTurnUrls(text: String): List<String> =
            text.split(',', '\n', ' ', ';').map { it.trim() }.filter { it.isNotEmpty() && isTurnUrl(it) }

        /** Tolerant parse: anything malformed falls back to defaults for that field. */
        fun fromJson(raw: String?, fallback: NetworkConfig = NetworkConfig()): NetworkConfig {
            if (raw.isNullOrBlank()) return fallback
            return try {
                val json = JSONObject(raw)
                val stun = json.optJSONArray("stun")?.let { array ->
                    (0 until array.length()).map { array.optString(it) }.filter(::isStunUrl)
                } ?: fallback.stun
                val turn = json.optJSONArray("turn")?.let { array ->
                    (0 until array.length()).mapNotNull { index ->
                        val entry = array.optJSONObject(index) ?: return@mapNotNull null
                        val urls = entry.optJSONArray("urls")?.let { urlArray ->
                            (0 until urlArray.length()).map { urlArray.optString(it) }.filter(::isTurnUrl)
                        }.orEmpty()
                        val username = entry.optString("username")
                        val credential = entry.optString("credential")
                        if (urls.isEmpty() || username.isEmpty() || credential.isEmpty()) {
                            null
                        } else {
                            TurnServer(urls, username, credential)
                        }
                    }
                } ?: fallback.turn
                NetworkConfig(stun, turn, json.optBoolean("forceRelay", fallback.forceRelay))
            } catch (_: Exception) {
                fallback
            }
        }
    }
}
