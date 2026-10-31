package com.duochat.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.duochat.app.data.EnginePhase
import com.duochat.app.ui.AddFriendScreen
import com.duochat.app.ui.AppViewModel
import com.duochat.app.ui.ChatScreen
import com.duochat.app.ui.DuoChatTheme
import com.duochat.app.ui.FatalScreen
import com.duochat.app.ui.FriendDetailsDialog
import com.duochat.app.ui.GroupDetailsScreen
import com.duochat.app.ui.HomeScreen
import com.duochat.app.ui.LoadingScreen
import com.duochat.app.ui.ManualConnectDialog
import com.duochat.app.ui.NewGroupScreen
import com.duochat.app.ui.NukeDialog
import com.duochat.app.ui.OnboardingScreen
import com.duochat.app.ui.SettingsDialog

class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val viewModel: AppViewModel = viewModel()
            val settings by viewModel.settings.collectAsStateWithLifecycle()
            DuoChatTheme(settings) {
                Surface(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                    RootScreen(viewModel)
                }
            }
        }
    }
}

// Where the user is, as plain text so it survives process death and rotation:
// "home", "add", "newgroup", "chat:<id>" (friend or group chat), "group:<groupId>" (details).
private const val HOME = "home"

@Composable
private fun RootScreen(viewModel: AppViewModel) {
    val chat by viewModel.chat.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val killSwitchReport by viewModel.killSwitchReport.collectAsStateWithLifecycle()
    val locked by viewModel.locked.collectAsStateWithLifecycle()
    val context = LocalContext.current

    var route by rememberSaveable { mutableStateOf(HOME) }
    var settingsOpen by rememberSaveable { mutableStateOf(false) }
    var manualOpen by rememberSaveable { mutableStateOf(false) }
    var nukeOpen by rememberSaveable { mutableStateOf(false) }
    var panic by remember { mutableStateOf(false) }
    var channelsOpen by rememberSaveable { mutableStateOf(false) }
    var friendDialog by rememberSaveable { mutableStateOf<String?>(null) }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> { viewModel.onEntered(); viewModel.setVisible(true) }
                Lifecycle.Event.ON_STOP -> { viewModel.onLeft(); viewModel.setVisible(false) }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) viewModel.updateSettings { copy(notificationsEnabled = true) }
    }
    val requestNotifications = {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            viewModel.updateSettings { copy(notificationsEnabled = true) }
        }
    }

    val state = chat
    // Tell the engine which conversation is on screen (it marks messages read and stays quiet about them).
    val openChatId = route.takeIf { it.startsWith("chat:") }?.removePrefix("chat:")
    LaunchedEffect(openChatId, state?.phase) { if (state?.phase == EnginePhase.READY) viewModel.setOpenChat(openChatId) }

    // Ask for notification permission once the first friend exists (never before there is anything to be told about).
    val hasFriends = state?.contacts?.isNotEmpty() == true
    LaunchedEffect(hasFriends) {
        if (hasFriends && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    // Somebody typed our six words and answered: we confirm who it is before adding them.
    state?.requests?.firstOrNull()?.let { request ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { viewModel.dismissRequest(request.uid) },
            title = { androidx.compose.material3.Text("${request.name} used your invite") },
            text = {
                androidx.compose.material3.Text(
                    "Only add them if you expected this. To be sure it is really them, read these numbers to ${request.name} on a call or in person; they should see the same ones.\n\n${request.safetyNumber}",
                )
            },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = { viewModel.acceptRequest(request.uid) { r -> r.onSuccess { route = "chat:$it" } } }) {
                    androidx.compose.material3.Text("Add ${request.name}")
                }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { viewModel.dismissRequest(request.uid) }) { androidx.compose.material3.Text("Not them") }
            },
        )
    }

    when {
        locked -> com.duochat.app.ui.LockScreen(onUnlocked = viewModel::unlock)

        state == null || state.phase == EnginePhase.STOPPED || state.phase == EnginePhase.STARTING ->
            LoadingScreen("Opening your encrypted local data…")

        state.phase == EnginePhase.NEEDS_IDENTITY -> OnboardingScreen(onCreate = viewModel::createIdentity)

        state.phase == EnginePhase.ERROR -> FatalScreen(
            message = state.error ?: "The chat engine could not start.",
            onRetry = viewModel::startEngine,
        )

        else -> {
            // A chat or group that no longer exists sends the user home instead of showing an empty screen.
            val missing = when {
                route.startsWith("chat:") -> state.contacts.none { it.uid == openChatId } && state.groups.none { it.groupId == openChatId } &&
                    state.channels.none { it.id == openChatId }
                route.startsWith("group:") -> state.groups.none { it.groupId == route.removePrefix("group:") }
                else -> false
            }
            if (missing) route = HOME
            val back = { route = HOME }

            when {
                route == "add" -> {
                    BackHandler(onBack = back)
                    AddFriendScreen(
                        state = state,
                        ownCard = viewModel::ownCard,
                        onAdd = viewModel::addFriend,
                        onCreateInvite = viewModel::createInvite,
                        onRetryAnswer = viewModel::retryAnswer,
                        onClearAnswer = viewModel::clearAnswer,
                        onChecked = viewModel::markChecked,
                        onBack = back,
                        onOpenChat = { route = "chat:$it" },
                    )
                }

                route == "newgroup" -> {
                    BackHandler(onBack = back)
                    NewGroupScreen(
                        state = state,
                        onCreate = viewModel::createGroup,
                        onBack = back,
                        onCreated = { route = "chat:$it" },
                    )
                }

                route.startsWith("group:") -> {
                    val id = route.removePrefix("group:")
                    BackHandler { route = "chat:$id" }
                    GroupDetailsScreen(
                        state = state,
                        groupId = id,
                        onBack = { route = "chat:$id" },
                        onAddMembers = { uids, done -> viewModel.addToGroup(id, uids, done) },
                        onRemove = { uid, done -> viewModel.removeFromGroup(id, uid, done) },
                        onRename = { name, done -> viewModel.renameGroup(id, name, done) },
                        onLeave = { done -> viewModel.leaveGroup(id, done) },
                        onVerify = { friendDialog = it },
                        onMessage = { route = "chat:$it" },
                        onLeft = { route = "chat:$id" },
                    )
                }

                openChatId != null -> {
                    BackHandler(onBack = back)
                    val isGroup = state.groups.any { it.groupId == openChatId }
                    ChatScreen(
                        state = state,
                        conversationId = openChatId,
                        muted = openChatId in settings.mutedChats,
                        onBack = back,
                        onSend = { text, replyToId, done -> viewModel.send(openChatId, text, replyToId, done) },
                        onSendFile = { name, mime, bytes, replyToId, done -> viewModel.sendFile(openChatId, name, mime, bytes, replyToId, done) },
                        loadFile = { id -> viewModel.getFile(id) },
                        onRetry = viewModel::retry,
                        onClearNotice = viewModel::clearNotice,
                        onOpenDetails = { if (isGroup) route = "group:$openChatId" else friendDialog = openChatId },
                        onVerify = { friendDialog = openChatId },
                        onToggleMute = { viewModel.toggleMute(openChatId) },
                        onClearChat = { viewModel.clearChat(openChatId) },
                        onLeaveChannel = { viewModel.leaveChannel(openChatId); route = HOME },
                        onMuteSender = viewModel::muteSender,
                        onDeleteMessage = viewModel::deleteMessage,
                        onReact = viewModel::react,
                        onEnableStoreForward = { viewModel.updateSettings { copy(network = network.copy(storeForward = true)) } },
                        onOpenConnectionSettings = { settingsOpen = true },
                        onConnectBluetooth = {
                            viewModel.connectBluetooth(openChatId) { result ->
                                result.exceptionOrNull()?.message?.let { settingsOpen = true; android.widget.Toast.makeText(context, it, android.widget.Toast.LENGTH_LONG).show() }
                            }
                        },
                    )
                }

                else -> HomeScreen(
                    state = state,
                    onOpenChat = { route = "chat:${it.id}" },
                    onAddFriend = { route = "add" },
                    onNewGroup = { route = "newgroup" },
                    onChannels = { channelsOpen = true },
                    onOpenSettings = { settingsOpen = true },
                    onClearNotice = viewModel::clearNotice,
                    onSearch = viewModel::search,
                    onPanic = if (settings.panicWipe) ({ panic = true; nukeOpen = true }) else null,
                    onOpenConversation = { route = "chat:$it" },
                )
            }

            if (channelsOpen) {
                com.duochat.app.ui.ChannelsDialog(
                    channels = state.channels,
                    onJoin = viewModel::joinChannel,
                    onLeave = { id -> viewModel.leaveChannel(id); if (route == "chat:$id") route = HOME },
                    onOpen = { id -> route = "chat:$id" },
                    onDismiss = { channelsOpen = false },
                )
            }

            friendDialog?.let { uid ->
                val friend = state.contacts.firstOrNull { it.uid == uid }
                if (friend == null) {
                    friendDialog = null
                } else {
                    FriendDetailsDialog(
                        friend = friend,
                        onDismiss = { friendDialog = null },
                        onRename = { viewModel.renameFriend(uid, it) },
                        onChecked = { viewModel.markChecked(uid) },
                        onRemove = { done -> viewModel.removeFriend(uid) { r -> r.onSuccess { route = HOME }; done(r) } },
                    )
                }
            }

            if (settingsOpen) {
                SettingsDialog(
                    state = state,
                    settings = settings,
                    onDismiss = { settingsOpen = false },
                    onRequestNotifications = requestNotifications,
                    onUpdateSettings = viewModel::updateSettings,
                    onClearLocalData = viewModel::clearLocalData,
                    onOpenManual = {
                        settingsOpen = false
                        manualOpen = true
                    },
                    onOpenNuke = { nukeOpen = true },
                    onBluetoothPermissionResult = viewModel::refreshBluetooth,
                    onExportBackup = viewModel::exportBackup,
                    onImportBackup = viewModel::importBackup,
                )
            }

            if (manualOpen) {
                ManualConnectDialog(
                    state = state,
                    onDismiss = {
                        if (!state.manual.connected) viewModel.cancelManual()
                        manualOpen = false
                    },
                    onConfirmPeer = {
                        viewModel.confirmManual()
                        manualOpen = false
                    },
                    onCreateOffer = viewModel::createManualOffer,
                    onApplyAnswer = viewModel::applyManualAnswer,
                    onAcceptOffer = viewModel::acceptManualOffer,
                )
            }
        }
    }

    if (nukeOpen || killSwitchReport != null) {
        NukeDialog(
            autoRun = panic,
            onDismiss = { nukeOpen = false },
            onRun = { viewModel.runNuke() },
            report = killSwitchReport,
            onDone = {
                nukeOpen = false
                panic = false
                route = HOME
                viewModel.acknowledgeKillSwitch()
            },
        )
    }
}
