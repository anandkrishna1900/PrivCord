package com.duochat.app.ui

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QrDecodeTest {
    private val invite = "duocord:invite:apple-river-stone-candle-moon-tiger"

    private fun matrix(text: String, size: Int) =
        QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 2))

    @Test
    fun decodesACameraFrameWithPaddedRows() {
        // A camera frame: the code sits inside a bigger grey picture, and each row is padded past the image width.
        val code = matrix(invite, 300)
        val width = 640
        val height = 480
        val stride = 704
        val luma = ByteArray(stride * height) { 0x90.toByte() }
        for (y in 0 until 300) for (x in 0 until 300) {
            luma[(y + 90) * stride + x + 170] = if (code[x, y]) 0x10 else 0xF0.toByte()
        }
        assertEquals(invite, QrDecode.decodeLuma(luma, width, height, stride))
    }

    @Test
    fun decodesALightCodeOnADarkScreen() {
        val code = matrix(invite, 400)
        val pixels = IntArray(400 * 400) { i -> if (code[i % 400, i / 400]) 0xFFFFFFFF.toInt() else 0xFF000000.toInt() }
        assertEquals(invite, QrDecode.decodeArgb(pixels, 400, 400))
    }

    @Test
    fun aBlankPictureHasNoCode() {
        assertNull(QrDecode.decodeArgb(IntArray(200 * 200) { 0xFF808080.toInt() }, 200, 200))
    }
}
