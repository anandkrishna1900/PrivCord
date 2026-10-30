package com.duochat.app.security

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** docs/android-vectors.json: ground truth produced by the TypeScript protocol (packages/protocol/scripts). */
object Vectors {
    val all: JSONObject by lazy {
        // Gradle runs unit tests with the module dir (apps/android/app) as the working dir.
        val file = listOf("../../../docs/android-vectors.json", "../../docs/android-vectors.json", "docs/android-vectors.json")
            .map(::File).first { it.exists() }
        JSONObject(file.readText(Charsets.UTF_8))
    }

    fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    fun unhex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    fun jwkPub(o: JSONObject) = PublicJwk(o.getString("x"), o.getString("y"))
    fun d(o: JSONObject) = SignatureCodec.base64UrlDecode(o.getString("d"))
    fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }
}
