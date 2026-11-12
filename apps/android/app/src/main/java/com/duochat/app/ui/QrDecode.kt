package com.duochat.app.ui

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.GlobalHistogramBinarizer
import com.google.zxing.common.HybridBinarizer

/**
 * QR decoding for the scanner, with no Android in it (so it is unit-tested on the JVM). Tries the image as it is and
 * inverted (light code on a dark screen), with the local binarizer first and the global one as a fallback for
 * blurry or unevenly lit frames.
 */
object QrDecode {
    private val hints = mapOf(
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
        DecodeHintType.TRY_HARDER to true,
        DecodeHintType.CHARACTER_SET to "UTF-8",
    )

    fun decode(source: LuminanceSource): String? {
        val reader = MultiFormatReader().apply { setHints(hints) }
        for (candidate in listOf(source, source.invert())) {
            for (bitmap in listOf(BinaryBitmap(HybridBinarizer(candidate)), BinaryBitmap(GlobalHistogramBinarizer(candidate)))) {
                val text = try {
                    reader.decodeWithState(bitmap).text
                } catch (_: Exception) {
                    null
                } finally {
                    reader.reset()
                }
                if (!text.isNullOrBlank()) return text
            }
        }
        return null
    }

    /** A camera frame's brightness plane ([rowStride] may be wider than [width]). */
    fun decodeLuma(luma: ByteArray, width: Int, height: Int, rowStride: Int): String? =
        decode(PlanarYUVLuminanceSource(luma, rowStride, height, 0, 0, width, height, false))

    /** A photo, as ARGB pixels. */
    fun decodeArgb(pixels: IntArray, width: Int, height: Int): String? = decode(RGBLuminanceSource(width, height, pixels))
}
