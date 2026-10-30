package com.duochat.app.ui

import android.widget.Toast
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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.AlertDialog
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
import com.duochat.app.data.ChatMessage
import com.duochat.app.data.ChatState
import com.duochat.app.data.ContactTrust
import com.duochat.app.data.ContactView
import com.duochat.app.data.DeliveryState
import com.duochat.app.data.EnginePhase
import com.duochat.app.data.GroupView
import com.duochat.app.data.LinkStatus
import com.duochat.app.data.MAX_TEXT_LENGTH
import com.duochat.app.data.countCodePoints
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.Locale

/**
 * One conversation: a friend or a group. The header shows the name, one status line and a single overflow menu.
 * Dangerous actions (erase everything) are not here; they live in Settings > Security.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    state: ChatState,
    conversationId: String,
    muted: Boolean,
    onBack: () -> Unit,
    onSend: (String, (Result<Unit>) -> Unit) -> Unit,
    onRetry: (String) -> Unit,
    onClearNotice: () -> Unit,
    onOpenDetails: () -> Unit,
    onVerify: () -> Unit,
    onToggleMute: () -> Unit,
    onClearChat: () -> Unit,
    onConnectBluetooth: () -> Unit,
) {
    val friend: ContactView? = state.contacts.firstOrNull { it.uid == conversationId }
    val group: GroupView? = state.groups.firstOrNull { it.groupId == conversationId }
    val title = friend?.name ?: group?.name ?: "Chat"
    val messages = state.messages[conversationId].orEmpty()
    val canWrite = state.phase == EnginePhase.READY && (friend != null || group?.iAmMember == true)
    var menuOpen by remember { mutableStateOf(false) }
    var clearConfirm by remember { mutableStateOf(false) }

    val status = when {
        friend != null -> when (friend.link) {
            LinkStatus.CONNECTED -> friend.path?.let { "Connected · ${it.label}" } ?: "Connected"
            LinkStatus.CONNECTING -> "Connecting…"
            LinkStatus.OFFLINE -> "Waiting for ${friend.name}"
        }
        group != null -> group.exitNote ?: "${group.members.size} members · ${group.connectedCount} connected"
        else -> ""
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                title = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.clickable(onClick = onOpenDetails),
                    ) {
                        InitialsAvatar(title, 38, online = friend?.link == LinkStatus.CONNECTED || (group?.connectedCount ?: 0) > 0)
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                status,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                actions = {
                    Box {
                        IconButton(onClick = { menuOpen = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More") }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text(if (group != null) "Group details" else "Friend details") },
                                onClick = { menuOpen = false; onOpenDetails() },
                            )
                            if (friend != null && !friend.checked) {
                                DropdownMenuItem(text = { Text("Check it's really them") }, onClick = { menuOpen = false; onVerify() })
                            }
                            DropdownMenuItem(
                                text = { Text(if (muted) "Unmute notifications" else "Mute notifications") },
                                onClick = { menuOpen = false; onToggleMute() },
                            )
                            if (friend != null && friend.link != LinkStatus.CONNECTED) {
                                DropdownMenuItem(
                                    text = { Text("Connect over Bluetooth") },
                                    onClick = { menuOpen = false; onConnectBluetooth() },
                                )
                            }
                            DropdownMenuItem(text = { Text("Clear this chat") }, onClick = { menuOpen = false; clearConfirm = true })
                        }
                    }
                },
            )
        },
        bottomBar = {
            if (canWrite) {
                Composer(
                    connected = friend?.link == LinkStatus.CONNECTED || (group?.connectedCount ?: 0) > 0,
                    modifier = Modifier.navigationBarsPadding().imePadding(),
                    onSend = { text, done -> onSend(text, done) },
                )
            } else if (group != null) {
                Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth().navigationBarsPadding()) {
                    Text(
                        (group.exitNote ?: "You cannot write here") + ". You can still read this chat.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                    )
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            state.error?.let { Banner(Icons.Filled.ErrorOutline, it, MaterialTheme.colorScheme.errorContainer, MaterialTheme.colorScheme.onErrorContainer, onDismiss = onClearNotice) }
            state.notice?.let {
                Banner(Icons.Filled.Shield, it, MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.onPrimaryContainer, onDismiss = onClearNotice)
            }
            if (friend != null && friend.trust == ContactTrust.INTRODUCED && !friend.checked) {
                Banner(
                    Icons.Filled.Shield,
                    "Introduced by ${friend.introducedByName ?: "a group member"}. You can check it's really ${friend.name}.",
                    MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant,
                    actionLabel = "Verify", onAction = onVerify,
                )
            }
            MessageList(
                messages = messages,
                selfUid = state.uid,
                isGroup = group != null,
                nameOf = { uid -> group?.members?.firstOrNull { it.uid == uid }?.name ?: friend?.name ?: "Member" },
                onRetry = onRetry,
                modifier = Modifier.weight(1f),
            )
        }
    }

    if (clearConfirm) {
        AlertDialog(
            onDismissRequest = { clearConfirm = false },
            title = { Text("Clear this chat?") },
            text = { Text("The messages are deleted from this phone only. $title keeps their copy.") },
            confirmButton = { TextButton(onClick = { clearConfirm = false; onClearChat() }) { Text("Clear") } },
            dismissButton = { TextButton(onClick = { clearConfirm = false }) { Text("Cancel") } },
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
        Row(modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, tint = content, modifier = Modifier.size(17.dp))
            Spacer(Modifier.width(9.dp))
            Text(text, style = MaterialTheme.typography.bodySmall, color = content, modifier = Modifier.weight(1f))
            if (actionLabel != null && onAction != null) TextButton(onClick = onAction) { Text(actionLabel, color = content) }
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
    messages: List<ChatMessage>,
    selfUid: String,
    isGroup: Boolean,
    nameOf: (String) -> String,
    onRetry: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val lastId = messages.lastOrNull()?.messageId
    LaunchedEffect(lastId) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.lastIndex)
    }

    if (messages.isEmpty()) {
        Box(modifier = modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
                    Icon(
                        Icons.Filled.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(18.dp).size(28.dp),
                    )
                }
                Spacer(Modifier.height(14.dp))
                Text("No messages yet", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(6.dp))
                Text(
                    "Messages here are end-to-end encrypted and kept only on your phones.",
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
        itemsIndexed(messages, key = { _, message -> message.messageId }) { index, message ->
            val day = formatDay(message.clientCreatedAt)
            val previous = messages.getOrNull(index - 1)
            val showDay = previous == null || formatDay(previous.clientCreatedAt) != day
            val grouped = previous != null && !showDay && previous.senderId == message.senderId &&
                message.clientCreatedAt - previous.clientCreatedAt < 4 * 60_000
            Column {
                if (showDay) DaySeparator(day)
                val own = message.senderId == selfUid
                MessageBubble(
                    message = message,
                    own = own,
                    senderName = if (own) "You" else nameOf(message.senderId),
                    showName = isGroup && !own && !grouped,
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
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.Center) {
        Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(20.dp)) {
            Text(
                label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
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
    senderName: String,
    showName: Boolean,
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
        if (!own && showName) {
            // Group chats: a small avatar next to the first message of a run.
            Box(Modifier.width(30.dp)) { if (showAvatar) InitialsAvatar(senderName, 26) }
        } else if (!own) {
            Spacer(Modifier.width(30.dp))
        }
        Box {
            Surface(
                color = if (own) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                shape = RoundedCornerShape(
                    topStart = 18.dp, topEnd = 18.dp,
                    bottomStart = if (own || grouped) 18.dp else 4.dp,
                    bottomEnd = if (!own || grouped) 18.dp else 4.dp,
                ),
                modifier = Modifier.widthIn(max = 310.dp).combinedClickable(onClick = {}, onLongClick = { menuOpen = true }),
            ) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    if (showName) {
                        Text(
                            senderName, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold,
                            color = Color.hsl(avatarHue(senderName).toFloat(), 0.6f, 0.62f),
                        )
                    }
                    Text(
                        text = message.text,
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (own) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(3.dp))
                    Row(modifier = Modifier.align(Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                        val subtle = if (own) MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.75f)
                        else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f)
                        if (own && message.totalRecipients > 0 && message.deliveredTo < message.totalRecipients) {
                            Text(
                                "Delivered to ${message.deliveredTo} of ${message.totalRecipients}",
                                style = MaterialTheme.typography.labelSmall, color = subtle,
                            )
                            Spacer(Modifier.width(6.dp))
                        }
                        Text(formatTime(message.clientCreatedAt), style = MaterialTheme.typography.labelSmall, color = subtle)
                        if (own) {
                            Spacer(Modifier.width(4.dp))
                            DeliveryIndicator(message.deliveryState) { onRetry(message.messageId) }
                        }
                    }
                }
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text("Copy message") },
                    leadingIcon = { Icon(Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(18.dp)) },
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
            Icons.Filled.ErrorOutline, contentDescription = "Not delivered. Tap to retry.",
            tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(15.dp).clickable(onClick = onRetry),
        )
        DeliveryState.QUEUED -> Icon(Icons.Filled.Schedule, contentDescription = "Waiting to send", tint = color, modifier = Modifier.size(14.dp))
        DeliveryState.SENT -> Icon(Icons.Filled.Check, contentDescription = "Sent", tint = color, modifier = Modifier.size(14.dp))
        DeliveryState.DELIVERED -> Icon(Icons.Filled.DoneAll, contentDescription = "Delivered", tint = color, modifier = Modifier.size(15.dp))
        DeliveryState.READ -> Icon(Icons.Filled.DoneAll, contentDescription = "Read", tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(15.dp))
    }
}

@Composable
private fun Composer(
    connected: Boolean,
    modifier: Modifier = Modifier,
    onSend: (String, (Result<Unit>) -> Unit) -> Unit,
) {
    var text by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }
    val length = countCodePoints(text)
    val overLimit = length > MAX_TEXT_LENGTH
    val canSend = !sending && text.trim().isNotEmpty() && !overLimit

    fun send() {
        if (!canSend) return
        sending = true
        onSend(text) { result ->
            sending = false
            result.onSuccess { text = ""; error = null }.onFailure { error = it.message ?: "Message could not be queued." }
        }
    }

    Surface(modifier = modifier, color = MaterialTheme.colorScheme.surface, tonalElevation = 3.dp) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
            error?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(bottom = 6.dp))
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
                    placeholder = { Text(if (connected) "Message" else "Message (sent when you connect)") },
                    maxLines = 5,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { send() }),
                    shape = RoundedCornerShape(20.dp),
                )
                Spacer(Modifier.width(8.dp))
                IconButton(
                    onClick = { send() },
                    enabled = canSend,
                    modifier = Modifier.size(48.dp).clip(CircleShape).background(
                        if (canSend) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                    ),
                ) {
                    if (sending) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(
                            Icons.AutoMirrored.Filled.Send, contentDescription = "Send message",
                            tint = if (canSend) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            if (length > MAX_TEXT_LENGTH - 400) {
                Text(
                    "$length / $MAX_TEXT_LENGTH",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (overLimit) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.align(Alignment.End).padding(top = 4.dp),
                )
            }
        }
    }
}

@Composable
fun InitialsAvatar(name: String, size: Int, online: Boolean = false) {
    val hue = avatarHue(name.ifBlank { "duochat" })
    Box(contentAlignment = Alignment.BottomEnd) {
        Box(
            modifier = Modifier.size(size.dp).clip(CircleShape).background(Color.hsl(hue.toFloat(), 0.55f, 0.45f)),
            contentAlignment = Alignment.Center,
        ) {
            Text(initials(name), color = Color.White, fontSize = (size * 0.34f).sp, fontWeight = FontWeight.SemiBold)
        }
        if (online) {
            Box(
                Modifier.size((size * 0.28f).dp).clip(CircleShape).background(Color(0xFF22C55E))
                    .padding(1.dp),
            )
        }
    }
}

fun formatTime(timestamp: Long): String = SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(timestamp))

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

fun initials(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (parts.isEmpty()) return "?"
    if (parts.size == 1) return parts[0].take(2).uppercase(Locale.getDefault())
    return (parts.first().take(1) + parts.last().take(1)).uppercase(Locale.getDefault())
}

fun avatarHue(seed: String): Int {
    var hash = 0
    for (char in seed) hash = (hash * 31 + char.code) % 360
    return hash
}
