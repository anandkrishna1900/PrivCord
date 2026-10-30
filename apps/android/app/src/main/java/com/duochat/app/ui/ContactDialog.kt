package com.duochat.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.duochat.app.data.ChatState
import com.duochat.app.security.WordCode
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * Add-a-friend dialog with three sharing modes:
 *   Tab 0 — QR Code  : show your own card as a QR + 6-word WordCode; tap to scan a friend's QR.
 *   Tab 1 — Word Code : display your 6 words large; enter a friend's 6 words to look them up.
 *   Tab 2 — Card Text : paste / copy the raw DUOID1:… card string (legacy fallback).
 */
@Composable
fun ContactDialog(
    state: ChatState,
    ownCard: () -> String,
    onPreview: (String) -> Result<Unit>,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val pending = state.pendingContact
    val card = remember { runCatching(ownCard).getOrDefault("") }

    // Derive own 6-word code from uid (first 16 hex chars of DH fingerprint)
    val ownWords = remember(state.uid) {
        runCatching { WordCode.encode(state.uid.take(16)) }.getOrDefault("… … … … … …")
    }

    // QR bitmap of own card
    val ownQr = remember(card) { qrBitmap(card) }

    var selectedTab by remember { mutableIntStateOf(0) }
    val tabs = listOf("QR Code", "Word Code", "Card Text")

    // Shared state for the text-paste / word-code tabs
    var pasted by remember { mutableStateOf("") }
    var wordInput by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf(false) }
    var wordsCopied by remember { mutableStateOf(false) }

    // QR scanner launcher – auto-detects card vs. word code
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@rememberLauncherForActivityResult
        when {
            contents.startsWith("DUOID1:") -> {
                val res = onPreview(contents)
                if (res.isFailure) error = res.exceptionOrNull()?.message ?: "Invalid card"
            }
            contents.trim().split(Regex("\\s+")).size == 6 -> {
                // Word code scanned — decode to UID hint
                val uid = WordCode.decode(contents.trim())
                if (uid != null) {
                    error = null
                    wordInput = contents.trim()
                    selectedTab = 1
                } else {
                    error = "QR scanned but word code was invalid (checksum mismatch)."
                }
            }
            else -> {
                // Try it as a raw card anyway
                val res = onPreview(contents)
                if (res.isFailure) error = "Scanned QR is not a recognised PrivCord contact."
            }
        }
    }

    val launchScanner = {
        val options = ScanOptions().apply {
            setDesiredBarcodeFormats(listOf("QR_CODE"))
            setPrompt("Scan your friend's PrivCord QR code")
            setBeepEnabled(false)
            setOrientationLocked(false)
        }
        scanner.launch(options)
    }

    Dialog(onDismissRequest = { onCancel(); onDismiss() }) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.92f),
            shape = RoundedCornerShape(24.dp),
            color = MaterialTheme.colorScheme.surface,
        ) {
            Column(Modifier.fillMaxWidth()) {

                // ── Title ──────────────────────────────────────────────────
                Text(
                    "Add a contact",
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.padding(start = 20.dp, top = 20.dp, end = 20.dp, bottom = 8.dp),
                )

                // ── Safety number / confirm step (shown above tabs when pending) ──
                if (pending != null) {
                    Column(Modifier.padding(horizontal = 20.dp).verticalScroll(rememberScrollState())) {
                        Text("Compare the safety number", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "Read these numbers to your friend over a separate channel (call, in person). " +
                                "Confirm only if they match exactly on both phones.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(10.dp))
                        Text(pending.safetyNumber, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(14.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { onConfirm(); onDismiss() }) { Text("Numbers match — save") }
                            OutlinedButton(onClick = onCancel) { Text("Don't match") }
                        }
                        Spacer(Modifier.height(16.dp))
                    }
                    return@Surface
                }

                if (state.paired) {
                    Column(
                        Modifier
                            .padding(20.dp)
                            .verticalScroll(rememberScrollState()),
                    ) {
                        Text(
                            "You are paired. PrivCord reconnects to your friend automatically whenever you are both online. " +
                                "To pair with someone else, use Reset pairing in Settings.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(14.dp))
                        Button(onClick = onDismiss) { Text("Done") }
                    }
                    return@Surface
                }

                // ── Tabs ───────────────────────────────────────────────────
                TabRow(selectedTabIndex = selectedTab) {
                    tabs.forEachIndexed { index, title ->
                        Tab(
                            selected = selectedTab == index,
                            onClick = { selectedTab = index; error = null },
                            text = { Text(title, style = MaterialTheme.typography.labelMedium) },
                        )
                    }
                }

                // ── Tab content ────────────────────────────────────────────
                Column(
                    Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                        .padding(20.dp),
                ) {
                    when (selectedTab) {

                        // ── TAB 0: QR Code ─────────────────────────────────
                        0 -> {
                            Text(
                                "Your contact QR",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Spacer(Modifier.height(4.dp))
                            Text(
                                "Let a friend scan this, or scan theirs with the button below. " +
                                    "Your QR contains only public keys — never private keys.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(12.dp))

                            // QR image
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 16.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                if (ownQr != null) {
                                    Image(
                                        bitmap = ownQr.asImageBitmap(),
                                        contentDescription = "Your contact QR code",
                                        modifier = Modifier
                                            .size(240.dp)
                                            .background(Color.White)
                                            .padding(8.dp),
                                    )
                                } else {
                                    Text(
                                        "QR unavailable",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                }
                            }

                            Spacer(Modifier.height(10.dp))

                            // 6-word code beneath the QR
                            Surface(
                                color = MaterialTheme.colorScheme.surfaceVariant,
                                shape = RoundedCornerShape(12.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Column(
                                    Modifier.padding(12.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                ) {
                                    Text(
                                        "Your 6-word code",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    Spacer(Modifier.height(4.dp))
                                    Text(
                                        ownWords,
                                        style = MaterialTheme.typography.titleMedium,
                                        fontFamily = FontFamily.Monospace,
                                        fontWeight = FontWeight.SemiBold,
                                        textAlign = TextAlign.Center,
                                    )
                                }
                            }

                            Spacer(Modifier.height(16.dp))

                            // Scan button
                            Button(
                                onClick = launchScanner,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Icon(
                                    Icons.Filled.QrCodeScanner,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                )
                                Spacer(Modifier.width(8.dp))
                                Text("Scan friend's QR code")
                            }

                            error?.let {
                                Spacer(Modifier.height(8.dp))
                                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                            }
                        }

                        // ── TAB 1: Word Code ───────────────────────────────
                        1 -> {
                            Text(
                                "Your 6-word public code",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Spacer(Modifier.height(4.dp))
                            Text(
                                "Share these 6 words with a friend so they can find your public address. " +
                                    "They are derived from your public key — sharing them is safe.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(12.dp))

                            Surface(
                                color = MaterialTheme.colorScheme.primaryContainer,
                                shape = RoundedCornerShape(16.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Column(
                                    Modifier.padding(16.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                ) {
                                    Text(
                                        ownWords,
                                        style = MaterialTheme.typography.headlineSmall,
                                        fontFamily = FontFamily.Monospace,
                                        fontWeight = FontWeight.Bold,
                                        textAlign = TextAlign.Center,
                                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                                    )
                                }
                            }
                            Spacer(Modifier.height(8.dp))
                            OutlinedButton(
                                onClick = {
                                    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                                        .setPrimaryClip(ClipData.newPlainText("PrivCord word code", ownWords))
                                    wordsCopied = true
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Icon(Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(6.dp))
                                Text(if (wordsCopied) "Copied!" else "Copy my 6 words")
                            }

                            Spacer(Modifier.height(20.dp))
                            Text(
                                "Enter a friend's 6-word code",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Spacer(Modifier.height(6.dp))
                            OutlinedTextField(
                                value = wordInput,
                                onValueChange = { wordInput = it; error = null },
                                label = { Text("word1 word2 word3 word4 word5 word6") },
                                singleLine = false,
                                minLines = 2,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            error?.let {
                                Spacer(Modifier.height(4.dp))
                                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                            }
                            Spacer(Modifier.height(8.dp))
                            Button(
                                enabled = wordInput.isNotBlank(),
                                onClick = {
                                    val uid = WordCode.decode(wordInput.trim())
                                    if (uid == null) {
                                        error = "Invalid word code — please check spelling and try again."
                                    } else {
                                        error = null
                                        // Word code only gives the public UID (64-bit).
                                        // We can't fully verify without the full card, so inform the user.
                                        error = "Found UID: $uid\n\nAsk your friend to also share their QR or card text so " +
                                            "you can complete secure pairing with full key verification."
                                    }
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text("Look up friend's code")
                            }
                            Spacer(Modifier.height(6.dp))
                            Text(
                                "💡 For full end-to-end verification, switch to the QR Code tab and scan your friend's QR.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }

                        // ── TAB 2: Card Text (legacy fallback) ─────────────
                        2 -> {
                            var cardCopied by remember { mutableStateOf(false) }
                            var pasteError by remember { mutableStateOf<String?>(null) }

                            Text("Share your contact card", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                            Text(
                                "Copy your card and send it to your friend via any channel. Then paste their card below.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = card,
                                onValueChange = {},
                                readOnly = true,
                                label = { Text("Your card") },
                                minLines = 3,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            OutlinedButton(
                                onClick = {
                                    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                                        .setPrimaryClip(ClipData.newPlainText("PrivCord contact card", card))
                                    cardCopied = true
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Icon(Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(6.dp))
                                Text(if (cardCopied) "Copied!" else "Copy my card")
                            }

                            Spacer(Modifier.height(16.dp))
                            Text("Paste friend's card", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                            Spacer(Modifier.height(6.dp))
                            OutlinedTextField(
                                value = pasted,
                                onValueChange = { pasted = it; pasteError = null },
                                label = { Text("DUOID1:…") },
                                minLines = 3,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            pasteError?.let {
                                Spacer(Modifier.height(4.dp))
                                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                            }
                            Spacer(Modifier.height(8.dp))
                            Button(
                                enabled = pasted.isNotBlank(),
                                onClick = {
                                    pasteError = onPreview(pasted).exceptionOrNull()?.message
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text("Continue")
                            }
                        }
                    }
                }
            }
        }
    }
}
