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
import com.duochat.app.ui.AuthUiState
import com.duochat.app.ui.ChatScreen
import com.duochat.app.ui.DeniedScreen
import com.duochat.app.ui.DuoChatTheme
import com.duochat.app.ui.FatalScreen
import com.duochat.app.ui.LoadingScreen
import com.duochat.app.ui.LoginScreen

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
    val auth by viewModel.auth.collectAsStateWithLifecycle()
    val chat by viewModel.chat.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val authError by viewModel.authError.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()

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

    when (val current = auth) {
        is AuthUiState.Unconfigured -> FatalScreen(
            message = "Firebase is not configured for this build. Add the Firebase values " +
                "to local.properties or gradle.properties (see android/README).",
            signOut = viewModel::signOut,
        )

        is AuthUiState.SignedOut -> LoginScreen(
            busy = busy,
            error = authError,
            onSignIn = viewModel::signIn,
        )

        is AuthUiState.Loading -> LoadingScreen(
            message = current.email?.let { "Checking access for $it…" } ?: "Checking access…",
        )

        is AuthUiState.Denied -> DeniedScreen(
            reason = current.reason,
            uid = current.uid,
            email = current.email,
            signOut = viewModel::signOut,
        )

        is AuthUiState.SignedIn -> {
            val state = chat
            when {
                state == null -> LoadingScreen("Starting DuoChat…")
                state.phase == EnginePhase.STOPPED -> LoadingScreen("Starting DuoChat…")
                state.phase == EnginePhase.ERROR -> FatalScreen(
                    message = state.error ?: "The chat engine could not start.",
                    signOut = viewModel::signOut,
                )

                else -> ChatScreen(
                    signedIn = current,
                    state = state,
                    settings = settings,
                    onSignOut = viewModel::signOut,
                    onSend = viewModel::send,
                    onRetry = viewModel::retry,
                    onLoadOlder = viewModel::loadOlder,
                    onClearNotice = viewModel::clearNotice,
                    onConfirmPeer = viewModel::confirmPeer,
                    onReconnect = viewModel::requestDirectConnection,
                    onCancelManual = viewModel::cancelManual,
                    onChangeDisplayName = viewModel::changeDisplayName,
                    onClearLocalData = viewModel::clearLocalData,
                    onUpdateSettings = viewModel::updateSettings,
                    onCreateManualOffer = viewModel::createManualOffer,
                    onApplyManualAnswer = viewModel::applyManualAnswer,
                    onAcceptManualOffer = viewModel::acceptManualOffer,
                )
            }
        }
    }
}
