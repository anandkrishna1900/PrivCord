package com.duochat.app.ui

import android.graphics.Color as AndroidColor
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Refresh
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
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.duochat.app.AppConfig
import com.duochat.app.data.ACCENTS
import com.duochat.app.data.AppSettings
import com.duochat.app.data.ChatState
import com.duochat.app.data.PeerTrust
import com.duochat.app.data.presentConnection

@Composable
fun SettingsDialog(
    state: ChatState,
    settings: AppSettings,
    email: String,
    peerName: String,
    onDismiss: () -> Unit,
    onRequestNotifications: () -> Unit,
    onUpdateSettings: (AppSettings.() -> AppSettings) -> Unit,
    onChangeDisplayName: (String, (Result<Unit>) -> Unit) -> Unit,
    onClearLocalData: ((Result<Unit>) -> Unit) -> Unit,
    onReconnect: () -> Unit,
    onOpenManual: () -> Unit,
    onSignOut: () -> Unit,
) {
    var name by remember { mutableStateOf(state.selfProfile?.displayName.orEmpty()) }
    var nameStatus by remember { mutableStateOf<String?>(null) }
    var savingName by remember { mutableStateOf(false) }
    var clearConfirm by remember { mutableStateOf(false) }
    var clearStatus by remember { mutableStateOf<String?>(null) }
    var clearing by remember { mutableStateOf(false) }

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
                        "Settings",
                        style = MaterialTheme.typography.headlineSmall,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Filled.Close, contentDescription = "Close settings")
                    }
                }
                Text(
                    "Settings apply to this device.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(16.dp))

                SectionTitle("Profile")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    InitialsAvatar(name.ifBlank { peerName }, 52)
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text(
                            name.ifBlank { "Your name" },
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            email,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(40) },
                    label = { Text("Display name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = {
                        savingName = true
                        nameStatus = null
                        onChangeDisplayName(name) { result ->
                            savingName = false
                            nameStatus = result.fold(
                                onSuccess = { "Display name saved." },
                                onFailure = { it.message ?: "Could not save the name." },
                            )
                        }
                    },
                    enabled = !savingName && name.trim().isNotEmpty(),
                ) {
                    if (savingName) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(15.dp),
                            strokeWidth = 2.dp,
                        )
                        Spacer(Modifier.width(8.dp))
                    }
                    Text("Save display name")
                }
                nameStatus?.let {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(10.dp))
                DetailRow("Your user ID", state.uid, monospace = true)
                DetailRow("Conversation", state.conversationId, monospace = true)

                Spacer(Modifier.height(18.dp))
                HorizontalDivider()
                Spacer(Modifier.height(14.dp))

                SectionTitle("Appearance")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ChoiceChip("System", settings.theme == "system") {
                        onUpdateSettings { copy(theme = "system") }
                    }
                    ChoiceChip("Dark", settings.theme == "dark") {
                        onUpdateSettings { copy(theme = "dark") }
                    }
                    ChoiceChip("Light", settings.theme == "light") {
                        onUpdateSettings { copy(theme = "light") }
                    }
                }
                Spacer(Modifier.height(12.dp))
                Text(
                    "Accent color",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    for ((label, value) in ACCENTS) {
                        Box(
                            modifier = Modifier
                                .size(36.dp)
                                .clip(CircleShape)
                                .background(parseColor(value))
                                .border(
                                    width = if (settings.accent == value) 3.dp else 1.dp,
                                    color = if (settings.accent == value) {
                                        MaterialTheme.colorScheme.onSurface
                                    } else {
                                        MaterialTheme.colorScheme.outline
                                    },
                                    shape = CircleShape,
                                )
                                .clickable { onUpdateSettings { copy(accent = value) } },
                            contentAlignment = Alignment.Center,
                        ) {
                            if (settings.accent == value) {
                                Icon(
                                    Icons.Filled.Check,
                                    contentDescription = label,
                                    tint = Color.White,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(18.dp))
                HorizontalDivider()
                Spacer(Modifier.height(14.dp))

                SectionTitle("Notifications")
                ToggleRow(
                    "Message notifications",
                    "Show a system notification for new messages.",
                    settings.notificationsEnabled,
                ) { onUpdateSettings { copy(notificationsEnabled = it) } }
                ToggleRow(
                    "Message previews",
                    "Include message text in notifications. Turn off for privacy.",
                    settings.notificationPreviews,
                    enabled = settings.notificationsEnabled,
                ) { onUpdateSettings { copy(notificationPreviews = it) } }
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = onRequestNotifications) {
                    Icon(
                        Icons.Filled.Notifications,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text("Request notification permission")
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    "Push notifications are best-effort. They cannot be guaranteed during a " +
                        "complete cloud outage, and direct messaging does not depend on them " +
                        "while both apps are open.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(18.dp))
                HorizontalDivider()
                Spacer(Modifier.height(14.dp))

                val presentation = presentConnection(state.connectionMode, state.queuedCount)
                SectionTitle("Connection")
                Text(
                    presentation.detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                DetailRow("Cloud sync", if (state.cloudConnected) "Connected" else "Unavailable")
                DetailRow(
                    "Direct channel",
                    when {
                        state.p2pConnected -> "Connected"
                        state.p2pState == com.duochat.app.data.P2PState.CONNECTING -> "Negotiating"
                        state.p2pState == com.duochat.app.data.P2PState.FAILED -> "Failed"
                        else -> "Idle"
                    },
                )
                DetailRow(
                    "Peer identity",
                    if (state.peerTrust == PeerTrust.NONE) "none" else state.peerTrust.name.lowercase(),
                )
                DetailRow("Peer key source", state.peerKeySource?.name?.lowercase() ?: "—")
                DetailRow("Queued messages", state.queuedCount.toString())
                DetailRow("Local storage", "Room (encrypted payloads)")
                state.safetyNumber?.let { number ->
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
                                number,
                                fontFamily = FontFamily.Monospace,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Spacer(Modifier.height(4.dp))
                            Text(
                                "Compare this with your friend over a separate channel before " +
                                    "trusting a direct connection that is not cloud-verified.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onReconnect) {
                        Icon(
                            Icons.Filled.Refresh,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text("Reconnect now")
                    }
                    OutlinedButton(onClick = onOpenManual) {
                        Text("Manual connection")
                    }
                }

                Spacer(Modifier.height(18.dp))
                HorizontalDivider()
                Spacer(Modifier.height(14.dp))

                SectionTitle("Privacy & local data")
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        "Local message text is encrypted at rest with AES-GCM using a key in " +
                            "the Android Keystore. Cloud messages are protected by TLS and " +
                            "Firestore rules, but they are not end-to-end encrypted. DuoChat " +
                            "does not claim E2EE.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(12.dp),
                    )
                }
                Spacer(Modifier.height(10.dp))
                if (clearConfirm) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = {
                                clearing = true
                                onClearLocalData { result ->
                                    clearing = false
                                    clearConfirm = false
                                    clearStatus = result.fold(
                                        onSuccess = { "Local data cleared." },
                                        onFailure = { it.message ?: "Could not clear local data." },
                                    )
                                }
                            },
                            enabled = !clearing,
                        ) {
                            if (clearing) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(15.dp),
                                    strokeWidth = 2.dp,
                                )
                                Spacer(Modifier.width(8.dp))
                            }
                            Text("Yes, clear local data")
                        }
                        TextButton(onClick = { clearConfirm = false }) {
                            Text("Cancel")
                        }
                    }
                } else {
                    OutlinedButton(onClick = { clearConfirm = true }) {
                        Text("Clear local cache")
                    }
                }
                clearStatus?.let {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                Spacer(Modifier.height(18.dp))
                HorizontalDivider()
                Spacer(Modifier.height(14.dp))

                SectionTitle("About DuoChat")
                Text(
                    "Private messaging for exactly two people.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(6.dp))
                DetailRow("Version", AppConfig.APP_VERSION)
                DetailRow("Platform", "Android · Kotlin/Compose")
                DetailRow("Conversation", state.conversationId, monospace = true)
                DetailRow("Firebase project", AppConfig.firebaseProjectId.ifBlank { "—" }, monospace = true)
                Spacer(Modifier.height(12.dp))
                Text(
                    "Cloud access is enforced by Firestore rules and a two-member allowlist. " +
                        "Peer connections use challenge-response identity proof plus manual " +
                        "safety-number verification when signaling is offline.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = onSignOut) {
                    Icon(
                        Icons.Filled.Logout,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text("Sign out")
                }
                Spacer(Modifier.height(10.dp))
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.padding(bottom = 8.dp),
    )
}

@Composable
private fun DetailRow(label: String, value: String, monospace: Boolean = false) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(130.dp),
        )
        Text(
            value,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = if (monospace) FontFamily.Monospace else null,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun ToggleRow(
    title: String,
    description: String,
    checked: Boolean,
    enabled: Boolean = true,
    onChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium)
            Text(
                description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            enabled = enabled,
        )
    }
}

@Composable
private fun ChoiceChip(label: String, selected: Boolean, onClick: () -> Unit) {
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

private fun parseColor(value: String): Color = try {
    Color(AndroidColor.parseColor(value))
} catch (_: Exception) {
    Color(0xFF6366F1)
}
