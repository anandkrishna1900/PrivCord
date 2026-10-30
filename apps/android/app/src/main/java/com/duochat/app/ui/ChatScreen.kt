package com.duochat.app.ui

import android.Manifest
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.DeleteForever
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.duochat.app.data.AppSettings
import com.duochat.app.data.ChatMessage
import com.duochat.app.data.ChatState
import com.duochat.app.data.ConnectionTone
import com.duochat.app.data.DeliveryState
import com.duochat.app.data.MAX_TEXT_LENGTH
import com.duochat.app.data.MessageMode
import com.duochat.app.data.P2PState
import com.duochat.app.data.PeerTrust
import com.duochat.app.data.countCodePoints
import com.duochat.app.data.presentConnection
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    signedIn: AuthUiState.SignedIn,
    state: ChatState,
    settings: AppSettings,
    onSignOut: () -> Unit,
    onSend: (String, (Result<Unit>) -> Unit) -> Unit,
    onRetry: (String) -> Unit,
    onLoadOlder: () -> Unit,
    onClearNotice: () -> Unit,
    onConfirmPeer: () -> Unit,
    onReconnect: () -> Unit,
    onCancelManual: () -> Unit,
    onChangeDisplayName: (String, (Result<Unit>) -> Unit) -> Unit,
    onClearLocalData: ((Result<Unit>) -> Unit) -> Unit,
    onUpdateSettings: (AppSettings.() -> AppSettings) -> Unit,
    onSetMessageMode: (MessageMode) -> Unit,
    onCreateManualOffer: ((Result<String>) -> Unit) -> Unit,
    onApplyManualAnswer: (String, (Result<Unit>) -> Unit) -> Unit,
    onAcceptManualOffer: ((String, (Result<String>) -> Unit) -> Unit),
    onRunNuke: () -> Unit = {},
    onRunChatSwitch: (Boolean, (Result<Boolean>) -> Unit) -> Unit = { _, _ -> },
    killSwitchReport: com.duochat.app.security.KillSwitchReport? = null,
    onAcknowledgeKillSwitch: () -> Unit = {},
) {
    var settingsOpen by remember { mutableStateOf(false) }
    var manualOpen by remember { mutableStateOf(false) }
    var nukeOpen by remember { mutableStateOf(false) }
    var clearChatOpen by remember { mutableStateOf(false) }

    val notificationPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) onUpdateSettings { copy(notificationsEnabled = true) }
    }

    val requestNotifications = {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            onUpdateSettings { copy(notificationsEnabled = true) }
        }
    }

    val peerName = state.peerProfile?.displayName ?: "Your friend"
    val peerLastSeen = state.peerProfile?.lastSeenAt
    val peerActive = state.p2pConnected ||
        (state.cloudConnected &&
            peerLastSeen != null &&
            System.currentTimeMillis() - peerLastSeen < 150_000)
    val subline = when {
        state.p2pConnected -> "Direct connection active"
        peerActive -> "Active now"
        else -> formatLastSeen(state.peerProfile?.lastSeenAt)
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        InitialsAvatar(peerName, 38, online = peerActive)
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text(
                                peerName,
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                subline,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                            )
                        }
                    }
                },
                actions = {
                    IconButton(onClick = onReconnect) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Reconnect")
                    }
                    IconButton(onClick = { manualOpen = true }) {
                        Icon(Icons.Filled.Key, contentDescription = "Manual connection")
                    }
                    IconButton(onClick = { settingsOpen = true }) {
                        Icon(Icons.Filled.Settings, contentDescription = "Settings")
                    }
                    IconButton(onClick = { clearChatOpen = true }) {
                        Icon(Icons.Filled.DeleteForever, contentDescription = "Clear Everything")
                    }
                },
            )
        },
        bottomBar = {
            val directMode = settings.messageMode == MessageMode.DIRECT
            Composer(
                enabled = state.phase == com.duochat.app.data.EnginePhase.READY,
                connected = if (directMode) {
                    state.p2pConnected
                } else {
                    state.cloudConnected || state.p2pConnected
                },
                queued = if (directMode) {
                    !state.p2pConnected
                } else {
                    !state.cloudConnected && !state.p2pConnected
                },
                directMode = directMode,
                modifier = Modifier.navigationBarsPadding().imePadding(),
                onSend = onSend,
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            ConnectionSummary(state, settings.messageMode)
            state.error?.let { message ->
                Banner(
                    icon = Icons.Filled.ErrorOutline,
                    text = message,
                    container = MaterialTheme.colorScheme.errorContainer,
                    content = MaterialTheme.colorScheme.onErrorContainer,
                    onDismiss = onClearNotice,
                )
            }
            state.notice?.let { message ->
                Banner(
                    icon = Icons.Filled.Link,
                    text = message,
                    container = MaterialTheme.colorScheme.primaryContainer,
                    content = MaterialTheme.colorScheme.onPrimaryContainer,
                    onDismiss = onClearNotice,
                )
            }
            if (state.p2pState == P2PState.CONNECTED && state.peerTrust == PeerTrust.UNVERIFIED) {
                Banner(
                    icon = Icons.Filled.Shield,
                    text = "A direct channel is open but its identity is not cloud-verified. " +
                        "Compare the safety number before sending.",
                    container = MaterialTheme.colorScheme.surfaceVariant,
                    content = MaterialTheme.colorScheme.onSurfaceVariant,
                    actionLabel = "Verify",
                    onAction = {
                        manualOpen = true
                    },
                )
            }
            MessageList(
                state = state,
                selfUid = state.uid,
                peerName = peerName,
                onLoadOlder = onLoadOlder,
                onRetry = onRetry,
                modifier = Modifier.weight(1f),
            )
        }
    }

    if (settingsOpen) {
        SettingsDialog(
            state = state,
            settings = settings,
            email = signedIn.email.orEmpty(),
            peerName = peerName,
            onDismiss = { settingsOpen = false },
            onRequestNotifications = requestNotifications,
            onUpdateSettings = onUpdateSettings,
            onSetMessageMode = onSetMessageMode,
            onChangeDisplayName = onChangeDisplayName,
            onClearLocalData = onClearLocalData,
            onReconnect = onReconnect,
            onOpenManual = {
                settingsOpen = false
                manualOpen = true
            },
            onOpenNuke = {
                settingsOpen = false
                nukeOpen = true
            },
            onSignOut = {
                settingsOpen = false
                onSignOut()
            },
        )
    }

    if (manualOpen) {
        ManualConnectDialog(
            state = state,
            onDismiss = {
                if (!state.p2pConnected) onCancelManual()
                manualOpen = false
            },
            onConfirmPeer = onConfirmPeer,
            onCreateOffer = onCreateManualOffer,
            onApplyAnswer = onApplyManualAnswer,
            onAcceptOffer = onAcceptManualOffer,
        )
    }

    if (nukeOpen) {
        NukeDialog(
            onDismiss = { nukeOpen = false },
            onRun = { onRunNuke() },
            report = killSwitchReport,
            onDone = {
                nukeOpen = false
                onAcknowledgeKillSwitch()
            },
        )
    }

    if (clearChatOpen) {
        ClearChatDialog(
            onDismiss = { clearChatOpen = false },
            onRun = { mode ->
                onRunChatSwitch(mode == DeleteChatMode.CLEAR_AND_SESSION) {
                    // completion handler
                }
            },
            report = killSwitchReport,
            onDone = {
                clearChatOpen = false
                onAcknowledgeKillSwitch()
            },
        )
    }
}

