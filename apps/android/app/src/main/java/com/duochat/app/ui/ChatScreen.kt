package com.duochat.app.ui

import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.produceState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import com.duochat.app.data.FileMeta
import com.duochat.app.data.MAX_FILE_BYTES
import com.duochat.app.data.MessageType
import com.duochat.app.data.formatBytes
import com.duochat.app.data.isInlineImage
import com.duochat.app.data.isInlineVideo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
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
import androidx.compose.foundation.layout.heightIn
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
    onSend: (String, String?, (Result<Unit>) -> Unit) -> Unit,
    onSendFile: (String, String, ByteArray, String?, (Result<Unit>) -> Unit) -> Unit,
    loadFile: suspend (String) -> Pair<FileMeta, ByteArray>?,
    onRetry: (String) -> Unit,
    onClearNotice: () -> Unit,
    onOpenDetails: () -> Unit,
    onVerify: () -> Unit,
    onToggleMute: () -> Unit,
    onClearChat: () -> Unit,
    onConnectBluetooth: () -> Unit,
    onLeaveChannel: () -> Unit,
    onMuteSender: (String) -> Unit,
    onDeleteMessage: (String, Boolean) -> Unit = { _, _ -> },
    onReact: (String, String) -> Unit = { _, _ -> },
    onSetDisappearing: (Int) -> Unit = {},
    onEnableStoreForward: () -> Unit = {},
    onOpenConnectionSettings: () -> Unit = {},
) {
    val friend: ContactView? = state.contacts.firstOrNull { it.uid == conversationId }
    val group: GroupView? = state.groups.firstOrNull { it.groupId == conversationId }
    val channel = state.channels.firstOrNull { it.id == conversationId }
    val title = friend?.name ?: group?.name ?: channel?.let { "# ${it.name}" } ?: "Chat"
    val messages = state.messages[conversationId].orEmpty()
    val canWrite = state.phase == EnginePhase.READY && (friend != null || group?.iAmMember == true || channel != null)
    var menuOpen by remember { mutableStateOf(false) }
    var clearConfirm by remember { mutableStateOf(false) }
    var disappearOpen by remember { mutableStateOf(false) }
    var replyingTo by remember(conversationId) { mutableStateOf<ChatMessage?>(null) }
    val directBlocked = friend != null && !friend.direct

    val status = when {
        friend != null -> when (friend.link) {
            LinkStatus.CONNECTED -> friend.path?.let { "Connected · ${it.label}" } ?: "Connected"
            LinkStatus.CONNECTING -> "Connecting…"
            LinkStatus.OFFLINE -> "Waiting for ${friend.name}"
        }
        channel != null -> "Public channel · anyone who knows the name can read this"
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
                                text = { Text(if (channel != null) "Leave channel" else if (group != null) "Group details" else "Friend details") },
                                onClick = { menuOpen = false; if (channel != null) onLeaveChannel() else onOpenDetails() },
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
                            if (channel == null) {
                                val cur = state.disappearing[conversationId] ?: 0
                                DropdownMenuItem(
                                    text = { Text("Disappearing messages: ${com.duochat.app.data.describeDisappear(cur)}") },
                                    onClick = { menuOpen = false; disappearOpen = true },
                                )
                            }
                            DropdownMenuItem(text = { Text("Clear this chat") }, onClick = { menuOpen = false; clearConfirm = true })
                        }
                    }
                },
            )
        },
        bottomBar = {
            if (canWrite && directBlocked) {
                Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth().navigationBarsPadding()) {
                    Text(
                        if (state.groupOnly) {
                            "You stay group-only with people you meet in groups. To message ${friend?.name} directly, swap invites (Add friend)."
                        } else {
                            "${friend?.name} stays group-only. You can talk in your groups; to message directly, swap invites (Add friend)."
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                    )
                }
            } else if (canWrite) {
                Composer(
                    connected = friend?.link == LinkStatus.CONNECTED || (group?.connectedCount ?: 0) > 0 || channel?.connected == true,
                    isChannel = channel != null,
                    modifier = Modifier.navigationBarsPadding().imePadding(),
                    replyingTo = replyingTo,
                    replyName = replyingTo?.let { r -> if (r.senderId == state.uid) "yourself" else (group?.members?.firstOrNull { it.uid == r.senderId }?.name ?: friend?.name ?: "them") },
                    onCancelReply = { replyingTo = null },
                    onSend = { text, done -> onSend(text, replyingTo?.messageId) { r -> if (r.isSuccess) replyingTo = null; done(r) } },
                    onSendFile = { name, mime, bytes, done -> onSendFile(name, mime, bytes, replyingTo?.messageId) { r -> if (r.isSuccess) replyingTo = null; done(r) } },
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
            if (channel != null) {
                Banner(
                    Icons.Filled.Shield,
                    "Public channel: anyone who knows the name can read it. Your messages show your name and a short ID.",
                    MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            friend?.diagnosis?.let { d ->
                Surface(color = MaterialTheme.colorScheme.tertiaryContainer, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
                        Text(d.message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onTertiaryContainer)
                        Row {
                            if (com.duochat.app.data.DiagnosisAction.ENABLE_STORE_FORWARD in d.actions) {
                                TextButton(onClick = onEnableStoreForward) { Text(androidx.compose.ui.res.stringResource(com.duochat.app.R.string.diagnosis_deliver_via_relays)) }
                            }
                            if (d.actions.any { it == com.duochat.app.data.DiagnosisAction.ADD_TURN || it == com.duochat.app.data.DiagnosisAction.OPEN_CONNECTION_SETTINGS }) {
                                TextButton(onClick = onOpenConnectionSettings) { Text(androidx.compose.ui.res.stringResource(com.duochat.app.R.string.diagnosis_connection_settings)) }
                            }
                        }
                    }
                }
            }
            if (friend != null && friend.trust == ContactTrust.INTRODUCED && !friend.checked && friend.direct) {
                Banner(
                    Icons.Filled.Shield,
                    "Introduced by ${friend.introducedByName ?: "a group member"}. You can check it's really ${friend.name}.",
                    MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant,
                    actionLabel = "Verify", onAction = onVerify,
                )
            }
            MessageList(
                messages = messages,
                convId = conversationId,
                selfUid = state.uid,
                isGroup = group != null || channel != null,
                canReply = channel == null,
                onMute = if (channel != null) onMuteSender else null,
                nameOf = { uid -> group?.members?.firstOrNull { it.uid == uid }?.name ?: friend?.name ?: "Member" },
                onRetry = onRetry,
                onReply = { replyingTo = it },
                onDelete = onDeleteMessage,
                onReact = onReact,
                loadFile = loadFile,
                transfers = state.transfers,
                modifier = Modifier.weight(1f),
            )
        }
    }

    if (disappearOpen) {
        AlertDialog(
            onDismissRequest = { disappearOpen = false },
            title = { Text("Disappearing messages") },
            text = {
                Column {
                    Text("New messages in this chat are removed from both phones after the time you pick. Anyone can still copy or screenshot them.", style = MaterialTheme.typography.bodySmall)
                    com.duochat.app.data.DISAPPEAR_OPTIONS.forEach { sec ->
                        TextButton(onClick = { onSetDisappearing(sec); disappearOpen = false }) {
                            Text(com.duochat.app.data.describeDisappear(sec) + if ((state.disappearing[conversationId] ?: 0) == sec) "  ✓" else "")
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { disappearOpen = false }) { Text("Close") } },
        )
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
    onReply: (ChatMessage) -> Unit,
    onDelete: (String, Boolean) -> Unit,
    onReact: (String, String) -> Unit,
    loadFile: suspend (String) -> Pair<FileMeta, ByteArray>?,
    transfers: Map<String, Float>,
    convId: String = "",
    canReply: Boolean = true,
    onMute: ((String) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val lastId = messages.lastOrNull()?.messageId
    // True while the view follows the newest message. Dragging up turns it off; reaching the bottom turns it on.
    var pinned by remember(convId) { mutableStateOf(true) }
    var unseen by remember(convId) { mutableStateOf(0) }
    var lastSeenId by remember(convId) { mutableStateOf<String?>(null) }
    val atBottom by remember {
        androidx.compose.runtime.derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()
            last == null || (last.index >= info.totalItemsCount - 1 && last.offset + last.size <= info.viewportEndOffset + 48)
        }
    }
    LaunchedEffect(listState) {
        androidx.compose.runtime.snapshotFlow { listState.isScrollInProgress to atBottom }.collect { (dragging, bottom) ->
            if (dragging) pinned = bottom
            if (bottom) unseen = 0
        }
    }
    // New messages: open at the newest one, follow while pinned or when we sent it, otherwise count them.
    LaunchedEffect(convId, lastId) {
        if (messages.isEmpty() || lastId == lastSeenId) return@LaunchedEffect
        val first = lastSeenId == null
        lastSeenId = lastId
        val mine = messages.last().senderId == selfUid
        if (first) {
            listState.scrollToItem(messages.lastIndex)
        } else if (pinned || mine) {
            pinned = true
            listState.animateScrollToItem(messages.lastIndex)
        } else {
            unseen += 1
        }
    }
    // Photos and videos change height after they appear: keep following the bottom while pinned.
    val lastItemSize = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.size
    LaunchedEffect(lastItemSize) {
        if (pinned && messages.isNotEmpty()) listState.scrollToItem(messages.lastIndex)
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

    Box(modifier = modifier.fillMaxWidth()) {
    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
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
                    senderName = if (own) "You" else (message.senderName ?: nameOf(message.senderId)),
                    canReply = canReply,
                    onMute = onMute,
                    showName = isGroup && !own && !grouped,
                    showAvatar = !grouped,
                    grouped = grouped,
                    onRetry = onRetry,
                    onReply = onReply,
                    onDelete = onDelete,
                    onReact = onReact,
                    selfUid = selfUid,
                    loadFile = loadFile,
                    progress = transfers[message.messageId],
                    quotedName = message.replyTo?.let { r -> if (r.author == selfUid) "You" else nameOf(r.author) },
                    onJumpTo = { id ->
                        val at = messages.indexOfFirst { it.messageId == id }
                        if (at >= 0) scope.launch { listState.animateScrollToItem(at) }
                    },
                )
            }
        }
    }
    if (unseen > 0) {
        androidx.compose.material3.FilledTonalButton(
            onClick = {
                pinned = true
                unseen = 0
                scope.launch { listState.animateScrollToItem(messages.lastIndex) }
            },
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp),
        ) { Text("↓ $unseen new ${if (unseen == 1) "message" else "messages"}") }
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
    onReply: (ChatMessage) -> Unit,
    onDelete: (String, Boolean) -> Unit,
    onReact: (String, String) -> Unit,
    selfUid: String,
    loadFile: suspend (String) -> Pair<FileMeta, ByteArray>?,
    progress: Float?,
    quotedName: String?,
    onJumpTo: (String) -> Unit,
    canReply: Boolean = true,
    onMute: ((String) -> Unit)? = null,
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
                    val bodyColor = if (own) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
                    message.replyTo?.let { reply ->
                        Row(
                            modifier = Modifier.padding(bottom = 6.dp).height(IntrinsicSize.Min)
                                .clip(RoundedCornerShape(6.dp)).background(bodyColor.copy(alpha = 0.12f))
                                .clickable { onJumpTo(reply.id) },
                        ) {
                            Box(Modifier.width(3.dp).fillMaxHeight().background(bodyColor.copy(alpha = 0.8f)))
                            Column(Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
                                Text(quotedName ?: "Earlier message", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = bodyColor)
                                Text(reply.preview, style = MaterialTheme.typography.bodySmall, color = bodyColor.copy(alpha = 0.85f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    if (message.deleted) {
                        Text(androidx.compose.ui.res.stringResource(com.duochat.app.R.string.message_deleted), style = MaterialTheme.typography.bodyMedium, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic, color = bodyColor.copy(alpha = 0.7f))
                    } else if (message.type == MessageType.FILE && message.file != null) {
                        FileContent(message, bodyColor, loadFile, progress)
                    } else {
                        Text(text = message.text, style = MaterialTheme.typography.bodyLarge, color = bodyColor)
                    }
                    val chips = com.duochat.app.data.summarizeReactions(message.reactions, selfUid)
                    if (chips.isNotEmpty() && !message.deleted) {
                        Spacer(Modifier.height(4.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            chips.forEach { c ->
                                Surface(
                                    shape = RoundedCornerShape(12.dp),
                                    color = bodyColor.copy(alpha = if (c.mine) 0.30f else 0.14f),
                                    modifier = Modifier.clickable { onReact(message.messageId, c.emoji) },
                                ) { Text(if (c.count > 1) "${c.emoji} ${c.count}" else c.emoji, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp)) }
                            }
                        }
                    }
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
                if (!message.deleted) Row(Modifier.padding(horizontal = 8.dp)) {
                    com.duochat.app.data.REACTION_EMOJI.forEach { e ->
                        TextButton(onClick = { menuOpen = false; onReact(message.messageId, e) }, contentPadding = PaddingValues(6.dp), modifier = Modifier.widthIn(min = 36.dp)) { Text(e) }
                    }
                }
                if (canReply && !message.deleted) DropdownMenuItem(
                    text = { Text("Reply") },
                    leadingIcon = { Icon(Icons.AutoMirrored.Filled.Reply, contentDescription = null, modifier = Modifier.size(18.dp)) },
                    onClick = { menuOpen = false; onReply(message) },
                )
                if (onMute != null && !own) DropdownMenuItem(
                    text = { Text("Mute this person") },
                    onClick = { menuOpen = false; onMute(message.senderId) },
                )
                if (!message.deleted) DropdownMenuItem(
                    text = { Text("Delete for me") },
                    onClick = { menuOpen = false; onDelete(message.messageId, false) },
                )
                if (own && !message.deleted && canReply) DropdownMenuItem(
                    text = { Text("Delete for everyone") },
                    onClick = { menuOpen = false; onDelete(message.messageId, true) },
                )
                if (message.type == MessageType.TEXT && !message.deleted) DropdownMenuItem(
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

/** A file: a preview for safe image types, a card with Save for everything else. */
@Composable
private fun FileContent(message: ChatMessage, color: Color, loadFile: suspend (String) -> Pair<FileMeta, ByteArray>?, progress: Float?) {
    val meta = message.file ?: return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pendingSave by remember { mutableStateOf<ByteArray?>(null) }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri: Uri? ->
        val bytes = pendingSave
        pendingSave = null
        if (uri != null && bytes != null) {
            scope.launch {
                val ok = withContext(Dispatchers.IO) {
                    runCatching { context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("no stream") }.isSuccess
                }
                Toast.makeText(context, if (ok) "Saved" else "Could not save the file", Toast.LENGTH_SHORT).show()
            }
        }
    }
    var viewing by remember { mutableStateOf(false) }
    val image by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, message.messageId) {
        if (!isInlineImage(meta.mime)) return@produceState
        value = withContext(Dispatchers.IO) { loadFile(message.messageId)?.second?.let { decodeUpright(it, 1200) } }
    }
    // Full-size copy, only decoded while the viewer is open.
    val fullImage by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, viewing) {
        if (!viewing) return@produceState
        value = withContext(Dispatchers.IO) { loadFile(message.messageId)?.second?.let { decodeUpright(it, 2600) } }
    }
    // Video: decrypted to a short-lived cache file (the player needs a path), shown with a poster frame and
    // played in place when tapped. The file is deleted when the bubble leaves the screen.
    val videoFile by produceState<java.io.File?>(null, message.messageId) {
        if (!isInlineVideo(meta.mime)) return@produceState
        value = withContext(Dispatchers.IO) {
            val bytes = loadFile(message.messageId)?.second ?: return@withContext null
            java.io.File(context.cacheDir, "preview-${message.messageId}").also { it.writeBytes(bytes) }
        }
    }
    androidx.compose.runtime.DisposableEffect(videoFile) { onDispose { videoFile?.delete() } }
    val poster by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, videoFile) {
        val f = videoFile ?: return@produceState
        value = withContext(Dispatchers.IO) {
            runCatching {
                val r = android.media.MediaMetadataRetriever()
                try {
                    r.setDataSource(f.path)
                    r.getFrameAtTime(0)?.asImageBitmap()
                } finally {
                    r.release()
                }
            }.getOrNull()
        }
    }
    var playing by remember { mutableStateOf(false) }
    Column {
        image?.let {
            Image(
                bitmap = it, contentDescription = "Open ${meta.name}", contentScale = ContentScale.Fit,
                modifier = Modifier.heightIn(max = 260.dp).clip(RoundedCornerShape(10.dp)).clickable { viewing = true },
            )
            Spacer(Modifier.height(6.dp))
        }
        if (viewing) {
            androidx.compose.ui.window.Dialog(
                onDismissRequest = { viewing = false },
                properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
            ) {
                Surface(color = Color.Black, modifier = Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        val big = fullImage ?: image
                        if (big != null) {
                            Image(bitmap = big, contentDescription = meta.name, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize().clickable { viewing = false })
                        } else {
                            CircularProgressIndicator(color = Color.White)
                        }
                        Row(Modifier.align(Alignment.TopEnd).padding(12.dp)) {
                            IconButton(onClick = {
                                scope.launch {
                                    val f = loadFile(message.messageId)
                                    if (f == null) Toast.makeText(context, "No longer stored on this phone", Toast.LENGTH_SHORT).show()
                                    else { pendingSave = f.second; saver.launch(f.first.name) }
                                }
                            }) { Icon(Icons.Filled.Download, contentDescription = "Save ${meta.name}", tint = Color.White) }
                            IconButton(onClick = { viewing = false }) { Icon(Icons.Filled.Close, contentDescription = "Close", tint = Color.White) }
                        }
                    }
                }
            }
        }
        videoFile?.let { file ->
            Box(Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 260.dp).clip(RoundedCornerShape(10.dp)).background(Color.Black), contentAlignment = Alignment.Center) {
                if (playing) {
                    androidx.compose.ui.viewinterop.AndroidView(
                        factory = { c ->
                            android.widget.VideoView(c).apply {
                                setMediaController(android.widget.MediaController(c).also { it.setAnchorView(this) })
                                setVideoPath(file.path)
                                setOnPreparedListener { start() }
                            }
                        },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 260.dp),
                    )
                } else {
                    poster?.let { Image(bitmap = it, contentDescription = "Video preview of ${meta.name}", contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize()) }
                    IconButton(onClick = { playing = true }) {
                        Icon(Icons.Filled.PlayArrow, contentDescription = "Play video", tint = Color.White, modifier = Modifier.size(48.dp))
                    }
                }
            }
            Spacer(Modifier.height(6.dp))
        }
        if (com.duochat.app.data.isInlineAudio(meta.mime)) {
            val audioFile by produceState<java.io.File?>(null, message.messageId) {
                value = withContext(Dispatchers.IO) {
                    val bytes = loadFile(message.messageId)?.second ?: return@withContext null
                    java.io.File(context.cacheDir, "audio-${message.messageId}").also { it.writeBytes(bytes) }
                }
            }
            androidx.compose.runtime.DisposableEffect(audioFile) { onDispose { audioFile?.delete() } }
            var player by remember { mutableStateOf<android.media.MediaPlayer?>(null) }
            var isPlaying by remember { mutableStateOf(false) }
            androidx.compose.runtime.DisposableEffect(Unit) { onDispose { player?.release() } }
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(enabled = audioFile != null, onClick = {
                    val f = audioFile ?: return@IconButton
                    if (isPlaying) { player?.pause(); isPlaying = false }
                    else {
                        val p = player ?: android.media.MediaPlayer().also { mp ->
                            mp.setDataSource(f.path); mp.prepare()
                            mp.setOnCompletionListener { isPlaying = false }
                            player = mp
                        }
                        p.start(); isPlaying = true
                    }
                }) { Icon(if (isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow, contentDescription = if (isPlaying) "Pause" else "Play voice note", tint = color) }
                Text("Voice note · ${formatBytes(meta.size)}", style = MaterialTheme.typography.bodyMedium, color = color)
            }
            Spacer(Modifier.height(4.dp))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.InsertDriveFile, contentDescription = null, tint = color, modifier = Modifier.size(28.dp))
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f, fill = false)) {
                Text(meta.name, style = MaterialTheme.typography.bodyMedium, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(formatBytes(meta.size), style = MaterialTheme.typography.labelSmall, color = color.copy(alpha = 0.75f))
            }
            IconButton(onClick = {
                scope.launch {
                    val f = loadFile(message.messageId)
                    if (f == null) Toast.makeText(context, "No longer stored on this phone", Toast.LENGTH_SHORT).show()
                    else { pendingSave = f.second; saver.launch(f.first.name) }
                }
            }) { Icon(Icons.Filled.Download, contentDescription = "Save ${meta.name}", tint = color) }
        }
        if (progress != null) {
            LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp), color = color, trackColor = color.copy(alpha = 0.2f))
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
    isChannel: Boolean = false,
    modifier: Modifier = Modifier,
    replyingTo: ChatMessage?,
    replyName: String?,
    onCancelReply: () -> Unit,
    onSend: (String, (Result<Unit>) -> Unit) -> Unit,
    onSendFile: (String, String, ByteArray, (Result<Unit>) -> Unit) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
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

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris: List<Uri> ->
        scope.launch {
            for (uri in uris.take(5)) {
                val read = withContext(Dispatchers.IO) { runCatching { readPicked(context, uri) } }
                val file = read.getOrNull()
                if (file == null) {
                    error = read.exceptionOrNull()?.message ?: "Could not read that file."
                    return@launch
                }
                var failure: String? = null
                kotlinx.coroutines.suspendCancellableCoroutine<Unit> { cont ->
                    onSendFile(file.name, file.mime, file.bytes) { r -> failure = r.exceptionOrNull()?.message; cont.resume(Unit) { } }
                }
                if (failure != null) { error = failure; return@launch }
            }
            error = null
        }
    }

    var recorder by remember { mutableStateOf<android.media.MediaRecorder?>(null) }
    var recordFile by remember { mutableStateOf<java.io.File?>(null) }
    var recordStart by remember { mutableStateOf(0L) }
    androidx.compose.runtime.DisposableEffect(Unit) {
        onDispose { runCatching { recorder?.stop() }; recorder?.release(); recordFile?.delete() }
    }
    fun startRecording() {
        runCatching {
            val f = java.io.File(context.cacheDir, "voice-${System.currentTimeMillis()}.m4a")
            @Suppress("DEPRECATION")
            val r = if (android.os.Build.VERSION.SDK_INT >= 31) android.media.MediaRecorder(context) else android.media.MediaRecorder()
            r.setAudioSource(android.media.MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(android.media.MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(android.media.MediaRecorder.AudioEncoder.AAC)
            r.setAudioEncodingBitRate(48_000)
            r.setAudioSamplingRate(32_000)
            r.setMaxDuration(5 * 60_000)
            r.setOutputFile(f.path)
            r.prepare(); r.start()
            recorder = r; recordFile = f; recordStart = System.currentTimeMillis(); error = null
        }.onFailure { error = "Could not start recording." }
    }
    fun stopRecording(send: Boolean) {
        val r = recorder; val f = recordFile
        recorder = null; recordFile = null
        val ok = runCatching { r?.stop() }.isSuccess
        r?.release()
        if (!send || !ok || f == null) { f?.delete(); return }
        scope.launch {
            val bytes = withContext(Dispatchers.IO) { runCatching { f.readBytes() }.getOrNull().also { f.delete() } }
            if (bytes == null || bytes.isEmpty()) { error = "Recording was empty."; return@launch }
            onSendFile("voice-note.m4a", "audio/mp4", bytes) { r2 -> r2.exceptionOrNull()?.let { error = it.message } }
        }
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startRecording() else error = "Allow the microphone to record voice notes."
    }

    Surface(modifier = modifier, color = MaterialTheme.colorScheme.surface, tonalElevation = 3.dp) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
            if (replyingTo != null) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp).clip(RoundedCornerShape(10.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant).padding(start = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
                        Text("Replying to ${replyName ?: "them"}", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                        Text(
                            if (replyingTo.type == MessageType.FILE) "\uD83D\uDCCE ${replyingTo.text}" else replyingTo.text,
                            style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    IconButton(onClick = onCancelReply) { Icon(Icons.Filled.Close, contentDescription = "Cancel reply") }
                }
            }
            error?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(bottom = 6.dp))
            }
            if (recorder != null) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Filled.Mic, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.width(8.dp))
                    Text("Recording… tap send to share it", modifier = Modifier.weight(1f))
                    TextButton(onClick = { stopRecording(false) }) { Text("Cancel") }
                    IconButton(onClick = { stopRecording(true) }) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send voice note") }
                }
            } else Row(verticalAlignment = Alignment.Bottom) {
                if (!isChannel) IconButton(onClick = {
                    if (androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) startRecording()
                    else micPermission.launch(android.Manifest.permission.RECORD_AUDIO)
                }, modifier = Modifier.size(48.dp)) { Icon(Icons.Filled.Mic, contentDescription = androidx.compose.ui.res.stringResource(com.duochat.app.R.string.voice_record)) }
                if (!isChannel) IconButton(onClick = { picker.launch("*/*") }, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.Filled.AttachFile, contentDescription = "Send a file (up to 8 MB)")
                }
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

