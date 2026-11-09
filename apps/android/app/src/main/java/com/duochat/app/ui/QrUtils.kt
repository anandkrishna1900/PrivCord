package com.duochat.app.ui

import android.graphics.Bitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import android.Manifest
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/** Shared QR-code bitmap helper used by ContactDialog and ManualConnectDialog. */
internal fun qrBitmap(text: String, size: Int = 900): Bitmap? = try {
    val hints = mapOf(
        EncodeHintType.MARGIN to 1,
        EncodeHintType.CHARACTER_SET to "UTF-8",
        EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.L,
    )
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints)
    val pixels = IntArray(size * size)
    for (y in 0 until size) {
        val row = y * size
        for (x in 0 until size) {
            pixels[row + x] = if (matrix[x, y]) {
                android.graphics.Color.BLACK
            } else {
                android.graphics.Color.WHITE
            }
        }
    }
    Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888).apply {
        setPixels(pixels, 0, size, 0, 0, size, size)
    }
} catch (_: Exception) {
    null
}


/** QR-only, upright, no beep: the options every scan in the app uses. */
internal fun qrScanOptions(prompt: String): ScanOptions = ScanOptions().apply {
    setDesiredBarcodeFormats(listOf("QR_CODE"))
    setPrompt(prompt)
    setBeepEnabled(false)
    setOrientationLocked(true)
    setCaptureActivity(PortraitCaptureActivity::class.java)
}

/**
 * Returns a function that opens the QR scanner. It asks for the camera first and says so if it is refused, so the user
 * never lands on a black viewfinder; [onScanned] gets the text of the code.
 */
@Composable
internal fun rememberQrScanner(prompt: String, onScanned: (String) -> Unit): () -> Unit {
    val context = LocalContext.current
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.takeIf { it.isNotBlank() }?.let(onScanned)
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scanner.launch(qrScanOptions(prompt))
        else Toast.makeText(context, "Allow the camera in Settings to scan a code, or type the six words instead.", Toast.LENGTH_LONG).show()
    }
    return remember(prompt) {
        {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                scanner.launch(qrScanOptions(prompt))
            } else {
                permission.launch(Manifest.permission.CAMERA)
            }
        }
    }
}
