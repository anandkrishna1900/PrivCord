package com.duochat.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Podcasts
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.duochat.app.data.ChatState
import com.duochat.app.data.ChatSummary
import com.duochat.app.data.LinkStatus
import java.util.Date
import java.util.Locale

private enum class Filter(val label: String) { ALL("All"), PEOPLE("People"), GROUPS("Groups") }

/** The chat list: a big title, search, an optional People/Groups filter, the chats, and one "New chat" button. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    state: ChatState,
    onOpenChat: (ChatSummary) -> Unit,
    onAddFriend: () -> Unit,
    onNewGroup: () -> Unit,
    onChannels: () -> Unit,
    onOpenSettings: () -> Unit,
    onClearNotice: () -> Unit,
    onSearch: (String) -> List<com.duochat.app.engine.ChatEngine.SearchHit> = { emptyList() },
    onPanic: (() -> Unit)? = null,
    onOpenConversation: (String) -> Unit = {},
) {
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf(Filter.ALL) }
    var sheetOpen by remember { mutableStateOf(false) }
    val searching = query.trim().length >= 2
    val hits = remember(query, state.messages) { if (searching) onSearch(query) else emptyList() }
    val listState = rememberLazyListState()
    val atTop by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 } }
    val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val showFilters = state.chats.any { it.isGroup } && state.chats.any { !it.isGroup }
    // With the chips hidden (only people, or only groups), a filter picked earlier must not hide chats with no way back.
    val active = if (showFilters) filter else Filter.ALL
    val chats = when (active) {
        Filter.ALL -> state.chats
        Filter.PEOPLE -> state.chats.filter { !it.isGroup }
        Filter.GROUPS -> state.chats.filter { it.isGroup }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        floatingActionButton = {
            if (state.chats.isNotEmpty() && !searching) {
                ExtendedFloatingActionButton(
                    onClick = { sheetOpen = true },
                    expanded = atTop,
                    icon = { Icon(Icons.Filled.Edit, contentDescription = null) },
                    text = { Text("New chat") },
                    containerColor = MaterialTheme.colorScheme.onBackground,
                    contentColor = MaterialTheme.colorScheme.background,
                    shape = RoundedCornerShape(20.dp),
                    modifier = Modifier.navigationBarsPadding(),
                )
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).statusBarsPadding().imePadding()) {
            Header(onOpenSettings = onOpenSettings, onPanic = onPanic)
            state.notice?.let { Notice(it, onClearNotice) }
            if (state.chats.isEmpty()) {
                EmptyHome(onAddFriend, onChannels)
                return@Column
            }
            SearchField(query, onChange = { query = it })
            if (searching) {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = navBottom + 24.dp)) {
                    if (hits.isEmpty()) item {
                        Text(
                            "Nothing matches “${query.trim()}”.",
                            modifier = Modifier.padding(horizontal = 24.dp, vertical = 20.dp),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    items(hits, key = { h -> h.messageId }) { h ->
                        Column(
                            Modifier.fillMaxWidth().clickable { onOpenConversation(h.conversationId); query = "" }
                                .padding(horizontal = 24.dp, vertical = 12.dp),
                        ) {
                            Text(
                                "${h.conversationName} · ${h.senderName}", style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            Spacer(Modifier.height(2.dp))
                            Text(h.text, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
                return@Column
            }
            if (showFilters) {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Filter.entries.forEach { f ->
                        FilterChip(
                            selected = active == f,
                            onClick = { filter = f },
                            label = { Text(f.label) },
                            shape = CircleShape,
                            border = null,
                            colors = FilterChipDefaults.filterChipColors(
                                containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                                labelColor = MaterialTheme.colorScheme.onSurfaceVariant,
                                selectedContainerColor = MaterialTheme.colorScheme.onBackground,
                                selectedLabelColor = MaterialTheme.colorScheme.background,
                            ),
                        )
                    }
                }
            }
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                // Room under the last chat so the floating button (and the navigation bar under it) never covers it.
                contentPadding = PaddingValues(top = 6.dp, bottom = navBottom + 96.dp),
            ) {
                items(chats, key = { it.id }) { chat -> ChatRow(chat) { onOpenChat(chat) } }
            }
        }
    }

    if (sheetOpen) {
        ModalBottomSheet(onDismissRequest = { sheetOpen = false }, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
            Column(Modifier.padding(bottom = 24.dp).navigationBarsPadding()) {
                Text(
                    "Start something", style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 8.dp),
                )
                SheetAction(Icons.Filled.PersonAdd, "Add a friend", "Swap six-word invites or scan a QR code") { sheetOpen = false; onAddFriend() }
                SheetAction(
                    Icons.Filled.Groups, "New group",
                    if (state.contacts.isEmpty()) "Add a friend first" else "Up to 10 people, all connected directly",
                    enabled = state.contacts.isNotEmpty(),
                ) { sheetOpen = false; onNewGroup() }
                SheetAction(Icons.Filled.Podcasts, "Public channels", "Open rooms anyone with the name can read") { sheetOpen = false; onChannels() }
            }
        }
    }
}

@Composable
private fun Header(onOpenSettings: () -> Unit, onPanic: (() -> Unit)?) {
    // Three quick taps on the title trigger the panic wipe when the person turned it on.
    var taps by remember { mutableStateOf(listOf<Long>()) }
    Row(
        Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp, top = 12.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "Chats",
            style = MaterialTheme.typography.headlineLarge,
            modifier = Modifier.weight(1f).clickable(enabled = onPanic != null, indication = null, interactionSource = null) {
                val now = System.currentTimeMillis()
                taps = (taps + now).filter { now - it < 1500 }
                if (taps.size >= 3) { taps = emptyList(); onPanic?.invoke() }
            },
        )
        IconButton(onClick = onOpenSettings) {
            Icon(Icons.Outlined.Settings, contentDescription = "Settings", tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun Notice(text: String, onClear: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.primaryContainer,
        contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        Row(Modifier.padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f).padding(vertical = 8.dp))
            IconButton(onClick = onClear) { Icon(Icons.Filled.Close, contentDescription = "Dismiss", modifier = Modifier.size(18.dp)) }
        }
    }
}

@Composable
private fun SearchField(query: String, onChange: (String) -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = CircleShape,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).heightIn(min = 48.dp),
    ) {
        Row(Modifier.padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Search, contentDescription = null, tint = muted, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
            Box(Modifier.weight(1f).padding(vertical = 13.dp)) {
                if (query.isEmpty()) Text("Search messages", color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                BasicTextField(
                    value = query, onValueChange = onChange, singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (query.isNotEmpty()) IconButton(onClick = { onChange("") }) {
                Icon(Icons.Filled.Close, contentDescription = "Clear search", tint = muted, modifier = Modifier.size(20.dp))
            }
            else Spacer(Modifier.size(12.dp))
        }
    }
}

@Composable
private fun EmptyHome(onAddFriend: () -> Unit, onChannels: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(horizontal = 32.dp).navigationBarsPadding(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Two overlapping avatars: you and the friend you're about to add.
        Box(Modifier.width(112.dp).height(72.dp)) {
            Surface(shape = CircleShape, color = MaterialTheme.colorScheme.tertiary, modifier = Modifier.size(72.dp)) {}
            Surface(
                shape = CircleShape, color = MaterialTheme.colorScheme.primary,
                border = androidx.compose.foundation.BorderStroke(4.dp, MaterialTheme.colorScheme.background),
                modifier = Modifier.size(72.dp).align(Alignment.CenterEnd),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(28.dp))
                }
            }
        }
        Spacer(Modifier.height(28.dp))
        Text("Your first conversation", style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
        Spacer(Modifier.height(10.dp))
        Text(
            "Swap invite codes with a friend in person or by message. Your chats go phone to phone; no server keeps them.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(28.dp))
        Button(
            onClick = onAddFriend,
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
            shape = RoundedCornerShape(16.dp),
        ) {
            Icon(Icons.Filled.PersonAdd, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
            Text("Add a friend")
        }
        Spacer(Modifier.height(4.dp))
        TextButton(onClick = onChannels, modifier = Modifier.heightIn(min = 48.dp)) { Text("Browse public channels") }
    }
}

@Composable
private fun SheetAction(icon: ImageVector, title: String, detail: String, enabled: Boolean = true, onClick: () -> Unit) {
    val alpha = if (enabled) 1f else 0.45f
    Row(
        Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick).padding(horizontal = 24.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Surface(shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = alpha), modifier = Modifier.size(48.dp)) {
            Box(contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurface.copy(alpha = alpha))
            }
        }
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface.copy(alpha = alpha))
            Text(detail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha))
        }
        Icon(
            Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null, modifier = Modifier.size(18.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha * 0.7f),
        )
    }
}

@Composable
private fun ChatRow(chat: ChatSummary, onClick: () -> Unit) {
    val unread = chat.unread > 0
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        InitialsAvatar(name = chat.title, size = 54, online = chat.link == LinkStatus.CONNECTED, group = chat.isGroup)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    chat.title, style = MaterialTheme.typography.titleMedium,
                    fontWeight = if (unread) FontWeight.Bold else FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                if (chat.lastAt > 0 && chat.lastText != null) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        formatListItemTime(chat.lastAt), style = MaterialTheme.typography.labelMedium,
                        fontWeight = if (unread) FontWeight.Bold else FontWeight.Medium,
                        color = if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    chat.lastText ?: chat.subtitle,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                AnimatedVisibility(unread) {
                    Badge(
                        containerColor = MaterialTheme.colorScheme.tertiary,
                        contentColor = MaterialTheme.colorScheme.onTertiary,
                        modifier = Modifier.padding(start = 8.dp).defaultMinSize(minWidth = 22.dp, minHeight = 22.dp),
                    ) {
                        Text(if (chat.unread > 99) "99+" else "${chat.unread}", style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
    }
}

/** Chat-list time: the time today, "Yesterday", the weekday within a week, otherwise the date (all in the phone's style). */
fun formatListItemTime(epochMs: Long): String {
    val zone = java.time.ZoneId.systemDefault()
    val then = java.time.Instant.ofEpochMilli(epochMs).atZone(zone)
    val today = java.time.LocalDate.now(zone)
    val day = then.toLocalDate()
    return when {
        day == today -> java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT, Locale.getDefault()).format(Date(epochMs))
        day == today.minusDays(1) -> "Yesterday"
        day.isAfter(today.minusDays(7)) -> then.format(java.time.format.DateTimeFormatter.ofPattern("EEE", Locale.getDefault()))
        day.year == today.year -> then.format(java.time.format.DateTimeFormatter.ofPattern("MMM d", Locale.getDefault()))
        else -> then.format(java.time.format.DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.getDefault()))
    }
}
