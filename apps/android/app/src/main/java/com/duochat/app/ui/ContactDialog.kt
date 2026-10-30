package com.duochat.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.duochat.app.data.ChatState

/**
 * Meet a friend: swap public contact cards over any channel, compare the safety number once, and the app
 * reconnects to them automatically from then on. Same flow as the desktop ContactDialog.
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
    var pasted by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf(false) }
    val card = remember { runCatching(ownCard).getOrDefault("") }

    Dialog(onDismissRequest = { onCancel(); onDismiss() }) {
        Surface(shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.padding(20.dp).verticalScroll(rememberScrollState())) {
                Text("Add your friend", style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(12.dp))
                when {
                    pending != null -> {
                        Text("Compare the safety number", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "Read these numbers to your friend over a separate channel (a call, in person). " +
                                "Confirm only if they match exactly on both phones.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(10.dp))
                        Text(pending.safetyNumber, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(14.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { onConfirm(); onDismiss() }) { Text("Numbers match, save friend") }
                            OutlinedButton(onClick = onCancel) { Text("They don't match") }
                        }
                    }

                    state.paired -> {
                        Text(
                            "You are paired. DuoChat reconnects to your friend automatically whenever you are both online. " +
                                "To pair with someone else, use Reset pairing in Settings.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(14.dp))
                        Button(onClick = onDismiss) { Text("Done") }
                    }

                    else -> {
                        Text("1. Send your contact card", style = MaterialTheme.typography.titleMedium)
                        Text(
                            "It is public: it only lets your friend verify and message you. Share it any way you like.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(6.dp))
                        OutlinedTextField(card, {}, readOnly = true, minLines = 3, modifier = Modifier.fillMaxWidth())
                        OutlinedButton(onClick = {
                            (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                                .setPrimaryClip(ClipData.newPlainText("DuoChat contact card", card))
                            copied = true
                        }) { Text(if (copied) "Copied" else "Copy my card") }
                        Spacer(Modifier.height(14.dp))
                        Text("2. Paste your friend's card", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(6.dp))
                        OutlinedTextField(
                            pasted,
                            { pasted = it; error = null },
                            label = { Text("DUOID1:…") },
                            minLines = 3,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                        Spacer(Modifier.height(8.dp))
                        Button(
                            enabled = pasted.isNotBlank(),
                            onClick = { error = onPreview(pasted).exceptionOrNull()?.message },
                        ) { Text("Continue") }
                    }
                }
            }
        }
    }
}
