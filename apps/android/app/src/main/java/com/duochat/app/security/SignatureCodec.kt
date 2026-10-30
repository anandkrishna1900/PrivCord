package com.duochat.app.security

import java.util.Base64

object SignatureCodec {
    private const val PART_LENGTH = 32

    fun base64UrlEncode(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun base64UrlDecode(value: String): ByteArray {
        val normalized = value.filterNot { it.isWhitespace() }.replace('-', '+').replace('_', '/')
        val padded = normalized + "=".repeat((4 - normalized.length % 4) % 4)
        return Base64.getDecoder().decode(padded)
    }

    fun derToP1363(der: ByteArray): ByteArray {
        var index = 0
        require(der.size > 8 && der[index] == 0x30.toByte()) { "Invalid DER signature." }
        index += 1
        val sequenceLength = readLength(der, index)
        index = sequenceLength.second
        require(der[index] == 0x02.toByte()) { "Invalid DER signature." }
        index += 1
        val rLength = readLength(der, index)
        index = rLength.second
        val r = der.copyOfRange(index, index + rLength.first)
        index += rLength.first
        require(der[index] == 0x02.toByte()) { "Invalid DER signature." }
        index += 1
        val sLength = readLength(der, index)
        index = sLength.second
        val s = der.copyOfRange(index, index + sLength.first)
        return normalize(r) + normalize(s)
    }

    fun p1363ToDer(raw: ByteArray): ByteArray {
        require(raw.size == PART_LENGTH * 2) { "Invalid raw signature." }
        val r = unsignedInteger(raw.copyOfRange(0, PART_LENGTH))
        val s = unsignedInteger(raw.copyOfRange(PART_LENGTH, raw.size))
        val body = byteArrayOf(0x02) + encodeLength(r.size) + r +
            byteArrayOf(0x02) + encodeLength(s.size) + s
        return byteArrayOf(0x30) + encodeLength(body.size) + body
    }

    fun signatureBytesToVerify(signature: ByteArray): ByteArray =
        if (signature.size == PART_LENGTH * 2) p1363ToDer(signature) else signature

    private fun normalize(value: ByteArray): ByteArray {
        var start = 0
        while (start < value.size - 1 && value[start] == 0.toByte()) start += 1
        val trimmed = value.copyOfRange(start, value.size)
        return if (trimmed.size >= PART_LENGTH) {
            trimmed.copyOfRange(trimmed.size - PART_LENGTH, trimmed.size)
        } else {
            ByteArray(PART_LENGTH - trimmed.size) + trimmed
        }
    }

    private fun unsignedInteger(value: ByteArray): ByteArray {
        val trimmed = normalize(value)
        return if (trimmed[0].toInt() and 0x80 != 0) byteArrayOf(0) + trimmed else trimmed
    }

    private fun readLength(data: ByteArray, start: Int): Pair<Int, Int> {
        val first = data[start].toInt() and 0xff
        if (first < 0x80) return first to start + 1
        val count = first and 0x7f
        var value = 0
        for (i in 0 until count) {
            value = (value shl 8) or (data[start + 1 + i].toInt() and 0xff)
        }
        return value to start + 1 + count
    }

    private fun encodeLength(length: Int): ByteArray =
        if (length < 0x80) byteArrayOf(length.toByte())
        else byteArrayOf(0x81.toByte(), length.toByte())
}
