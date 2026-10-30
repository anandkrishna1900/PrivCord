package com.duochat.app.data

import org.json.JSONArray
import org.json.JSONObject

enum class TransportMode { AUTOMATIC, BLUETOOTH_ONLY, INTERNET_ONLY }

data class TurnServer(
    val urls: List<String>,
    val username: String,
    val credential: String,
)

sealed class SignalingConfig {
    data class Nostr(val relays: List<String>) : SignalingConfig()
    data class Relay(val url: String) : SignalingConfig()
}

data class NetworkConfig(
    val stun: List<String> = DEFAULT_STUN,
    val turn: List<TurnServer> = emptyList(),
    val signaling: List<SignalingConfig> = listOf(SignalingConfig.Nostr(DEFAULT_NOSTR_RELAYS)),
    val storeForward: Boolean = false,
    val forceRelay: Boolean = false,
    val bluetooth: Boolean = true,
    val transportMode: TransportMode = TransportMode.AUTOMATIC,
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
        .put(
            "signaling",
            JSONArray(
                signaling.map {
                    when (it) {
                        is SignalingConfig.Nostr -> JSONObject().put("kind", "nostr").put("relays", JSONArray(it.relays))
                        is SignalingConfig.Relay -> JSONObject().put("kind", "relay").put("url", it.url)
                    }
                },
            ),
        )
        .put("storeForward", storeForward)
        .put("forceRelay", forceRelay)
        .put("bluetooth", bluetooth)
        apply { if (transportMode != TransportMode.AUTOMATIC) put("transportMode", transportMode.name) }
        .toString()

    companion object {
        val DEFAULT_STUN = listOf(
            "stun:stun.l.google.com:19302",
            "stun:stun.cloudflare.com:3478",
        )
        val DEFAULT_NOSTR_RELAYS = listOf("wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net")

        fun isStunUrl(value: String) = isIceUrl(value, "stun", "stuns")
        fun isTurnUrl(value: String) = isIceUrl(value, "turn", "turns")

        private fun isIceUrl(value: String, vararg schemes: String): Boolean {
            val m = Regex("^([a-z]+):[^\\s]+$", RegexOption.IGNORE_CASE).find(value.trim()) ?: return false
            return m.groupValues[1].lowercase() in schemes
        }

        fun isWsUrl(value: String): Boolean = try {
            val uri = java.net.URI(value)
            (uri.scheme == "ws" || uri.scheme == "wss") && !uri.host.isNullOrEmpty()
        } catch (_: Exception) {
            false
        }

        fun parseStunList(text: String): List<String> =
            text.split(',', '\n', ' ', ';').map { it.trim() }.filter { it.isNotEmpty() && isStunUrl(it) }

        fun parseTurnUrls(text: String): List<String> =
            text.split(',', '\n', ' ', ';').map { it.trim() }.filter { it.isNotEmpty() && isTurnUrl(it) }

        fun parseWsList(text: String): List<String> =
            text.split(',', '\n', ' ', ';').map { it.trim() }.filter { it.isNotEmpty() && isWsUrl(it) }

        private fun strings(array: JSONArray?): List<String> =
            if (array == null) emptyList()
            else (0 until array.length()).mapNotNull { (array.opt(it) as? String)?.trim() }
                .filter { it.isNotEmpty() && it.length <= 512 }

        fun fromJson(raw: String?, fallback: NetworkConfig = NetworkConfig()): NetworkConfig {
            if (raw.isNullOrBlank()) return fallback
            return try {
                val json = JSONObject(raw)
                val stun = if (json.optJSONArray("stun") != null) {
                    strings(json.optJSONArray("stun")).filter(::isStunUrl)
                } else fallback.stun
                val turnArray = json.optJSONArray("turn")
                val turn = if (turnArray != null) {
                    (0 until turnArray.length()).mapNotNull { index ->
                        val entry = turnArray.optJSONObject(index) ?: return@mapNotNull null
                        val urls = strings(entry.optJSONArray("urls")).filter(::isTurnUrl)
                        val username = entry.opt("username") as? String
                        val credential = entry.opt("credential") as? String
                        if (urls.isEmpty() || username == null || credential == null) null
                        else TurnServer(urls, username, credential)
                    }
                } else fallback.turn
                val signalingArray = json.optJSONArray("signaling")
                val signaling = if (signalingArray != null) {
                    (0 until signalingArray.length()).mapNotNull { index ->
                        val entry = signalingArray.optJSONObject(index) ?: return@mapNotNull null
                        when (entry.opt("kind")) {
                            "nostr" -> strings(entry.optJSONArray("relays")).filter(::isWsUrl)
                                .takeIf { it.isNotEmpty() }?.let { SignalingConfig.Nostr(it) }
                            "relay" -> (entry.opt("url") as? String)?.trim()
                                ?.takeIf { it.isNotEmpty() && it.length <= 512 && isWsUrl(it) }
                                ?.let { SignalingConfig.Relay(it) }
                            else -> null
                        }
                    }
                } else fallback.signaling

                val modeStr = json.optString("transportMode", "")
                val mode = try {
                    if (modeStr.isNotEmpty()) TransportMode.valueOf(modeStr) else fallback.transportMode
                } catch (_: Exception) {
                    fallback.transportMode
                }

                NetworkConfig(
                    stun = stun,
                    turn = turn,
                    signaling = signaling,
                    storeForward = json.opt("storeForward") == true,
                    forceRelay = json.opt("forceRelay") == true,
                    bluetooth = json.opt("bluetooth") != false,
                    transportMode = mode,
                )
            } catch (_: Exception) {
                fallback
            }
        }
    }
}
