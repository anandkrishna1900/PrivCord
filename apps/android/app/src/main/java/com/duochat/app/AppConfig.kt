package com.duochat.app

import com.duochat.app.data.NetworkConfig
import com.duochat.app.data.TurnServer
import com.duochat.app.data.NetworkConfig.Companion.parseTurnUrls

object AppConfig {
    const val APP_VERSION = "0.1.0"

    val conversationId: String =
        BuildConfig.CONVERSATION_ID.ifBlank { "duo" }

    /**
     * Network defaults. A TURN server given at build time (local.properties
     * turn.url / turn.username / turn.credential) seeds the editable setting.
     */
    fun defaultNetworkConfig(): NetworkConfig {
        val urls = parseTurnUrls(BuildConfig.TURN_URL)
        val turn = if (
            urls.isNotEmpty() &&
            BuildConfig.TURN_USERNAME.isNotBlank() &&
            BuildConfig.TURN_CREDENTIAL.isNotBlank()
        ) {
            listOf(TurnServer(urls, BuildConfig.TURN_USERNAME, BuildConfig.TURN_CREDENTIAL))
        } else {
            emptyList()
        }
        return NetworkConfig(turn = turn)
    }
}
