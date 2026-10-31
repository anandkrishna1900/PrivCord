package com.duochat.app.ui

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import com.duochat.app.data.ActiveInvite
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.duochat.app.data.ChatState
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * One screen to add a friend: show your invite (QR, copy, share) and scan or paste theirs. Afterwards an
 * optional, skippable "Check it's really them" step compares the numbers.
 */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun AddFriendScreen(
    state: ChatState,
    ownCard: () -> String,
    onAdd: (String, (Result<String>) -> Unit) -> Unit,
    onCreateInvite: ((Result<ActiveInvite>) -> Unit) -> Unit,
    onRetryAnswer: () -> Unit,
    onClearAnswer: () -> Unit,
    onChecked: (String) -> Unit,
    onBack: () -> Unit,
    onOpenChat: (String) -> Unit,
) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val card = remember(state.uid, state.notice == null) { ownCard() }
    val qr = remember(card) { if (card.isEmpty()) null else qrBitmap(card) }
    var pasted by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    var wordsCopied by remember { mutableStateOf(false) }
    var showFull by remember { mutableStateOf(false) }
    var wordsError by remember { mutableStateOf<String?>(null) }
    // Make the six words once when the screen opens (they last 15 minutes).
    LaunchedEffect(Unit) { onCreateInvite { r -> r.onFailure { wordsError = it.message ?: "Could not make a six-word invite." } } }
    // The friend just added (uid): shows the optional check.
    var addedUid by rememberSaveable { mutableStateOf<String?>(null) }

    fun add(text: String) {
        if (busy) return
        busy = true
        error = null
        onAdd(text.trim()) { result ->
            busy = false
            result.onSuccess { uid ->
                addedUid = uid
                pasted = ""
            }.onFailure { error = it.message ?: "Could not add that invite." }
        }
    }

    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@rememberLauncherForActivityResult
        add(contents)
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                title = { Text("Add friend") },
            )
        },
    ) { padding ->
        val added = addedUid?.let { uid -> state.contacts.firstOrNull { it.uid == uid } }
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp)) {
            if (added != null) {
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(40.dp))
                        Spacer(Modifier.height(8.dp))
                        Text("${added.name} was added", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Text(
                            "You will connect automatically whenever you are both online.",
                            style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(12.dp))
                        Button(onClick = { onOpenChat(added.uid) }) { Text("Say hello") }
                    }
                }
                // Typed their words: say plainly whether our own invite reached them. They confirm us on their side.
                state.answer?.takeIf { it.uid == added.uid }?.let { answer ->
                    Spacer(Modifier.height(12.dp))
                    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp)) {
                            when (answer.state) {
                                com.duochat.app.data.AnswerState.SENDING -> {
                                    Text("Sending your invite to ${answer.name}…", style = MaterialTheme.typography.bodyMedium)
                                }
                                com.duochat.app.data.AnswerState.SENT -> {
                                    Text("Your invite was sent to ${answer.name}", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                                    Text(
                                        "${answer.name} will see a request to add you. As soon as they accept, you are connected.",
                                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                com.duochat.app.data.AnswerState.FAILED -> {
                                    Text("Your invite did not reach ${answer.name}", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.error)
                                    Text(answer.error ?: "", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    Text(
                                        "You can try again, or show ${answer.name} your own six words from this screen so they can add you.",
                                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    Spacer(Modifier.height(8.dp))
                                    Button(onClick = onRetryAnswer) { Text("Send it again") }
                                }
                            }
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))
                Text("Check it's really them (optional)", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(6.dp))
                Text(
                    "Ask ${added.name} to open this screen on their phone. If their numbers match these, nobody is in the middle.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(10.dp))
                SafetyNumberBox(added.safetyNumber)
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onChecked(added.uid) }, enabled = !added.checked) {
                        Text(if (added.checked) "Checked" else "The numbers match")
                    }
                    TextButton(onClick = { addedUid = null; onClearAnswer() }) { Text("Skip for now") }
                }
                return@Column
            }

            Text("Your invite", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            Text(
                "Let a friend scan this code or type the six words below. It only contains your public identity.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Surface(shape = RoundedCornerShape(16.dp), color = androidx.compose.ui.graphics.Color.White) {
                    if (qr != null) {
                        Image(bitmap = qr.asImageBitmap(), contentDescription = "Your invite as a QR code", modifier = Modifier.padding(10.dp).size(230.dp))
                    } else {
                        Box(Modifier.size(250.dp), contentAlignment = Alignment.Center) { Text("Invite not ready", color = androidx.compose.ui.graphics.Color.Black) }
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
            val words = state.invite?.words
            if (words != null) {
                androidx.compose.foundation.layout.FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    words.split(' ').forEach { w ->
                        Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.primaryContainer) {
                            Text(w, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
                        }
                    }
                }
                Spacer(Modifier.height(4.dp))
                Text("The words work for 15 minutes while this app is open.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { clipboard.setText(AnnotatedString(words)); wordsCopied = true }) {
                        Icon(Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(if (wordsCopied) "Copied" else "Copy the words")
                    }
                    OutlinedButton(
                        onClick = {
                            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, words)
                            context.startActivity(Intent.createChooser(send, "Share the six words"))
                        },
                    ) {
                        Icon(Icons.Filled.Share, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Share")
                    }
                }
            } else {
                Text(
                    wordsError ?: "Making your six words…",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(onClick = { showFull = !showFull }) { Text(if (showFull) "Hide the full invite text" else "Full invite text (for pasting without the words)") }
            if (showFull) {
                Text(card, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(6.dp))
                OutlinedButton(onClick = { clipboard.setText(AnnotatedString(card)); copied = true }, enabled = card.isNotEmpty()) {
                    Icon(Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(if (copied) "Copied" else "Copy full text")
                }
            }

            Spacer(Modifier.height(28.dp))
            Text("Add a friend", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            Text(
                "Scan your friend's code, or type the six words they see.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = {
                    scanner.launch(
                        ScanOptions().apply {
                            setDesiredBarcodeFormats(listOf("QR_CODE"))
                            setPrompt("Scan your friend's invite code")
                            setBeepEnabled(false)
                            setOrientationLocked(false)
                        },
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.QrCodeScanner, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Scan a QR code")
            }
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = pasted,
                onValueChange = { pasted = it; error = null },
                label = { Text("Or type the six words (or paste a full invite)") },
                minLines = 2,
                maxLines = 4,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            Button(onClick = { add(pasted) }, enabled = pasted.isNotBlank() && !busy, modifier = Modifier.fillMaxWidth()) {
                Text(if (busy) "Looking…" else "Add friend")
            }
            error?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
fun SafetyNumberBox(number: String) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
        Text(
            number.ifEmpty { "Not available" },
            fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(16.dp),
        )
    }
}