@Composable
private fun ConnectionSummary(state: ChatState, messageMode: MessageMode) {
    val presentation = presentConnection(state.connectionMode, state.queuedCount)
    val toneColor = if (messageMode == MessageMode.DIRECT) {
        if (state.p2pConnected) Color(0xFF0D9488) else Color(0xFFD97706)
    } else {
        when (presentation.tone) {
            ConnectionTone.ONLINE -> MaterialTheme.colorScheme.primary
            ConnectionTone.DIRECT -> Color(0xFF0D9488)
            ConnectionTone.BUSY -> Color(0xFFD97706)
            ConnectionTone.OFFLINE -> MaterialTheme.colorScheme.onSurfaceVariant
            ConnectionTone.ERROR -> MaterialTheme.colorScheme.error
        }
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(toneColor),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            if (messageMode == MessageMode.DIRECT) {
                if (state.p2pConnected) "Direct mode · connected" else "Direct mode · waiting"
            } else {
                "Cloud mode · ${presentation.label}"
            },
            style = MaterialTheme.typography.labelSmall,
            color = toneColor,
        )
        Spacer(Modifier.width(8.dp))
        Text(
            if (messageMode == MessageMode.DIRECT) {
                if (state.p2pConnected) {
                    "Messages use the direct channel only. No message text is uploaded to the cloud."
                } else {
                    "Messages stay on this device until a direct channel accepts them."
                }
            } else {
                presentation.detail
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun Banner(
    icon: ImageVector,
    text: String,
    container: Color,
    content: Color,
    onDismiss: (() -> Unit)? = null,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Surface(color = container, modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(icon, contentDescription = null, tint = content, modifier = Modifier.size(17.dp))
            Spacer(Modifier.width(9.dp))
            Text(
                text,
                style = MaterialTheme.typography.bodySmall,
                color = content,
                modifier = Modifier.weight(1f),
            )
            if (actionLabel != null && onAction != null) {
                TextButton(onClick = onAction) {
                    Text(actionLabel, color = content)
                }
            }
            if (onDismiss != null) {
                IconButton(onClick = onDismiss, modifier = Modifier.size(30.dp)) {
                    Icon(Icons.Filled.Close, contentDescription = "Dismiss", tint = content)
                }
            }
        }
    }
}

@Composable
private fun MessageList(
    state: ChatState,
    selfUid: String,
    peerName: String,
    onLoadOlder: () -> Unit,
    onRetry: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val messages = state.messages
    val listState = rememberLazyListState()
    val lastId = messages.lastOrNull()?.messageId
    LaunchedEffect(lastId) {
        if (messages.isNotEmpty()) {
            val target = messages.lastIndex + if (state.hasOlder) 1 else 0
            if (target >= 0) listState.animateScrollToItem(target)
        }
    }

    if (messages.isEmpty()) {
        Box(
            modifier = modifier.fillMaxWidth().padding(24.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Surface(
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.primaryContainer,
                ) {
                    Icon(
                        Icons.Filled.Shield,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(18.dp).size(30.dp),
                    )
                }
                Spacer(Modifier.height(14.dp))
                Text(
                    "Your private conversation starts here",
                    style = MaterialTheme.typography.titleMedium,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    if (state.messageMode == MessageMode.DIRECT) {
                        "Only the two approved accounts can read this thread. Messages are " +
                            "stored locally and sent only over an authenticated direct connection."
                    } else {
                        "Only the two approved accounts can read this thread. Messages are " +
                            "stored locally and synchronized through the cloud when it is available."
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
        }
        return
    }

    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        if (state.hasOlder) {
            item(key = "older") {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                    horizontalArrangement = Arrangement.Center,
                ) {
                    TextButton(onClick = onLoadOlder, enabled = !state.loadingOlder) {
                        if (state.loadingOlder) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(14.dp),
                                strokeWidth = 2.dp,
                            )
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(if (state.loadingOlder) "Loading…" else "Load earlier messages")
                    }
                }
            }
        }
        itemsIndexed(messages, key = { _, message -> message.messageId }) { index, message ->
            val day = formatDay(message.clientCreatedAt)
            val previous = messages.getOrNull(index - 1)
            val showDay = previous == null || formatDay(previous.clientCreatedAt) != day
            val grouped = previous != null &&
                !showDay &&
                previous.senderId == message.senderId &&
                message.clientCreatedAt - previous.clientCreatedAt < 4 * 60_000
            Column {
                if (showDay) {
                    DaySeparator(day)
                }
                MessageBubble(
                    message = message,
                    own = message.senderId == selfUid,
                    peerName = peerName,
                    showAvatar = !grouped,
                    grouped = grouped,
                    onRetry = onRetry,
                )
            }
        }
    }
}

@Composable
private fun DaySeparator(label: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.Center,
    ) {
        Surface(
            color = MaterialTheme.colorScheme.surfaceVariant,
            shape = RoundedCornerShape(20.dp),
        ) {
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageBubble(
    message: ChatMessage,
    own: Boolean,
    peerName: String,
    showAvatar: Boolean,
    grouped: Boolean,
    onRetry: (String) -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    var menuOpen by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (own) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        if (!own) {
            Box(Modifier.width(30.dp)) {
                if (showAvatar) InitialsAvatar(peerName, 26)
            }
        }
        Box {
            Surface(
                color = if (own) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.surfaceVariant
                },
                shape = RoundedCornerShape(
                    topStart = 18.dp,
                    topEnd = 18.dp,
                    bottomStart = if (own || grouped) 18.dp else 4.dp,
                    bottomEnd = if (!own || grouped) 18.dp else 4.dp,
                ),
                modifier = Modifier
                    .widthIn(max = 310.dp)
                    .combinedClickable(
                        onClick = {},
                        onLongClick = { menuOpen = true },
                    ),
            ) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Text(
                        text = message.text,
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (own) {
                            MaterialTheme.colorScheme.onPrimary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                    Spacer(Modifier.height(3.dp))
                    Row(
                        modifier = Modifier.align(Alignment.End),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            formatTime(message.clientCreatedAt),
                            style = MaterialTheme.typography.labelSmall,
                            color = if (own) {
                                MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.75f)
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f)
                            },
                        )
                        if (own) {
                            Spacer(Modifier.width(4.dp))
                            DeliveryIndicator(message.deliveryState) { onRetry(message.messageId) }
                        }
                    }
                }
            }
            DropdownMenu(
                expanded = menuOpen,
                onDismissRequest = { menuOpen = false },
            ) {
                DropdownMenuItem(
                    text = { Text("Copy message") },
                    leadingIcon = {
                        Icon(
                            Icons.Filled.ContentCopy,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                    },
                    onClick = {
                        clipboard.setText(AnnotatedString(message.text))
                        menuOpen = false
                        Toast.makeText(context, "Message copied", Toast.LENGTH_SHORT).show()
                    },
                )
            }
        }
    }
}

