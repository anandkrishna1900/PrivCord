package com.duochat.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.duochat.app.data.MAX_GROUP_MEMBERS
import com.duochat.app.data.ChatState
import com.duochat.app.data.ContactTrust
import com.duochat.app.data.ContactView
import com.duochat.app.data.LinkStatus
import com.duochat.app.data.MemberView

/** Name + choose friends + Create. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewGroupScreen(
    state: ChatState,
    onCreate: (String, List<String>, (Result<String>) -> Unit) -> Unit,
    onBack: () -> Unit,
    onCreated: (String) -> Unit,
) {
    var name by rememberSaveable { mutableStateOf("") }
    val chosen = remember { mutableStateListOf<String>() }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                title = { Text("New group") },
            )
        },
        bottomBar = {
            Column(Modifier.fillMaxWidth().padding(12.dp)) {
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(bottom = 6.dp)) }
                Button(
                    onClick = {
                        busy = true
                        error = null
                        onCreate(name, chosen.toList()) { result ->
                            busy = false
                            result.onSuccess(onCreated).onFailure { error = it.message ?: "Could not create the group." }
                        }
                    },
                    enabled = name.isNotBlank() && !busy,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (chosen.isEmpty()) "Create group" else "Create group with ${chosen.size} ${if (chosen.size == 1) "friend" else "friends"}")
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(60) },
                label = { Text("Group name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(16.dp),
            )
            Text(
                "Choose friends",
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
            if (state.contacts.isEmpty()) {
                Text(
                    "You have no friends yet. Add a friend first, then come back.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(16.dp),
                )
            } else {
                Text(
                    "Up to $MAX_GROUP_MEMBERS people per group, including you. Friends of your friends can join and will connect to you automatically.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
                LazyColumn(Modifier.weight(1f)) {
                    items(state.contacts.filter { it.direct }, key = { it.uid }) { friend ->
                        val full = friend.uid !in chosen && chosen.size >= MAX_GROUP_MEMBERS - 1
                        FriendCheckRow(friend, friend.uid in chosen, enabled = !full, note = if (full) "Groups have at most $MAX_GROUP_MEMBERS people" else null) { checked ->
                            if (checked) chosen.add(friend.uid) else chosen.remove(friend.uid)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FriendCheckRow(friend: ContactView, checked: Boolean, enabled: Boolean = true, note: String? = null, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(enabled = enabled) { onChange(!checked) }.padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        InitialsAvatar(friend.name, 40, online = friend.link == LinkStatus.CONNECTED)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(friend.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Checkbox(checked = checked, onCheckedChange = if (enabled) onChange else null, enabled = enabled)
    }
}

/** Members with "added by", add member, leave; the admin can rename and remove. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GroupDetailsScreen(
    state: ChatState,
    groupId: String,
    onBack: () -> Unit,
    onAddMembers: (List<String>, (Result<Unit>) -> Unit) -> Unit,
    onRemove: (String, (Result<Unit>) -> Unit) -> Unit,
    onRename: (String, (Result<Unit>) -> Unit) -> Unit,
    onLeave: ((Result<Unit>) -> Unit) -> Unit,
    onVerify: (String) -> Unit,
    onMessage: (String) -> Unit,
    onLeft: () -> Unit,
) {
    val group = state.groups.firstOrNull { it.groupId == groupId }
    var picking by remember { mutableStateOf(false) }
    var leaving by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<MemberView?>(null) }
    var message by remember { mutableStateOf<String?>(null) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                title = { Text(group?.name ?: "Group", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                actions = {
                    if (group?.iAmAdmin == true && group.iAmMember) {
                        IconButton(onClick = { renaming = true }) { Icon(Icons.Filled.Edit, contentDescription = "Rename group") }
                    }
                },
            )
        },
    ) { padding ->
        if (group == null) {
            Text("This group is no longer available.", modifier = Modifier.padding(padding).padding(16.dp))
            return@Scaffold
        }
        LazyColumn(Modifier.fillMaxSize().padding(padding)) {
            item {
                Text(
                    group.exitNote ?: "${group.members.size} of ${group.maxMembers} members",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(16.dp),
                )
                message?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp)) }
                if (group.iAmMember && group.full) {
                    Text(
                        "This group is full (${group.maxMembers} people is the limit).",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                } else if (group.iAmMember) {
                    Row(
                        Modifier.fillMaxWidth().clickable { picking = true }.padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.PersonAdd, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.width(16.dp))
                        Text("Add member", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary)
                    }
                    HorizontalDivider()
                }
            }
            items(group.members, key = { it.uid }) { member ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    InitialsAvatar(member.name, 42, online = member.link == LinkStatus.CONNECTED)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(if (member.isMe) "You" else member.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                        val sub = buildList {
                            if (member.isAdmin) add("Admin")
                            member.addedByName?.let { add("Added by $it") }
                            if (!member.isMe) add(
                                when (member.link) {
                                    LinkStatus.CONNECTED -> "Connected"
                                    LinkStatus.CONNECTING -> "Connecting…"
                                    else -> "Not connected"
                                },
                            )
                        }.joinToString(" · ")
                        Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        val contact = state.contacts.firstOrNull { it.uid == member.uid }
                        if (contact != null && contact.trust == ContactTrust.INTRODUCED && !contact.checked) {
                            Text(
                                "Introduced by ${contact.introducedByName ?: "a group member"} · Verify",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.clickable { onVerify(member.uid) },
                            )
                        }
                        if (!member.isMe && !member.canMessage) {
                            Text(
                                "Group only: no direct chat unless you swap invites",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    if (!member.isMe && member.canMessage) {
                        TextButton(onClick = { onMessage(member.uid) }) { Text("Message") }
                    }
                    if (group.iAmAdmin && group.iAmMember && !member.isMe) {
                        TextButton(onClick = { removing = member }) { Text("Remove", color = MaterialTheme.colorScheme.error) }
                    }
                }
            }
            if (group.iAmMember) {
                item {
                    Spacer(Modifier.height(16.dp))
                    OutlinedButton(onClick = { leaving = true }, modifier = Modifier.padding(horizontal = 16.dp).fillMaxWidth()) {
                        Text("Leave group", color = MaterialTheme.colorScheme.error)
                    }
                    Spacer(Modifier.height(24.dp))
                }
            }
        }

        if (picking) {
            val inGroup = group.members.map { it.uid }.toSet()
            val candidates = state.contacts.filter { it.uid !in inGroup && it.direct }
            val room = (group.maxMembers - group.members.size).coerceAtLeast(0)
            val chosen = remember { mutableStateListOf<String>() }
            AlertDialog(
                onDismissRequest = { picking = false },
                title = { Text("Add member") },
                text = {
                    if (candidates.isEmpty()) {
                        Text("All your friends are already in this group. Add a friend first from the home screen.")
                    } else {
                        Column(Modifier.verticalScroll(rememberScrollState())) {
                            candidates.forEach { friend ->
                                FriendCheckRow(friend, friend.uid in chosen, enabled = friend.uid in chosen || chosen.size < room) { checked ->
                                    if (checked) chosen.add(friend.uid) else chosen.remove(friend.uid)
                                }
                            }
                        }
                    }
                },
                confirmButton = {
                    TextButton(
                        enabled = chosen.isNotEmpty(),
                        onClick = {
                            val ids = chosen.toList()
                            picking = false
                            onAddMembers(ids) { result -> message = result.exceptionOrNull()?.message }
                        },
                    ) { Text("Add") }
                },
                dismissButton = { TextButton(onClick = { picking = false }) { Text("Cancel") } },
            )
        }
        if (leaving) {
            AlertDialog(
                onDismissRequest = { leaving = false },
                title = { Text("Leave \"${group.name}\"?") },
                text = { Text("You will stop receiving messages from this group. You keep the old messages on this phone.") },
                confirmButton = {
                    TextButton(onClick = {
                        leaving = false
                        onLeave { result -> result.onSuccess { onLeft() }.onFailure { message = it.message } }
                    }) { Text("Leave", color = MaterialTheme.colorScheme.error) }
                },
                dismissButton = { TextButton(onClick = { leaving = false }) { Text("Cancel") } },
            )
        }
        removing?.let { member ->
            AlertDialog(
                onDismissRequest = { removing = null },
                title = { Text("Remove ${member.name}?") },
                text = { Text("They will stop receiving new messages. They keep what they already got.") },
                confirmButton = {
                    TextButton(onClick = {
                        removing = null
                        onRemove(member.uid) { result -> message = result.exceptionOrNull()?.message }
                    }) { Text("Remove", color = MaterialTheme.colorScheme.error) }
                },
                dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
            )
        }
        if (renaming) {
            var newName by remember { mutableStateOf(group.name) }
            AlertDialog(
                onDismissRequest = { renaming = false },
                title = { Text("Rename group") },
                text = { OutlinedTextField(value = newName, onValueChange = { newName = it.take(60) }, singleLine = true) },
                confirmButton = {
                    TextButton(enabled = newName.isNotBlank(), onClick = {
                        renaming = false
                        onRename(newName) { result -> message = result.exceptionOrNull()?.message }
                    }) { Text("Save") }
                },
                dismissButton = { TextButton(onClick = { renaming = false }) { Text("Cancel") } },
            )
        }
    }
}

/** A friend: rename, check it's really them, remove. */
@Composable
fun FriendDetailsDialog(
    friend: ContactView,
    onDismiss: () -> Unit,
    onRename: (String) -> Unit,
    onChecked: () -> Unit,
    onRemove: ((Result<Unit>) -> Unit) -> Unit,
) {
    var name by remember(friend.uid) { mutableStateOf(friend.name) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmRemove by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(friend.name) },
        text = {
            Column {
                if (friend.trust == ContactTrust.INTRODUCED) {
                    Text(
                        "Introduced by ${friend.introducedByName ?: "a group member"}. Nobody has checked this person yet.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                }
                OutlinedTextField(value = name, onValueChange = { name = it.take(40) }, label = { Text("Name") }, singleLine = true)
                Spacer(Modifier.height(12.dp))
                Text(
                    if (friend.checked) "You checked these numbers." else "Check it's really them: their numbers must match yours.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(6.dp))
                SafetyNumberBox(friend.safetyNumber)
                if (!friend.checked) {
                    TextButton(onClick = onChecked) { Text("The numbers match") }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (confirmRemove) {
                    Text("Remove ${friend.name} and delete this chat from the phone?", style = MaterialTheme.typography.bodyMedium)
                    Row {
                        TextButton(onClick = {
                            onRemove { result -> result.onSuccess { onDismiss() }.onFailure { error = it.message; confirmRemove = false } }
                        }) { Text("Remove", color = MaterialTheme.colorScheme.error) }
                        TextButton(onClick = { confirmRemove = false }) { Text("Cancel") }
                    }
                } else {
                    TextButton(onClick = { confirmRemove = true }) { Text("Remove friend", color = MaterialTheme.colorScheme.error) }
                }
            }
        },
        confirmButton = { TextButton(onClick = { if (name.isNotBlank() && name != friend.name) onRename(name); onDismiss() }) { Text("Done") } },
    )
}
