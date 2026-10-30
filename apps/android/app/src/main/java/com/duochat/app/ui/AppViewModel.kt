package com.duochat.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.room.Room
import com.duochat.app.AppConfig
import com.duochat.app.data.AppSettings
import com.duochat.app.data.ChatState
import com.duochat.app.data.CloudRepository
import com.duochat.app.data.MessageMode
import com.duochat.app.data.MessageStore
import com.duochat.app.data.SettingsRepository
import com.duochat.app.data.local.DuoDatabase
import com.duochat.app.engine.ChatEngine
import com.duochat.app.notifications.DuoNotifications
import com.duochat.app.security.AndroidIdentityManager
import com.duochat.app.security.LocalCrypto
import kotlinx.coroutines.tasks.await
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.FirebaseUser
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed class AuthUiState {
    data object Unconfigured : AuthUiState()
    data class Loading(val email: String?) : AuthUiState()
    data object SignedOut : AuthUiState()
    data class Denied(
        val uid: String,
        val email: String?,
        val reason: String,
    ) : AuthUiState()

    data class SignedIn(
        val uid: String,
        val email: String?,
        val displayName: String?,
        val peerUid: String,
        val conversationId: String,
    ) : AuthUiState()
}

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = CloudRepository()
    private val settingsRepository = SettingsRepository(application)
    private val identityManager = AndroidIdentityManager(application)
    private val database by lazy {
        Room.databaseBuilder(application, DuoDatabase::class.java, "duochat.db")
            .addMigrations(DuoDatabase.MIGRATION_1_2)
            .build()
    }

    private val killSwitchExecutor by lazy {
        com.duochat.app.security.KillSwitchExecutor(
            application,
            AppConfig.conversationId,
        ) { database }
    }

    private val _killSwitchReport =
        MutableStateFlow<com.duochat.app.security.KillSwitchReport?>(null)
    val killSwitchReport: StateFlow<com.duochat.app.security.KillSwitchReport?> =
        _killSwitchReport.asStateFlow()

    val settings: StateFlow<AppSettings> = settingsRepository.settings

    private val _auth = MutableStateFlow<AuthUiState>(
        if (AppConfig.firebaseReady) AuthUiState.Loading(null) else AuthUiState.Unconfigured,
    )
    val auth: StateFlow<AuthUiState> = _auth.asStateFlow()

    private val _chat = MutableStateFlow<ChatState?>(null)
    val chat: StateFlow<ChatState?> = _chat.asStateFlow()

    private val _authError = MutableStateFlow<String?>(null)
    val authError: StateFlow<String?> = _authError.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private var engine: ChatEngine? = null
    private var startJob: Job? = null
    private var stateJob: Job? = null
    private var authListener: FirebaseAuth.AuthStateListener? = null
    private var verifying = false
    private var visible = false

    init {
        if (AppConfig.firebaseReady) {
            val listener = FirebaseAuth.AuthStateListener { auth ->
                handleAuthState(auth.currentUser)
            }
            authListener = listener
            FirebaseAuth.getInstance().addAuthStateListener(listener)
        }
    }

    private fun handleAuthState(user: FirebaseUser?) {
        if (user == null) {
            stopEngine()
            _auth.value = AuthUiState.SignedOut
            return
        }
        val existing = _auth.value
        if (
            existing is AuthUiState.SignedIn &&
            existing.uid == user.uid &&
            engine != null
        ) {
            return
        }
        if (verifying) return
        verifying = true
        _auth.value = AuthUiState.Loading(user.email)
        _authError.value = null
        viewModelScope.launch {
            try {
                val access = repository.loadAccess(AppConfig.conversationId)
                if (user.uid !in access.memberIds) {
                    stopEngine()
                    _auth.value = AuthUiState.Denied(
                        uid = user.uid,
                        email = user.email,
                        reason = "This account is not one of the two approved conversation members.",
                    )
                    return@launch
                }
                val peerUid = if (access.memberIds[0] == user.uid) {
                    access.memberIds[1]
                } else {
                    access.memberIds[0]
                }
                _auth.value = AuthUiState.SignedIn(
                    uid = user.uid,
                    email = user.email,
                    displayName = user.displayName,
                    peerUid = peerUid,
                    conversationId = access.conversationId,
                )
                startEngine(user, peerUid, access.conversationId)
            } catch (error: Exception) {
                stopEngine()
                _auth.value = AuthUiState.Denied(
                    uid = user.uid,
                    email = user.email,
                    reason = error.message ?: "Could not verify access to the conversation.",
                )
            } finally {
                verifying = false
            }
        }
    }

    private fun startEngine(user: FirebaseUser, peerUid: String, conversationId: String) {
        stopEngine()
        val application = getApplication<Application>()
        val crypto = LocalCrypto(application, user.uid)
        val store = MessageStore(database.dao(), crypto)
        val created = ChatEngine(
            scope = viewModelScope,
            uid = user.uid,
            peerUid = peerUid,
            conversationId = conversationId,
            email = user.email.orEmpty(),
            displayName = user.displayName.orEmpty(),
            store = store,
            repository = repository,
            identityManager = identityManager,
            initialMessageMode = settingsRepository.settings.value.messageMode,
            onNotify = { message ->
                if (!visible) {
                    DuoNotifications.showIncoming(
                        application,
                        message,
                        _chat.value?.peerProfile?.displayName ?: "Your friend",
                        settingsRepository.settings.value,
                    )
                }
            },
        )
        engine = created
        stateJob = viewModelScope.launch {
            created.state.collect { _chat.value = it }
        }
        startJob = viewModelScope.launch { created.start() }
    }

    private fun stopEngine() {
        startJob?.cancel()
        stateJob?.cancel()
        startJob = null
        stateJob = null
        engine?.stop()
        engine = null
        _chat.value = null
    }

    fun signIn(email: String, password: String) {
        if (!AppConfig.firebaseReady) {
            _authError.value = "Firebase configuration is missing."
            return
        }
        viewModelScope.launch {
            _busy.value = true
            _authError.value = null
            try {
                FirebaseAuth.getInstance()
                    .signInWithEmailAndPassword(email.trim(), password)
                    .await()
            } catch (error: Exception) {
                _authError.value = friendlyAuthError(error)
            } finally {
                _busy.value = false
            }
        }
    }

    fun signOut() {
        if (AppConfig.firebaseReady) {
            FirebaseAuth.getInstance().signOut()
        }
        stopEngine()
        _auth.value = if (AppConfig.firebaseReady) {
            AuthUiState.SignedOut
        } else {
            AuthUiState.Unconfigured
        }
    }

    fun setVisible(isVisible: Boolean) {
        visible = isVisible
        engine?.setVisible(isVisible)
    }

    fun clearAuthError() {
        _authError.value = null
    }

    fun updateSettings(patch: AppSettings.() -> AppSettings) {
        settingsRepository.update(patch)
    }

    fun setMessageMode(mode: MessageMode) {
        settingsRepository.update { copy(messageMode = mode) }
        engine?.setMessageMode(mode)
    }

    fun send(text: String, onResult: (Result<Unit>) -> Unit) {
        val current = engine ?: run {
            onResult(Result.failure(IllegalStateException("Chat is not ready.")))
            return
        }
        viewModelScope.launch { onResult(current.send(text)) }
    }

    fun retry(messageId: String) {
        viewModelScope.launch { engine?.retry(messageId) }
    }

    fun loadOlder() {
        viewModelScope.launch { engine?.loadOlder() }
    }

    fun clearNotice() {
        engine?.clearNotice()
    }

    fun confirmPeer() {
        engine?.confirmPeer()
    }

    fun requestDirectConnection() {
        engine?.requestDirectConnection()
    }

    fun cancelManual() {
        engine?.cancelManual()
    }

    fun createManualOffer(onResult: (Result<String>) -> Unit) {
        val current = engine ?: run {
            onResult(Result.failure(IllegalStateException("Chat is not ready.")))
            return
        }
        viewModelScope.launch {
            onResult(runCatching { current.createManualOffer() })
        }
    }

    fun applyManualAnswer(code: String, onResult: (Result<Unit>) -> Unit) {
        val current = engine ?: run {
            onResult(Result.failure(IllegalStateException("Chat is not ready.")))
            return
        }
        viewModelScope.launch {
            onResult(runCatching { current.applyManualAnswer(code) })
        }
    }

    fun acceptManualOffer(code: String, onResult: (Result<String>) -> Unit) {
        val current = engine ?: run {
            onResult(Result.failure(IllegalStateException("Chat is not ready.")))
            return
        }
        viewModelScope.launch {
            onResult(runCatching { current.acceptManualOffer(code) })
        }
    }

    fun changeDisplayName(name: String, onResult: (Result<Unit>) -> Unit) {
        val current = engine ?: run {
            onResult(Result.failure(IllegalStateException("Chat is not ready.")))
            return
        }
        viewModelScope.launch {
            onResult(runCatching { current.changeDisplayName(name) })
        }
    }

    fun clearLocalData(onResult: (Result<Unit>) -> Unit) {
        val current = engine ?: run {
            onResult(Result.failure(IllegalStateException("Chat is not ready.")))
            return
        }
        viewModelScope.launch {
            onResult(runCatching { current.clearLocalData() })
        }
    }

    /**
     * App-wide emergency kill switch ("NUKE DUOCHAT"). Never deletes the
     * account on the server; erases all local DuoChat data and returns the
     * app to the sign-in (onboarding) screen. The honest report is exposed
     * through [killSwitchReport] until acknowledged.
     */
    fun runNuke() {
        val application = getApplication<Application>()
        val user = FirebaseAuth.getInstance().currentUser
        if (user == null) {
            _killSwitchReport.value = null
            return
        }
        viewModelScope.launch {
            // Stop all networking before anything is erased.
            engine?.stop()
            try {
                val report = killSwitchExecutor.execute(
                    scope = com.duochat.app.security.KillSwitchScope.APPLICATION,
                    mode = com.duochat.app.security.KillSwitchMode.LOCAL_ONLY,
                    hooks = com.duochat.app.security.AppWideHooks(
                        context = application,
                        conversationId = AppConfig.conversationId,
                        databaseProvider = { database },
                        identityManager = identityManager,
                        uid = user.uid,
                    ),
                )
                _killSwitchReport.value = report
            } finally {
                // Regardless of partial failures, drop the authenticated
                // session so the app lands on onboarding. Crypto state is
                // erased (or reported as failed); re-signing in creates a
                // fresh device identity.
                FirebaseAuth.getInstance().signOut()
                stopEngine()
                _auth.value = if (AppConfig.firebaseReady) {
                    AuthUiState.SignedOut
                } else {
                    AuthUiState.Unconfigured
                }
            }
        }
    }

    /** Removes the completed kill-switch report after the user reads it. */
    fun acknowledgeKillSwitch() {
        killSwitchExecutor.clearReportFile()
        _killSwitchReport.value = null
    }

    /**
     * Per-conversation kill switch. Option A ("CLEAR LOCAL CHAT") erases this
     * conversation's local content only. Option B additionally erases this
     * chat's session-state on this device. Requires the erase engine paused to
     * prevent retries from repopulating the store, then restarts fresh.
     */
    fun runChatSwitch(
        withSessionState: Boolean,
        onResult: (Result<Boolean>) -> Unit,
    ) {
        val application = getApplication<Application>()
        val user = FirebaseAuth.getInstance().currentUser
        val mode = if (withSessionState) {
            com.duochat.app.security.KillSwitchMode.LOCAL_PLUS_SESSION_STATE
        } else {
            com.duochat.app.security.KillSwitchMode.LOCAL_ONLY
        }
        if (user == null) {
            onResult(Result.failure(IllegalStateException("Signed out.")))
            return
        }
        viewModelScope.launch {
            // Pause all delivery paths while erasing so cloud sync or direct
            // connections cannot repopulate the store mid-wipe.
            stopEngine()
            try {
                val report = killSwitchExecutor.execute(
                    scope = com.duochat.app.security.KillSwitchScope.CONVERSATION,
                    mode = mode,
                    hooks = com.duochat.app.security.ConversationHooks(
                        conversationId = AppConfig.conversationId,
                        databaseProvider = { database },
                        identityManager = identityManager,
                        uid = user.uid,
                    ),
                )
                _killSwitchReport.value = report
                val summary = com.duochat.app.security.summarizeReport(report)
                onResult(Result.success(summary.complete))
                // Restart the engine fresh, regardless of partial completion.
                startEngine(user, _auth.value.let { state ->
                    (state as? AuthUiState.SignedIn)?.peerUid ?: ""
                }, (stateConversationIdOrNull() ?: AppConfig.conversationId))
            } catch (error: Exception) {
                onResult(Result.failure(error))
            }
        }
    }

    private fun stateConversationIdOrNull(): String? =
        (_auth.value as? AuthUiState.SignedIn)?.conversationId

    override fun onCleared() {
        authListener?.let { FirebaseAuth.getInstance().removeAuthStateListener(it) }
        stopEngine()
        super.onCleared()
    }

    private fun friendlyAuthError(error: Exception): String {
        val code = (error as? FirebaseAuthException)?.errorCode.orEmpty()
        return when (code) {
            "ERROR_INVALID_CREDENTIAL",
            "ERROR_WRONG_PASSWORD",
            "ERROR_USER_NOT_FOUND",
            -> "Email or password is incorrect."

            "ERROR_TOO_MANY_REQUESTS" ->
                "Too many attempts. Wait a few minutes and try again."

            "ERROR_NETWORK_REQUEST_FAILED" ->
                "Network unavailable. Check your connection and try again."

            "ERROR_OPERATION_NOT_ALLOWED" ->
                "Email/password sign-in is disabled in Firebase Authentication."

            "ERROR_USER_DISABLED" -> "This account has been disabled."
            else -> error.message ?: "Sign-in failed."
        }
    }
}