@Composable
private fun DeliveryIndicator(state: DeliveryState, onRetry: () -> Unit) {
    val color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.8f)
    when (state) {
        DeliveryState.FAILED -> Icon(
            Icons.Filled.ErrorOutline,
            contentDescription = "Delivery failed. Tap to retry.",
            tint = MaterialTheme.colorScheme.error,
            modifier = Modifier.size(15.dp).clickable(onClick = onRetry),
        )

        DeliveryState.QUEUED -> Icon(
            Icons.Filled.Schedule,
            contentDescription = "Queued locally",
            tint = color,
            modifier = Modifier.size(14.dp),
        )

        DeliveryState.SENT -> Icon(
            Icons.Filled.Check,
            contentDescription = "Accepted by transport",
            tint = color,
            modifier = Modifier.size(14.dp),
        )

        DeliveryState.DELIVERED -> Icon(
            Icons.Filled.DoneAll,
            contentDescription = "Delivered",
            tint = color,
            modifier = Modifier.size(15.dp),
        )

        DeliveryState.READ -> Icon(
            Icons.Filled.DoneAll,
            contentDescription = "Read",
            tint = MaterialTheme.colorScheme.onPrimary,
            modifier = Modifier.size(15.dp),
        )
    }
}

@Composable
private fun Composer(
    enabled: Boolean,
    connected: Boolean,
    queued: Boolean,
    directMode: Boolean,
    modifier: Modifier = Modifier,
    onSend: (String, (Result<Unit>) -> Unit) -> Unit,
) {
    var text by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }
    val length = countCodePoints(text)
    val overLimit = length > MAX_TEXT_LENGTH

    fun send() {
        if (!enabled || sending || text.trim().isEmpty() || overLimit) return
        val snapshot = text
        sending = true
        onSend(snapshot) { result ->
            sending = false
            result.onSuccess {
                text = ""
                error = null
            }.onFailure {
                error = it.message ?: "Message could not be queued."
            }
        }
    }

    Surface(
        modifier = modifier,
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 3.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            error?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(bottom = 6.dp),
                )
            }
            Row(verticalAlignment = Alignment.Bottom) {
                OutlinedTextField(
                    value = text,
                    onValueChange = {
                        if (countCodePoints(it) <= MAX_TEXT_LENGTH + 200) {
                            text = it
                            if (error != null) error = null
                        }
                    },
                    modifier = Modifier.weight(1f),
                    enabled = enabled,
                    placeholder = {
                        Text(
                            when {
                                connected -> "Write a message…"
                                directMode -> "Write a message — it stays local until a direct channel is ready…"
                                queued -> "Write a message — it will queue until a connection returns…"
                                else -> "Reconnecting…"
                            },
                        )
                    },
                    maxLines = 5,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { send() }),
                    shape = RoundedCornerShape(20.dp),
                )
                Spacer(Modifier.width(8.dp))
                IconButton(
                    onClick = { send() },
                    enabled = enabled && !sending && text.trim().isNotEmpty() && !overLimit,
                    modifier = Modifier
                        .size(48.dp)
                        .clip(CircleShape)
                        .background(
                            if (enabled && text.trim().isNotEmpty()) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.surfaceVariant
                            },
                        ),
                ) {
                    if (sending) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        Icon(
                            Icons.Filled.Send,
                            contentDescription = "Send message",
                            tint = if (enabled && text.trim().isNotEmpty()) {
                                MaterialTheme.colorScheme.onPrimary
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    }
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    if (directMode) {
                        "Direct mode · no cloud message upload"
                    } else {
                        "Messages stay on this device until transport accepts them"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (length > MAX_TEXT_LENGTH - 400) {
                    Text(
                        "$length / $MAX_TEXT_LENGTH",
                        style = MaterialTheme.typography.labelSmall,
                        color = if (overLimit) {
                            MaterialTheme.colorScheme.error
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                }
            }
        }
    }
}

@Composable
fun InitialsAvatar(name: String, size: Int, online: Boolean = false) {
    val hue = avatarHue(name.ifBlank { "duochat" })
    Box(contentAlignment = Alignment.BottomEnd) {
        Box(
            modifier = Modifier
                .size(size.dp)
                .clip(CircleShape)
                .background(Color.hsl(hue.toFloat(), 0.55f, 0.45f)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                initials(name),
                color = Color.White,
                fontSize = (size * 0.34f).sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
        if (online) {
            Box(
                Modifier
                    .size((size * 0.28f).dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary),
            )
        }
    }
}

fun formatTime(timestamp: Long): String =
    SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(timestamp))

fun formatDay(timestamp: Long): String {
    val zone = ZoneId.systemDefault()
    val date = Instant.ofEpochMilli(timestamp).atZone(zone).toLocalDate()
    val today = LocalDate.now(zone)
    return when (date) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> date.format(DateTimeFormatter.ofPattern("EEE, MMM d", Locale.getDefault()))
    }
}

fun formatLastSeen(timestamp: Long?): String {
    if (timestamp == null) return "Last seen unavailable"
    val delta = System.currentTimeMillis() - timestamp
    return when {
        delta < 90_000 -> "Active recently"
        delta < 3_600_000 -> "Last seen ${maxOf(1, (delta / 60_000).toInt())}m ago"
        delta < 86_400_000 -> "Last seen ${maxOf(1, (delta / 3_600_000).toInt())}h ago"
        else -> "Last seen " + SimpleDateFormat("MMM d", Locale.getDefault()).format(Date(timestamp))
    }
}

fun initials(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (parts.isEmpty()) return "?"
    if (parts.size == 1) return parts[0].take(2).uppercase(Locale.getDefault())
    return (
        parts.first().take(1) + parts.last().take(1)
        ).uppercase(Locale.getDefault())
}

fun avatarHue(seed: String): Int {
    var hash = 0
    for (char in seed) hash = (hash * 31 + char.code) % 360
    return hash
}
