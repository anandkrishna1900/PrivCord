package com.duochat.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.duochat.app.data.AppSettings
import com.duochat.app.data.ChatState
import com.duochat.app.data.local.ContactEntity
import com.duochat.app.data.local.GroupEntity
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    state: ChatState,
    settings: AppSettings,
    contacts: List<ContactEntity>,
    groups: List<GroupEntity>,
    onSelectContact: (ContactEntity) -> Unit,
    onSelectGroup: (GroupEntity) -> Unit,
    onOpenDefaultChat: () -> Unit,
    onAddContact: (String, String, (Result<Unit>) -> Unit) -> Unit,
    onCreateGroup: (String, (Result<Unit>) -> Unit) -> Unit,
    onRemoveContact: (String) -> Unit,
    onRemoveGroup: (String) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenPairing: () -> Unit,
) {
    var selectedTab by remember { mutableIntStateOf(0) }
    var searchQuery by remember { mutableStateOf("") }
    var showAddContactDialog by remember { mutableStateOf(false) }
    var showCreateGroupDialog by remember { mutableStateOf(false) }

    val defaultPeerName = settings.peerNickname.ifBlank { "Direct Peer" }
    val lastMessageText = state.messages.lastOrNull()?.text ?: "No messages yet"

    Scaffold(
        topBar = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surface),
            ) {
                TopAppBar(
                    title = {
                        Text(
                            "PrivCord",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    },
                    actions = {
                        IconButton(onClick = onOpenPairing) {
                            Icon(Icons.Filled.QrCodeScanner, contentDescription = "Pair contact card")
                        }
                        IconButton(onClick = onOpenSettings) {
                            Icon(Icons.Filled.Settings, contentDescription = "Settings")
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                    ),
                )

                // WhatsApp / Telegram style Tab Header
                TabRow(
                    selectedTabIndex = selectedTab,
                    containerColor = MaterialTheme.colorScheme.surface,
                ) {
                    Tab(
                        selected = selectedTab == 0,
                        onClick = { selectedTab = 0 },
                        text = {
                            Text(
                                "CHATS (" + (1 + contacts.size) + ")",
                                fontWeight = if (selectedTab == 0) FontWeight.Bold else FontWeight.Normal,
                            )
                        },
                    )
                    Tab(
                        selected = selectedTab == 1,
                        onClick = { selectedTab = 1 },
                        text = {
                            Text(
                                "GROUPS (" + groups.size + ")",
                                fontWeight = if (selectedTab == 1) FontWeight.Bold else FontWeight.Normal,
                            )
                        },
                    )
                    Tab(
                        selected = selectedTab == 2,
                        onClick = { selectedTab = 2 },
                        text = {
                            Text(
                                "CONTACTS (" + contacts.size + ")",
                                fontWeight = if (selectedTab == 2) FontWeight.Bold else FontWeight.Normal,
                            )
                        },
                    )
                }
            }
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = {
                    if (selectedTab == 1) {
                        showCreateGroupDialog = true
                    } else {
                        showAddContactDialog = true
                    }
                },
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
            ) {
                Icon(
                    if (selectedTab == 1) Icons.Filled.Group else Icons.Filled.PersonAdd,
                    contentDescription = if (selectedTab == 1) "New Group" else "New Chat",
                )
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            when (selectedTab) {
                0 -> {
                    // All Chats List (WhatsApp style)
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        // 1. Pinned active peer conversation
                        item {
                            ConversationListItem(
                                title = defaultPeerName,
                                subtitle = lastMessageText,
                                online = state.p2pConnected,
                                unreadCount = if (state.queuedCount > 0) state.queuedCount else null,
                                time = state.messages.lastOrNull()?.clientCreatedAt,
                                isGroup = false,
                                onClick = onOpenDefaultChat,
                            )
                            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                        }

                        // 2. Extra contacts
                        items(contacts) { contact ->
                            ConversationListItem(
                                title = contact.name,
                                subtitle = "ID: " + contact.uid.take(12) + "…",
                                online = false,
                                unreadCount = null,
                                time = contact.createdAt,
                                isGroup = false,
                                onClick = { onSelectContact(contact) },
                                onDelete = { onRemoveContact(contact.uid) },
                            )
                            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                        }

                        // 3. Groups in chat list
                        items(groups) { group ->
                            ConversationListItem(
                                title = group.name,
                                subtitle = "End-to-end encrypted group",
                                online = true,
                                unreadCount = null,
                                time = group.createdAt,
                                isGroup = true,
                                onClick = { onSelectGroup(group) },
                                onDelete = { onRemoveGroup(group.groupId) },
                            )
                            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                        }
                    }
                }
                1 -> {
                    // Groups Tab
                    if (groups.isEmpty()) {
                        EmptyStatePrompt(
                            icon = Icons.Filled.Group,
                            title = "No group chats yet",
                            subtitle = "Tap the + button to create a group. Messages are end-to-end encrypted.",
                            buttonText = "Create Group",
                            onAction = { showCreateGroupDialog = true },
                        )
                    } else {
                        LazyColumn(modifier = Modifier.fillMaxSize()) {
                            items(groups) { group ->
                                ConversationListItem(
                                    title = group.name,
                                    subtitle = "End-to-end encrypted group",
                                    online = true,
                                    unreadCount = null,
                                    time = group.createdAt,
                                    isGroup = true,
                                    onClick = { onSelectGroup(group) },
                                    onDelete = { onRemoveGroup(group.groupId) },
                                )
                                HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                            }
                        }
                    }
                }
                2 -> {
                    // Contacts Tab
                    if (contacts.isEmpty()) {
                        EmptyStatePrompt(
                            icon = Icons.Filled.Person,
                            title = "No contacts saved yet",
                            subtitle = "Tap '+ Add Contact' or scan a friend's contact card to add them to your decentralized address book.",
                            buttonText = "Add Contact",
                            onAction = { showAddContactDialog = true },
                        )
                    } else {
                        LazyColumn(modifier = Modifier.fillMaxSize()) {
                            items(contacts) { contact ->
                                ConversationListItem(
                                    title = contact.name,
                                    subtitle = "Safety Number: " + contact.safetyNumber,
                                    online = false,
                                    unreadCount = null,
                                    time = contact.createdAt,
                                    isGroup = false,
                                    onClick = { onSelectContact(contact) },
                                    onDelete = { onRemoveContact(contact.uid) },
                                )
                                HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                            }
                        }
                    }
                }
            }
        }
    }

    if (showAddContactDialog) {
        var nameInput by remember { mutableStateOf("") }
        var uidInput by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { showAddContactDialog = false },
            title = { Text("Add New Contact") },
            text = {
                Column {
                    OutlinedTextField(
                        value = nameInput,
                        onValueChange = { nameInput = it },
                        label = { Text("Contact Name") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = uidInput,
                        onValueChange = { uidInput = it },
                        label = { Text("Peer ID / Public Key") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (nameInput.isNotBlank()) {
                            val id = uidInput.ifBlank { UUID.randomUUID().toString() }
                            onAddContact(nameInput.trim(), id.trim()) {}
                            showAddContactDialog = false
                        }
                    },
                    enabled = nameInput.isNotBlank(),
                ) {
                    Text("Add")
                }
            },
            dismissButton = {
                TextButton(onClick = { showAddContactDialog = false }) {
                    Text("Cancel")
                }
            },
        )
    }

    if (showCreateGroupDialog) {
        var groupNameInput by remember { mutableStateOf("") }
        var groupCreateError by remember { mutableStateOf<String?>(null) }
        var groupCreating by remember { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { if (!groupCreating) showCreateGroupDialog = false },
            title = { Text("Create Group Chat") },
            text = {
                Column {
                    Text(
                        "Give your group a name. Messages are end-to-end encrypted and stored only on members' devices.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = groupNameInput,
                        onValueChange = { groupNameInput = it; groupCreateError = null },
                        label = { Text("Group Name") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        isError = groupCreateError != null,
                    )
                    groupCreateError?.let {
                        Spacer(Modifier.height(4.dp))
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (groupNameInput.isNotBlank() && !groupCreating) {
                            groupCreating = true
                            groupCreateError = null
                            onCreateGroup(groupNameInput.trim()) { result ->
                                groupCreating = false
                                if (result.isSuccess) {
                                    showCreateGroupDialog = false
                                } else {
                                    groupCreateError = result.exceptionOrNull()?.message ?: "Failed to create group. Please try again."
                                }
                            }
                        }
                    },
                    enabled = groupNameInput.isNotBlank() && !groupCreating,
                ) {
                    Text(if (groupCreating) "Creating…" else "Create")
                }
            },
            dismissButton = {
                TextButton(onClick = { showCreateGroupDialog = false }) {
                    Text("Cancel")
                }
            },
        )
    }
}

@Composable
fun ConversationListItem(
    title: String,
    subtitle: String,
    online: Boolean,
    unreadCount: Int?,
    time: Long?,
    isGroup: Boolean,
    onClick: () -> Unit,
    onDelete: (() -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        InitialsAvatar(name = title, size = 50, online = online)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                time?.let {
                    Text(
                        formatListItemTime(it),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (unreadCount != null && unreadCount > 0) {
                    Box(
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.primary)
                            .padding(horizontal = 7.dp, vertical = 2.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "$unreadCount",
                            color = MaterialTheme.colorScheme.onPrimary,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
            }
        }
        if (onDelete != null) {
            IconButton(onClick = onDelete) {
                Icon(
                    Icons.Filled.Delete,
                    contentDescription = "Delete",
                    tint = MaterialTheme.colorScheme.error.copy(alpha = 0.7f),
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    }
}

@Composable
fun EmptyStatePrompt(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    subtitle: String,
    buttonText: String,
    onAction: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(
                icon,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary.copy(alpha = 0.5f),
                modifier = Modifier.size(64.dp),
            )
            Spacer(Modifier.height(16.dp))
            Text(
                title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(20.dp))
            TextButton(onClick = onAction) {
                Text(buttonText, fontWeight = FontWeight.Bold)
            }
        }
    }
}

fun formatListItemTime(epochMs: Long): String {
    val date = Date(epochMs)
    val now = Date()
    val fmt = if (date.year == now.year && date.month == now.month && date.date == now.date) {
        SimpleDateFormat("h:mm a", Locale.getDefault())
    } else {
        SimpleDateFormat("MMM d", Locale.getDefault())
    }
    return fmt.format(date)
}
