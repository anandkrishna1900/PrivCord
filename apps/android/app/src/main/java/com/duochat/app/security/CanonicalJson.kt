package com.duochat.app.security

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal

/**
 * Same output as `canonicalJson` in packages/protocol/src/e2ee/primitives.ts: object keys sorted by
 * UTF-16 code unit, no whitespace, strings escaped like JS `JSON.stringify` (well-formed). Signatures
 * cover this text, so it must match byte for byte.
 */
object CanonicalJson {
    fun of(value: Any?): String = StringBuilder().also { write(it, value) }.toString()

    private fun write(out: StringBuilder, value: Any?) {
        when (value) {
            null, JSONObject.NULL -> out.append("null")
            is Boolean -> out.append(value.toString())
            is Int, is Long, is Short, is Byte -> out.append(value.toString())
            is Number -> out.append(BigDecimal(value.toString()).stripTrailingZeros().toPlainString())
            is String -> string(out, value)
            is JSONArray -> {
                out.append('[')
                for (i in 0 until value.length()) {
                    if (i > 0) out.append(',')
                    write(out, value.get(i))
                }
                out.append(']')
            }
            is JSONObject -> writeMap(out, value.keys().asSequence().associateWith { value.get(it) })
            is Map<*, *> -> writeMap(out, value.entries.associate { it.key.toString() to it.value })
            is List<*> -> {
                out.append('[')
                value.forEachIndexed { i, item ->
                    if (i > 0) out.append(',')
                    write(out, item)
                }
                out.append(']')
            }
            else -> throw IllegalArgumentException("Unsupported value for canonical JSON.")
        }
    }

    private fun writeMap(out: StringBuilder, map: Map<String, Any?>) {
        out.append('{')
        var first = true
        for (key in map.keys.sorted()) {
            // JS drops `undefined`; org.json never produces it, so every key is written.
            if (!first) out.append(',')
            first = false
            string(out, key)
            out.append(':')
            write(out, map[key])
        }
        out.append('}')
    }

    private fun string(out: StringBuilder, s: String) {
        out.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\b' -> out.append("\\b")
                c == '\u000C' -> out.append("\\f")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' -> out.append("\\u").append("%04x".format(c.code))
                Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> {
                    out.append(c).append(s[i + 1])
                    i += 1
                }
                Character.isSurrogate(c) -> out.append("\\u").append("%04x".format(c.code))
                else -> out.append(c)
            }
            i += 1
        }
        out.append('"')
    }
}
