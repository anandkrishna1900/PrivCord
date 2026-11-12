package com.duochat.app.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FlashOff
import androidx.compose.material.icons.filled.FlashOn
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Returns a function that opens the QR scanner. It asks for the camera first and says so if it is refused, so the user
 * never lands on a black viewfinder; [onScanned] gets the text of the code.
 */
@Composable
internal fun rememberQrScanner(prompt: String, onScanned: (String) -> Unit): () -> Unit {
    val context = LocalContext.current
    var open by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) open = true
        else Toast.makeText(context, "Allow the camera in Settings to scan a code, or type the six words instead.", Toast.LENGTH_LONG).show()
    }
    if (open) QrScannerScreen(prompt, onResult = { open = false; onScanned(it) }, onClose = { open = false })
    return remember(prompt) {
        {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) open = true
            else permission.launch(Manifest.permission.CAMERA)
        }
    }
}

/**
 * The scanner. It reads codes on its own from the live picture; the round button takes a full-resolution photo and
 * reads that (for a small, far or glare-covered code the live picture misses); the gallery button reads a code from a
 * screenshot or photo. Tap the picture to focus there; the torch button lights a dark code.
 */
@Composable
private fun QrScannerScreen(prompt: String, onResult: (String) -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val done = remember { AtomicBoolean(false) }
    var camera by remember { mutableStateOf<Camera?>(null) }
    var torch by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var hint by remember { mutableStateOf<String?>(null) }
    val capture = remember {
        ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY).build()
    }
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }

    fun found(text: String) {
        if (!done.compareAndSet(false, true)) return
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        onResult(text)
    }

    val gallery = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        busy = true
        scope.launch {
            val text = withContext(Dispatchers.Default) { decodeImage(context, uri) }
            busy = false
            if (text != null) found(text) else hint = "No code found in that picture."
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
            analysisExecutor.shutdown()
        }
    }

    Dialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    PreviewView(ctx).apply {
                        // TextureView: a SurfaceView can stay black inside a dialog window.
                        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                        scaleType = PreviewView.ScaleType.FILL_CENTER
                        val view = this
                        val providerFuture = ProcessCameraProvider.getInstance(ctx)
                        providerFuture.addListener({
                            val provider = runCatching { providerFuture.get() }.getOrNull() ?: return@addListener
                            val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
                            val analysis = ImageAnalysis.Builder()
                                .setResolutionSelector(
                                    ResolutionSelector.Builder()
                                        .setResolutionStrategy(ResolutionStrategy(android.util.Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                                        .build(),
                                )
                                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                                .build()
                            analysis.setAnalyzer(analysisExecutor) { image -> analyze(image)?.let { text -> view.post { found(text) } } }
                            try {
                                provider.unbindAll()
                                camera = provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis, capture)
                            } catch (e: Exception) {
                                hint = "The camera could not start. Try the gallery button, or type the six words instead."
                            }
                        }, ContextCompat.getMainExecutor(ctx))
                        // Tap to focus (and meter) on that spot.
                        setOnTouchListener { v, event ->
                            if (event.action == android.view.MotionEvent.ACTION_UP) {
                                val point = meteringPointFactory.createPoint(event.x, event.y)
                                camera?.cameraControl?.startFocusAndMetering(FocusMeteringAction.Builder(point).build())
                                v.performClick()
                            }
                            true
                        }
                    }
                },
            )

            ScanFrame(Modifier.fillMaxSize())

            Column(
                Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Surface(onClick = onClose, shape = CircleShape, color = Color.Black.copy(alpha = 0.45f), contentColor = Color.White, modifier = Modifier.size(48.dp)) {
                        Box(contentAlignment = Alignment.Center) { Icon(Icons.Filled.Close, contentDescription = "Close the scanner") }
                    }
                    Spacer(Modifier.weight(1f))
                    if (camera?.cameraInfo?.hasFlashUnit() == true) {
                        Surface(
                            onClick = { torch = !torch; camera?.cameraControl?.enableTorch(torch) },
                            shape = CircleShape, color = Color.Black.copy(alpha = 0.45f), contentColor = Color.White, modifier = Modifier.size(48.dp),
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                Icon(if (torch) Icons.Filled.FlashOn else Icons.Filled.FlashOff, contentDescription = if (torch) "Turn the light off" else "Turn the light on")
                            }
                        }
                    }
                }
                Spacer(Modifier.height(24.dp))
                Text(prompt, color = Color.White, style = androidx.compose.material3.MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
                Spacer(Modifier.height(6.dp))
                Text(
                    hint ?: "Hold the code inside the frame. It is read on its own, or tap the button to take a photo.",
                    color = Color.White.copy(alpha = 0.8f), style = androidx.compose.material3.MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center,
                )
                Spacer(Modifier.weight(1f))
                Row(
                    Modifier.fillMaxWidth().padding(bottom = 12.dp),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = { gallery.launch("image/*") }, modifier = Modifier.size(56.dp)) {
                        Icon(Icons.Filled.PhotoLibrary, contentDescription = "Read a code from a picture", tint = Color.White)
                    }
                    // Manual: a full-resolution photo, read with more effort than a live frame gets.
                    Surface(
                        onClick = {
                            if (busy) return@Surface
                            busy = true
                            hint = null
                            capture.takePicture(ContextCompat.getMainExecutor(context), object : ImageCapture.OnImageCapturedCallback() {
                                override fun onCaptureSuccess(image: ImageProxy) {
                                    scope.launch {
                                        val text = withContext(Dispatchers.Default) { image.use { decodeCaptured(it) } }
                                        busy = false
                                        if (text != null) found(text) else hint = "No code in that photo. Fill the frame with the code and try again."
                                    }
                                }

                                override fun onError(exception: ImageCaptureException) {
                                    busy = false
                                    hint = "Could not take the photo. Try again."
                                }
                            })
                        },
                        shape = CircleShape,
                        color = Color.White,
                        modifier = Modifier.size(76.dp).semantics { contentDescription = "Take a photo of the code" },
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            if (busy) CircularProgressIndicator(Modifier.size(28.dp), color = Color.Black, strokeWidth = 3.dp)
                            else Box(Modifier.size(62.dp).background(Color.White, CircleShape).padding(2.dp).background(Color.Black.copy(alpha = 0.08f), CircleShape))
                        }
                    }
                    Spacer(Modifier.size(56.dp))
                }
            }
        }
    }
}

