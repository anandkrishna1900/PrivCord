package com.duochat.app.ui

import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.consumeWindowInsets
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
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.heightIn
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
    var tab by rememberSaveable { mutableStateOf(0) }
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

    val scan = rememberQrScanner("Scan your friend's invite code") { add(it) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                title = { Text("Add a friend", style = MaterialTheme.typography.titleLarge) },
            )
        },
    ) { padding ->
        val added = addedUid?.let { uid -> state.contacts.firstOrNull { it.uid == uid } }
        // The keyboard shrinks the scroll area (instead of covering the word field at the bottom).
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 8.dp)) {
            if (added != null) {
                Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = RoundedCornerShape(28.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        InitialsAvatar(added.name, 64, online = added.link == com.duochat.app.data.LinkStatus.CONNECTED)
                        Spacer(Modifier.height(8.dp))
                        Spacer(Modifier.height(4.dp))
                        Text("${added.name} is in your chats", style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
                        Text(
                            "You will connect automatically whenever you are both online.",
                            style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(12.dp))
                        Button(onClick = { onOpenChat(added.uid) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Say hello") }
                    }
                }
                // Typed their words: say plainly whether our own invite reached them. They confirm us on their side.
                state.answer?.takeIf { it.uid == added.uid }?.let { answer ->
                    Spacer(Modifier.height(12.dp))
                    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
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

            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                listOf("My invite", "Their invite").forEachIndexed { i, label ->
                    SegmentedButton(
                        selected = tab == i, onClick = { tab = i },
                        shape = SegmentedButtonDefaults.itemShape(index = i, count = 2),
                        colors = SegmentedButtonDefaults.colors(
                            activeContainerColor = MaterialTheme.colorScheme.onBackground,
                            activeContentColor = MaterialTheme.colorScheme.background,
                            inactiveContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                            activeBorderColor = MaterialTheme.colorScheme.onBackground,
                            inactiveBorderColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        ),
                        icon = {},
                    ) { Text(label) }
                }
            }
            Spacer(Modifier.height(20.dp))

            if (tab == 0) {
                // The invite as a ticket: the code to scan on top, the six words to read out below, both on one card.
                Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Surface(shape = RoundedCornerShape(20.dp), color = androidx.compose.ui.graphics.Color.White) {
                            if (qr != null) {
                                Image(bitmap = qr.asImageBitmap(), contentDescription = "Your invite as a QR code", modifier = Modifier.padding(12.dp).size(208.dp))
                            } else {
                                Box(Modifier.size(232.dp), contentAlignment = Alignment.Center) { Text("Invite not ready", color = androidx.compose.ui.graphics.Color.Black) }
                            }
                        }
                        Spacer(Modifier.height(20.dp))
                        // Perforation between the two halves of the ticket.
                        androidx.compose.material3.HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        Spacer(Modifier.height(16.dp))
                        val words = state.invite?.words
                        if (words != null) {
                            Text("Or read out these six words", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.height(12.dp))
                            // Three per row on a normal phone; two when the text is large or the screen narrow, so a word
                            // is never cut off (people read these out loud).
                            androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth()) {
                                val perRow = if (maxWidth / androidx.compose.ui.platform.LocalDensity.current.fontScale < 300.dp) 2 else 3
                                Column {
                                    words.split(' ').chunked(perRow).forEachIndexed { row, group ->
                                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 8.dp)) {
                                            group.forEachIndexed { col, w ->
                                                Row(
                                                    Modifier.weight(1f).background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(12.dp))
                                                        .padding(horizontal = 10.dp, vertical = 10.dp),
                                                    verticalAlignment = Alignment.CenterVertically,
                                                ) {
                                                    Text("${row * perRow + col + 1}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                                    Spacer(Modifier.width(6.dp))
                                                    Text(w, style = MaterialTheme.typography.titleSmall)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Filled.Schedule, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    "Valid for 15 minutes while this app is open",
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Spacer(Modifier.height(16.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                                androidx.compose.material3.FilledTonalButton(
                                    onClick = { clipboard.setText(AnnotatedString(words)); wordsCopied = true },
                                    modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                                    colors = androidx.compose.material3.ButtonDefaults.filledTonalButtonColors(
                                        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                                        contentColor = MaterialTheme.colorScheme.onSurface,
                                    ),
                                ) {
                                    Icon(Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                                    Spacer(Modifier.width(8.dp))
                                    Text(if (wordsCopied) "Copied" else "Copy")
                                }
                                Button(
                                    onClick = {
                                        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, words)
                                        context.startActivity(Intent.createChooser(send, "Share the six words"))
                                    },
                                    modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                                ) {
                                    Icon(Icons.Filled.Share, contentDescription = null, modifier = Modifier.size(16.dp))
                                    Spacer(Modifier.width(8.dp))
                                    Text("Share")
                                }
                            }
                        } else {
                            Text(
                                wordsError ?: "Making your six words…",
                                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                textAlign = TextAlign.Center,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                Text(
                    "Your invite holds only your public identity. It is safe to send in any app.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                )
                TextButton(onClick = { showFull = !showFull }, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                    Text(if (showFull) "Hide the full invite text" else "Show the full invite text", color = MaterialTheme.colorScheme.onSurface)
                }
                if (showFull) {
                    Text(card, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(6.dp))
                    OutlinedButton(onClick = { clipboard.setText(AnnotatedString(card)); copied = true }, enabled = card.isNotEmpty()) {
                        Icon(Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(if (copied) "Copied" else "Copy full text")
                    }
                }
            } else {
                Surface(
                    onClick = scan,
                    shape = RoundedCornerShape(28.dp),
                    color = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier.size(56.dp).background(MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.16f), RoundedCornerShape(18.dp)),
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.Filled.QrCodeScanner, contentDescription = null, modifier = Modifier.size(28.dp)) }
                        Spacer(Modifier.width(16.dp))
                        Column(Modifier.weight(1f)) {
                            Text("Scan their code", style = MaterialTheme.typography.titleMedium)
                            Text(
                                "Point your camera at the code on their screen",
                                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.8f),
                            )
                        }
                    }
                }
                Spacer(Modifier.height(24.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    androidx.compose.material3.HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
                    Text("or type their words", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 12.dp))
                    androidx.compose.material3.HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
                }
                Spacer(Modifier.height(16.dp))
                androidx.compose.material3.TextField(
                    value = pasted,
                    onValueChange = { pasted = it; error = null },
                    placeholder = { Text("six words, or a full invite") },
                    minLines = 3,
                    maxLines = 5,
                    shape = RoundedCornerShape(20.dp),
                    colors = androidx.compose.material3.TextFieldDefaults.colors(
                        focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                        unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                    ),
                    textStyle = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = { add(pasted) }, enabled = pasted.isNotBlank() && !busy,
                    shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                ) { Text(if (busy) "Looking…" else "Add friend") }
            }
        }
    }
}

@Composable
fun SafetyNumberBox(number: String) {
    Surface(color = MaterialTheme.colorScheme.tertiaryContainer, contentColor = MaterialTheme.colorScheme.onTertiaryContainer, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
        Text(
            number.ifEmpty { "Not available" },
            fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(16.dp),
        )
    }
}
