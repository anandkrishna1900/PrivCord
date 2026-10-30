package com.duochat.app.ui

import android.content.Intent
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.duochat.app.AppConfig
import com.duochat.app.ble.BlePermissions
import com.duochat.app.data.ACCENTS
import com.duochat.app.data.BluetoothStatus
import com.duochat.app.data.AppSettings
import com.duochat.app.data.ChatState
import com.duochat.app.data.NetworkConfig
import com.duochat.app.data.SignalingConfig
import com.duochat.app.data.TurnServer
import com.duochat.app.data.PeerTrust
import com.duochat.app.data.presentConnection

@Composable
fun SettingsDialog(
    state: ChatState,
    settings: AppSettings,
    peerName: String,
    onDismiss: () -> Unit,
    onRequestNotifications: () -> Unit,
    onUpdateSettings: (AppSettings.() -> AppSettings) -> Unit,
    onResetPairing: () -> Unit,
    onClearLocalData: ((Result<Unit>) -> Unit) -> Unit,
    onOpenManual: () -> Unit,
    onOpenNuke: () -> Unit,
    onConnectBluetooth: ((Result<Unit>) -> Unit) -> Unit = {},
    onBluetoothPermissionResult: () -> Unit = {},
) {
    var nickname by remember { mutableStateOf(settings.peerNickname) }
    var nameStatus by remember { mutableStateOf<String?>(null) }
    var resetConfirm by remember { mutableStateOf(false) }
    var stunText by remember { mutableStateOf(settings.network.stun.joinToString("\n")) }
    val firstTurn = settings.network.turn.firstOrNull()
    var turnUrls by remember { mutableStateOf(firstTurn?.urls?.joinToString("\n").orEmpty()) }
    var turnUser by remember { mutableStateOf(firstTurn?.username.orEmpty()) }
    var turnSecret by remember { mutableStateOf(firstTurn?.credential.orEmpty()) }
    var networkStatus by remember { mutableStateOf<String?>(null) }
    var nostrText by remember {
        mutableStateOf(
            settings.network.signaling.filterIsInstance<SignalingConfig.Nostr>().flatMap { it.relays }.joinToString("\n"),
        )
    }
    var relayText by remember {
        mutableStateOf(settings.network.signaling.filterIsInstance<SignalingConfig.Relay>().joinToString("\n") { it.url })
    }
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

                SectionTitle("You & your friend")
                Text(
                    "There are no accounts. Your identity is a key that lives on this device; " +
                        "your friend is the device you paired with.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    InitialsAvatar(nickname.ifBlank { peerName }, 52)
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text(
                            nickname.ifBlank { "Your friend" },
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            (if (state.paired) "Paired" else "Not paired yet") + " · " +
                                (if (state.p2pConnected) "connected now" else "not connected"),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = nickname,
                    onValueChange = { nickname = it.take(40) },
                    label = { Text("Nickname for your friend") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = {
                        onUpdateSettings { copy(peerNickname = nickname.trim()) }
                        nameStatus = "Saved on this device."
                    },
                    enabled = nickname.trim() != settings.peerNickname,
                ) {
                    Text("Save nickname")
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
                DetailRow("Your ID", state.uid, monospace = true)
                DetailRow("Friend's ID", state.peerUid ?: "—", monospace = true)
                if (state.paired) {
                    Spacer(Modifier.height(8.dp))
                    if (resetConfirm) {
                        Text(
                            "Forgets your friend's key so a different device can be paired. " +
                                "Messages are kept.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(6.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                onClick = {
                                    onResetPairing()
                                    resetConfirm = false
                                },
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = MaterialTheme.colorScheme.error,
                                ),
                            ) {
                                Text("Yes, reset pairing")
                            }
                            TextButton(onClick = { resetConfirm = false }) { Text("Cancel") }
                        }
                    } else {
                        OutlinedButton(onClick = { resetConfirm = true }) {
                            Text("Reset pairing")
                        }
                    }
                }

                Spacer(Modifier.height(14.dp))
                BluetoothBlock(
                    status = state.bluetooth,
                    onConnect = onConnectBluetooth,
                    onPermissionResult = onBluetoothPermissionResult,
                )

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
                    "With no server there is no push service: you are notified only while the " +
                        "app is open and a direct connection is active.",
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
                DetailRow(
                    "Direct channel",
                    when {
                        state.p2pConnected -> "Connected"
                        state.p2pState == com.duochat.app.data.P2PState.CONNECTING -> "Negotiating"
                        state.p2pState == com.duochat.app.data.P2PState.FAILED -> "Failed"
                        else -> "Idle"
                    },
                )
                // Read from the selected ICE candidate pair, never inferred from settings.
                DetailRow(
                    "Route",
                    when {
                        state.connectionPath != null -> state.connectionPath.label
                        state.p2pConnected -> "Checking…"
                        else -> "—"
                    },
                )
                state.connectionPath?.let {
                    Text(
                        it.detail,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                DetailRow(
                    "Peer identity",
                    if (state.peerTrust == PeerTrust.NONE) "none" else state.peerTrust.name.lowercase(),
                )
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
                                    "trusting a new device.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                OutlinedButton(onClick = onOpenManual) {
                    Text(if (state.paired) "Reconnect with a code" else "Pair with a code")
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    "There is no server to introduce your devices. One of you creates a code, " +
                        "the other pastes it and sends back a reply code. Once connected, " +
                        "messages go straight between your devices.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(18.dp))
                HorizontalDivider()
                Spacer(Modifier.height(14.dp))

                SectionTitle("Communication Mode")
                Text("Select how DuoChat connects to peers:", style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ChoiceChip("1. Auto", settings.network.transportMode == com.duochat.app.data.TransportMode.AUTOMATIC) {
                        onUpdateSettings { copy(network = network.copy(transportMode = com.duochat.app.data.TransportMode.AUTOMATIC)) }
                    }
                    ChoiceChip("2. BLE Only", settings.network.transportMode == com.duochat.app.data.TransportMode.BLUETOOTH_ONLY) {
                        onUpdateSettings { copy(network = network.copy(transportMode = com.duochat.app.data.TransportMode.BLUETOOTH_ONLY)) }
                    }
                    ChoiceChip("3. Internet Only", settings.network.transportMode == com.duochat.app.data.TransportMode.INTERNET_ONLY) {
                        onUpdateSettings { copy(network = network.copy(transportMode = com.duochat.app.data.TransportMode.INTERNET_ONLY)) }
                    }
                }
                Spacer(Modifier.height(8.dp))
                SectionTitle("Network")
                Text(
                    "STUN only tells your device its public address; no messages pass through " +
                        "it. TURN relays your already end-to-end encrypted connection when no " +
                        "direct path exists (strict NAT or firewalls). Both are optional. " +
                        "Changes apply to the next connection.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = nostrText,
                    onValueChange = { nostrText = it },
                    label = { Text("Signaling: Nostr relays (finds your friend; one per line)") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = relayText,
                    onValueChange = { relayText = it },
                    label = { Text("Signaling: your own DuoChat relay (one per line)") },
                    minLines = 1,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "Signaling status: ${state.signaling.name.lowercase()}. Leave both empty to use connection codes only. " +
                        "Use wss:// addresses (Android blocks plain ws://). Signaling only carries sealed, signed " +
                        "connection setup, never messages.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = stunText,
                    onValueChange = { stunText = it },
                    label = { Text("STUN servers (one per line, stun:host:port)") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = turnUrls,
                    onValueChange = { turnUrls = it },
                    label = { Text("TURN URLs (turn:host:port or turns:…)") },
                    minLines = 1,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = turnUser,
                    onValueChange = { turnUser = it },
                    label = { Text("TURN username") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = turnSecret,
                    onValueChange = { turnSecret = it },
                    label = { Text("TURN credential") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                ToggleRow(
                    "Always use the relay",
                    "Only use TURN. Hides your IP address from your friend; needs a TURN server.",
                    settings.network.forceRelay,
                ) { onUpdateSettings { copy(network = network.copy(forceRelay = it)) } }
                ToggleRow(
                    "Store-and-forward (messages while your friend is offline)",
                    "Sends each message, encrypted for your friend, to the relays above so it arrives when they come " +
                        "online. Off by default. These messages have no forward secrecy.",
                    settings.network.storeForward,
                ) { onUpdateSettings { copy(network = network.copy(storeForward = it)) } }
                ToggleRow(
                    "Bluetooth (works with no internet)",
                    "Also look for your friend over Bluetooth LE when you are close by. Experimental: wired and unit-tested, never run on real radios.",
                    settings.network.bluetooth,
                ) { onUpdateSettings { copy(network = network.copy(bluetooth = it)) } }
                Spacer(Modifier.height(4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = {
                            val urls = NetworkConfig.parseTurnUrls(turnUrls)
                            val hasTurnInput = turnUrls.isNotBlank() || turnUser.isNotBlank() || turnSecret.isNotBlank()
                            val nostrLines = nostrText.split('\n', ',', ' ').map { it.trim() }.filter { it.isNotEmpty() }
                            val relayLines = relayText.split('\n', ',', ' ').map { it.trim() }.filter { it.isNotEmpty() }
                            val badWs = (nostrLines + relayLines).firstOrNull { !NetworkConfig.isWsUrl(it) }
                            if (badWs != null) {
                                networkStatus = "Not a ws:// or wss:// address: $badWs"
                            } else if (hasTurnInput && (urls.isEmpty() || turnUser.isBlank() || turnSecret.isBlank())) {
                                networkStatus = "TURN needs at least one turn:/turns: URL, a username and a credential."
                            } else {
                                val turn = if (urls.isEmpty()) {
                                    emptyList()
                                } else {
                                    listOf(TurnServer(urls, turnUser.trim(), turnSecret))
                                }
                                onUpdateSettings {
                                    copy(
                                        network = network.copy(
                                            stun = NetworkConfig.parseStunList(stunText),
                                            turn = turn,
                                            signaling = buildList {
                                                if (nostrLines.isNotEmpty()) add(SignalingConfig.Nostr(nostrLines))
                                                relayLines.forEach { add(SignalingConfig.Relay(it)) }
                                            },
                                        ),
                                    )
                                }
                                networkStatus = "Saved. Applies to the next connection."
                            }
                        },
                    ) {
                        Text("Save network settings")
                    }
                    TextButton(
                        onClick = {
                            val defaults = AppConfig.defaultNetworkConfig()
                            onUpdateSettings { copy(network = defaults) }
                            stunText = defaults.stun.joinToString("\n")
                            nostrText = defaults.signaling.filterIsInstance<SignalingConfig.Nostr>().flatMap { it.relays }.joinToString("\n")
                            relayText = ""
                            turnUrls = defaults.turn.firstOrNull()?.urls?.joinToString("\n").orEmpty()
                            turnUser = defaults.turn.firstOrNull()?.username.orEmpty()
                            turnSecret = defaults.turn.firstOrNull()?.credential.orEmpty()
                            networkStatus = "Defaults restored."
                        },
                    ) {
                        Text("Defaults")
                    }
                }
                networkStatus?.let {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    "The default STUN servers are public Google and Cloudflare servers " +
                        "(third parties). Clear the list to disable STUN; then only " +
                        "same-network connections work.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

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
                            "the Android Keystore. Messages never leave your two devices: they " +
                            "travel over an encrypted direct connection, and no server can read " +
                            "or keep them.",
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

                SectionTitle("Security")
                Text(
                    "Emergency deletion for this device. Deletion never touches the other " +
                        "person's device, screenshots, exports, or external backups.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(10.dp))
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.6f),
                    shape = RoundedCornerShape(16.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(Modifier.padding(14.dp)) {
                        Text(
                            "Emergency Actions",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            "Permanently deletes this device's conversations, contacts, keys, " +
                                "session state, and settings, then starts over with a new identity. " +
                                "Requires two deliberate confirmation steps.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(vertical = 6.dp),
                        )
                        Button(
                            onClick = {
                                onDismiss()
                                onOpenNuke()
                            },
                            colors = ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.error,
                            ),
                        ) {
                            Text("NUKE DUOCHAT")
                        }
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "Per-conversation deletion lives in the chat menu → Security → " +
                                "Clear Everything.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
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
                DetailRow("Created by", "anandkrishna1900")
                DetailRow("License", "PC-NC (non-commercial)")
                DetailRow("Conversation", state.conversationId, monospace = true)
                Spacer(Modifier.height(12.dp))
                Text(
                    "Peer connections use a challenge-response identity proof and a safety " +
                        "number you compare with your friend. No accounts and no analytics.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
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

/**
 * Bluetooth LE status and controls. Permissions are requested only from the button here, after an explanation,
 * and a denial is handled with a pointer to the system settings. UNTESTED on a real radio.
 */
@Composable
private fun BluetoothBlock(
    status: BluetoothStatus,
    onConnect: ((Result<Unit>) -> Unit) -> Unit,
    onPermissionResult: () -> Unit,
) {
    val context = LocalContext.current
    var rationale by remember { mutableStateOf(false) }
    var denied by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        denied = !result.values.all { it }
        onPermissionResult()
    }

    DetailRow(
        "Bluetooth",
        when (status) {
            BluetoothStatus.DISABLED -> "Off in network settings"
            BluetoothStatus.UNSUPPORTED -> "Not available on this phone"
            BluetoothStatus.NEEDS_PERMISSION -> "Permission needed"
            BluetoothStatus.ADAPTER_OFF -> "Turned off"
            BluetoothStatus.NOT_PAIRED -> "Add your friend first"
            BluetoothStatus.READY -> "Ready"
            BluetoothStatus.SEARCHING -> "Searching nearby…"
            BluetoothStatus.CONNECTED -> "Connected"
        },
    )
    Text(
        when (status) {
            BluetoothStatus.NEEDS_PERMISSION ->
                "DuoChat can find your paired friend over Bluetooth when you are close by, with no internet. " +
                    "It needs the nearby-devices permission for that."
            BluetoothStatus.ADAPTER_OFF -> "Turn Bluetooth on in the quick settings panel, then come back."
            BluetoothStatus.CONNECTED -> "Traffic is encrypted on top of Bluetooth and never touches a server."
            else -> "Works with the internet off, but only within radio range. Experimental: never run on real radios yet."
        },
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (status == BluetoothStatus.NEEDS_PERMISSION) {
            Button(onClick = { rationale = true }) { Text("Allow Bluetooth") }
            if (denied) {
                OutlinedButton(
                    onClick = {
                        context.startActivity(
                            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    },
                ) { Text("Open app settings") }
            }
        } else if (status == BluetoothStatus.READY) {
            OutlinedButton(onClick = { onConnect { result -> message = result.exceptionOrNull()?.message } }) {
                Text("Connect over Bluetooth")
            }
        }
    }
    if (denied && status == BluetoothStatus.NEEDS_PERMISSION) {
        Spacer(Modifier.height(4.dp))
        Text(
            "Permission was denied. You can allow it under Android Settings > Apps > DuoChat > Permissions.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
        )
    }
    message?.let {
        Spacer(Modifier.height(4.dp))
        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
    }
    if (rationale) {
        AlertDialog(
            onDismissRequest = { rationale = false },
            title = { Text("Allow nearby devices?") },
            text = {
                Text(
                    "Bluetooth lets DuoChat find and talk to your paired friend with no internet. DuoChat only " +
                        "connects to the one device you paired with. It never uses Bluetooth to learn your location.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        rationale = false
                        launcher.launch(BlePermissions.required())
                    },
                ) { Text("Continue") }
            },
            dismissButton = { TextButton(onClick = { rationale = false }) { Text("Not now") } },
        )
    }
}