/** The dimmed surround with a clear, rounded square in the middle and corners that breathe while it looks. */
@Composable
private fun ScanFrame(modifier: Modifier) {
    val pulse by rememberInfiniteTransition(label = "frame").animateFloat(
        initialValue = 0.6f, targetValue = 1f, label = "frame",
        animationSpec = infiniteRepeatable(tween(900, easing = Motion.Standard), androidx.compose.animation.core.RepeatMode.Reverse),
    )
    Canvas(modifier.graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }) {
        val side = size.minDimension * 0.68f
        val topLeft = Offset((size.width - side) / 2f, (size.height - side) / 2f - size.height * 0.04f)
        val radius = CornerRadius(28.dp.toPx())
        drawRect(Color.Black.copy(alpha = 0.55f))
        drawRoundRect(Color.Transparent, topLeft, Size(side, side), radius, blendMode = BlendMode.Clear)
        drawRoundRect(Color.White.copy(alpha = pulse), topLeft, Size(side, side), radius, style = Stroke(width = 3.dp.toPx()))
    }
}

/** A live frame: only its brightness plane is needed. Returns the code's text, or null. */
private fun analyze(image: ImageProxy): String? = image.use {
    val plane = it.planes.firstOrNull() ?: return null
    val buffer = plane.buffer
    val bytes = ByteArray(buffer.remaining()).also { b -> buffer.get(b) }
    // The last row can be shorter than the stride; pad so the decoder never reads past the end.
    val needed = plane.rowStride * it.height
    val luma = if (bytes.size >= needed) bytes else bytes.copyOf(needed)
    QrDecode.decodeLuma(luma, it.width, it.height, plane.rowStride)
}

/** A full-resolution photo (JPEG from ImageCapture). */
private fun decodeCaptured(image: ImageProxy): String? {
    val buffer = image.planes.firstOrNull()?.buffer ?: return null
    val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
    return decodeBitmap(bitmapFrom(bytes) ?: return null)
}

/** A picture from the gallery. */
private fun decodeImage(context: Context, uri: Uri): String? = runCatching {
    val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
    decodeBitmap(bitmapFrom(bytes) ?: return null)
}.getOrNull()

/** Decodes at most about 2000 pixels across: enough for any code, and quick. */
private fun bitmapFrom(bytes: ByteArray): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 2000) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
}

private fun decodeBitmap(bitmap: Bitmap): String? {
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    return QrDecode.decodeArgb(pixels, bitmap.width, bitmap.height)
}
