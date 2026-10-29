package com.duochat.app.ui

import android.graphics.Bitmap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.duochat.app.data.ChatState
import com.duochat.app.data.PeerTrust
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

private enum class ManualMode { HOST, GUEST }

@Composable
fun ManualConnectDialog(
    state: ChatState,
    onDismiss: () -> Unit,
    onConfirmPeer: () -> Unit,
    onCreateOffer: ((Result<String>) -> Unit) -> Unit,
    onApplyAnswer: (String, (Result<Unit>) -> Unit) -> Unit,
    onAcceptOffer: ((String, (Result<String>) -> Unit) -> Unit),
) {
    var mode by remember { mutableStateOf(ManualMode.HOST) }
    var offerCode by remember { mutableStateOf("") }
    var answerInput by remember { mutableStateOf("") }
    var answerCode by remember { mutableStateOf("") }
    var joinInput by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val clipboard = LocalClipboardManager.current

    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (contents.isNullOrBlank()) return@rememberLauncherForActivityResult
        if (mode == ManualMode.HOST) {
            answerInput = contents
            status = "Scanned an answer. Apply it to finish the handshake."
        } else {
            joinInput = contents
            status = "Scanned an offer. Tap Accept offer to answer it."
        }
    }

    val scan = {
        val options = ScanOptions().apply {
            setDesiredBarcodeFormats(listOf("QR_CODE"))
            setPrompt("Scan a DuoChat code")
            setBeepEnabled(false)
            setOrientationLocked(false)
        }
        scanner.launch(options)
    }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.92f),
            shape = RoundedCornerShape(24.dp),
            color = MaterialTheme.colorScheme.surface,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "Manual connection",
                        style = MaterialTheme.typography.headlineSmall,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Filled.Close, contentDescription = "Close")
                    }
                }
                Text(
                    "Use this when the cloud is unavailable. Share the codes over another " +
                        "channel you trust, such as a call. The codes contain signaling data " +
                        "and a public key, never private keys or message text.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                if (state.p2pConnected) {
                    Spacer(Modifier.height(12.dp))
                    Surface(
                        color = MaterialTheme.colorScheme.primaryContainer,
                        shape = RoundedCornerShape(14.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier.padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                Icons.Filled.CheckCircle,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "Direct connection established.",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }

                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ModeChip("Create offer", mode == ManualMode.HOST) {
                        mode = ManualMode.HOST
                        error = null
                        status = null
                    }
                    ModeChip("Join with offer", mode == ManualMode.GUEST) {
                        mode = ManualMode.GUEST
                        error = null
                        status = null
                    }
                }

                Spacer(Modifier.height(16.dp))
                if (mode == ManualMode.HOST) {
                    Text(
                        "1. Create an offer code and send it to your friend.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Spacer(Modifier.height(8.dp))
                    Button(
                        onClick = {
                            busy = true
                            error = null
                            status = null
                            onCreateOffer { result ->
                                busy = false
                                result.fold(
                                    onSuccess = {
                                        offerCode = it
                                        status = "Offer ready. Send it to your friend."
                                    },
                                    onFailure = {
                                        error = it.message ?: "Could not create an offer."
                                    },
                                )
                            }
                        },
                        enabled = !busy,
                    ) {
                        if (busy) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(15.dp),
                                strokeWidth = 2.dp,
                            )
                            Spacer(Modifier.width(8.dp))
                        }
                        Icon(
                            Icons.Filled.QrCode2,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(if (offerCode.isBlank()) "Create offer code" else "Create a new offer")
                    }
                    if (offerCode.isNotBlank()) {
                        Spacer(Modifier.height(10.dp))
                        CodeBlock(offerCode) { clipboard.setText(AnnotatedString(offerCode)) }
                        Spacer(Modifier.height(16.dp))
                        Text(
                            "2. Paste or scan the answer code your friend sends back.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = answerInput,
                            onValueChange = { answerInput = it },
                            label = { Text("Answer code") },
                            minLines = 2,
                            maxLines = 4,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(8.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                onClick = {
                                    busy = true
                                    error = null
                                    status = null
                                    onApplyAnswer(answerInput.trim()) { result ->
                                        busy = false
                                        result.fold(
                                            onSuccess = {
                                                status =
                                                    "Answer applied. Waiting for the direct channel."
                                            },
                                            onFailure = {
                                                error = it.message
                                                    ?: "Could not apply the answer code."
                                            },
                                        )
                                    }
                                },
                                enabled = !busy && answerInput.isNotBlank(),
                            ) {
                                if (busy) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(15.dp),
                                        strokeWidth = 2.dp,
                                    )
                                    Spacer(Modifier.width(8.dp))
                                }
                                Text("Apply answer")
                            }
                            OutlinedButton(onClick = scan) {
                                Icon(
                                    Icons.Filled.QrCodeScanner,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                )
                                Spacer(Modifier.width(6.dp))
                                Text("Scan answer")
                            }
                        }
                    }
                } else {
                    Text(
                        "1. Paste or scan the offer code your friend sent you.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = joinInput,
                        onValueChange = { joinInput = it },
                        label = { Text("Offer code") },
                        minLines = 2,
                        maxLines = 4,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = {
                                busy = true
                                error = null
                                status = null
                                onAcceptOffer(joinInput.trim()) { result ->
                                    busy = false
                                    result.fold(
                                        onSuccess = {
                                            answerCode = it
                                            status = "Answer ready. Send it back to your friend."
                                        },
                                        onFailure = {
                                            error = it.message ?: "Could not accept the offer."
                                        },
                                    )
                                }
                            },
                            enabled = !busy && joinInput.isNotBlank(),
                        ) {
                            if (busy) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(15.dp),
                                    strokeWidth = 2.dp,
                                )
                                Spacer(Modifier.width(8.dp))
                            }
                            Text("Accept offer")
                        }
                        OutlinedButton(onClick = scan) {
                            Icon(
                                Icons.Filled.QrCodeScanner,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(Modifier.width(6.dp))
                            Text("Scan offer")
                        }
                    }
                    if (answerCode.isNotBlank()) {
                        Spacer(Modifier.height(16.dp))
                        Text(
                            "2. Send this answer code back to your friend.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(8.dp))
                        CodeBlock(answerCode) { clipboard.setText(AnnotatedString(answerCode)) }
                    }
                }

                error?.let {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                status?.let {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                Spacer(Modifier.height(16.dp))
                HorizontalDivider()
                Spacer(Modifier.height(14.dp))

                Text(
                    "Verify your friend",
                    style = MaterialTheme.typography.titleMedium,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    "Compare the safety number below with your friend over the same trusted " +
                        "channel before confirming. Manual connections are not cloud-verified.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                val safety = state.safetyNumber
                if (safety != null) {
                    Spacer(Modifier.height(10.dp))
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        shape = RoundedCornerShape(14.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.padding(12.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    Icons.Filled.Shield,
                                    contentDescription = null,
                                    modifier = Modifier.size(15.dp),
                                )
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    "Safety number",
                                    style = MaterialTheme.typography.labelSmall,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                            Spacer(Modifier.height(6.dp))
                            Text(
                                safety,
                                fontFamily = FontFamily.Monospace,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                } else {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "The safety number appears after the handshake completes.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Trust status: ",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        when (state.peerTrust) {
                            PeerTrust.CONFIRMED -> "confirmed"
                            PeerTrust.VERIFIED -> "cloud-verified"
                            PeerTrust.UNVERIFIED -> "unverified"
                            PeerTrust.NONE -> "not established"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                Spacer(Modifier.height(10.dp))
                Button(
                    onClick = onConfirmPeer,
                    enabled = state.peerTrust == PeerTrust.UNVERIFIED ||
                        state.peerTrust == PeerTrust.VERIFIED,
                ) {
                    Icon(
                        Icons.Filled.Shield,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text("I compared the safety number — confirm")
                }
                Spacer(Modifier.height(8.dp))
                TextButton(onClick = onDismiss) {
                    Text("Close")
                }
            }
        }
    }
}

@Composable
private fun ModeChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = if (selected) {
            MaterialTheme.colorScheme.primaryContainer
        } else {
            MaterialTheme.colorScheme.surfaceVariant
        },
        modifier = Modifier.clickable(onClick = onClick),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = if (selected) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun CodeBlock(code: String, onCopy: () -> Unit) {
    val bitmap = remember(code) { qrBitmap(code) }
    if (bitmap != null) {
        Spacer(Modifier.height(4.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.Center,
        ) {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = "Connection QR code",
                modifier = Modifier
                    .size(240.dp)
                    .background(androidx.compose.ui.graphics.Color.White)
                    .padding(8.dp),
            )
        }
    }
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = code,
        onValueChange = {},
        readOnly = true,
        label = { Text("Code") },
        minLines = 2,
        maxLines = 4,
        textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(8.dp))
    OutlinedButton(onClick = onCopy) {
        Icon(
            Icons.Filled.ContentCopy,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text("Copy code")
    }
}

private fun qrBitmap(text: String, size: Int = 900): Bitmap? = try {
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
