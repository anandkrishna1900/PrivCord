package com.duochat.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.duochat.app.data.EnginePhase
import com.duochat.app.ui.AppViewModel
import com.duochat.app.ui.ChatScreen
import com.duochat.app.ui.DuoChatTheme
import com.duochat.app.ui.FatalScreen
import com.duochat.app.ui.LoadingScreen
import com.duochat.app.ui.OnboardingScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val viewModel: AppViewModel = viewModel()
            val settings by viewModel.settings.collectAsStateWithLifecycle()
            DuoChatTheme(settings) {
                Surface(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.background),
                ) {
                    RootScreen(viewModel)
                }
            }
        }
    }
}

@Composable
private fun RootScreen(viewModel: AppViewModel) {
    val chat by viewModel.chat.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val killSwitchReport by viewModel.killSwitchReport.collectAsStateWithLifecycle()

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> viewModel.setVisible(true)
                Lifecycle.Event.ON_STOP -> viewModel.setVisible(false)
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val state = chat
    when {
        state == null || state.phase == EnginePhase.STOPPED ||
            state.phase == EnginePhase.STARTING -> LoadingScreen("Opening your encrypted local conversation…")

        state.phase == EnginePhase.NEEDS_IDENTITY -> OnboardingScreen(onCreate = viewModel::createIdentity)

        state.phase == EnginePhase.ERROR -> FatalScreen(
            message = state.error ?: "The chat engine could not start.",
            onRetry = viewModel::startEngine,
        )

        else -> ChatScreen(
            state = state,
            settings = settings,
            onSend = viewModel::send,
            onRetry = viewModel::retry,
            onClearNotice = viewModel::clearNotice,
            onConfirmPeer = viewModel::confirmPeer,
            onOwnCard = viewModel::ownCard,
            onPreviewContact = viewModel::previewContact,
            onConfirmContact = viewModel::confirmContact,
            onCancelContact = viewModel::cancelContact,
            onCancelManual = viewModel::cancelManual,
            onResetPairing = viewModel::resetPairing,
            onClearLocalData = viewModel::clearLocalData,
            onUpdateSettings = viewModel::updateSettings,
            onCreateManualOffer = viewModel::createManualOffer,
            onApplyManualAnswer = viewModel::applyManualAnswer,
            onAcceptManualOffer = viewModel::acceptManualOffer,
            onConnectBluetooth = viewModel::connectBluetooth,
            onBluetoothPermissionResult = viewModel::refreshBluetooth,
            onRunNuke = viewModel::runNuke,
            onRunChatSwitch = viewModel::runChatSwitch,
            killSwitchReport = killSwitchReport,
            onAcknowledgeKillSwitch = viewModel::acknowledgeKillSwitch,
        )
    }
}