private class PickedFile(val name: String, val mime: String, val bytes: ByteArray)

/** Reads a file the user picked, refusing anything over the 8 MB limit before it is loaded into memory. */
private fun readPicked(context: android.content.Context, uri: Uri): PickedFile {
    var name = "file"
    var size = -1L
    context.contentResolver.query(uri, null, null, null, null)?.use { c ->
        if (c.moveToFirst()) {
            c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { name = c.getString(it) ?: name }
            c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { size = c.getLong(it) }
        }
    }
    if (size > MAX_FILE_BYTES) throw IllegalArgumentException("Files can be at most ${formatBytes(MAX_FILE_BYTES)}.")
    val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            out.write(buffer, 0, n)
            if (out.size() > MAX_FILE_BYTES) throw IllegalArgumentException("Files can be at most ${formatBytes(MAX_FILE_BYTES)}.")
        }
        out.toByteArray()
    } ?: throw IllegalStateException("Could not open that file.")
    return PickedFile(name, context.contentResolver.getType(uri) ?: "application/octet-stream", bytes)
}

/**
 * Decodes a photo, no bigger than [maxSide] on its longest side, and turns it the way the camera meant it to be
 * seen (the EXIF orientation tag), so phone photos are not sideways.
 */
private fun decodeUpright(bytes: ByteArray, maxSide: Int): androidx.compose.ui.graphics.ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (bounds.outWidth / sample > maxSide || bounds.outHeight / sample > maxSide) sample *= 2
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    val orientation = runCatching {
        android.media.ExifInterface(java.io.ByteArrayInputStream(bytes))
            .getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, android.media.ExifInterface.ORIENTATION_NORMAL)
    }.getOrDefault(1)
    val (degrees, mirror) = com.duochat.app.data.exifTransform(orientation)
    if (degrees == 0 && !mirror) return decoded.asImageBitmap()
    val matrix = android.graphics.Matrix().apply {
        if (mirror) postScale(-1f, 1f)
        postRotate(degrees.toFloat())
    }
    return android.graphics.Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true).asImageBitmap()
}
