package com.duochat.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.duochat.app.data.ChannelView

private val SUGGESTIONS = listOf("general", "random", "help", "news", "music", "tech")

/** Join a public channel by name, or leave one. Typing a name nobody used before creates it. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChannelsDialog(
    channels: List<ChannelView>,
    onJoin: (String, (Result<String>) -> Unit) -> Unit,
    onLeave: (String) -> Unit,
    onOpen: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun join(raw: String) {
        if (busy) return
        busy = true
        error = null
        onJoin(raw) { r ->
            busy = false
            r.onSuccess { id -> onDismiss(); onOpen(id) }.onFailure { error = it.message ?: "Could not join this channel." }
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Public channels") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    "A channel is an open room. Anyone who types the same name joins the same room, and anyone who knows the name can read it. Messages show your name and a short ID. For a private room use a private chat or a group.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = name, onValueChange = { name = it.take(40); error = null },
                    label = { Text("Channel name") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    SUGGESTIONS.forEach { s -> AssistChip(onClick = { join(s) }, label = { Text("#$s") }) }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp)) }
                if (channels.isNotEmpty()) {
                    Spacer(Modifier.height(14.dp))
                    Text("Your channels", style = MaterialTheme.typography.titleSmall)
                    channels.forEach { c ->
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            TextButton(onClick = { onDismiss(); onOpen(c.id) }, modifier = Modifier.weight(1f)) { Text("#${c.name}") }
                            TextButton(onClick = { onLeave(c.id) }) { Text("Leave", color = MaterialTheme.colorScheme.error) }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { join(name) }, enabled = name.isNotBlank() && !busy) { Text("Join channel") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}
