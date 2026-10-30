package com.duochat.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.room.Room
import com.duochat.app.AppConfig
import com.duochat.app.data.AppSettings
import com.duochat.app.data.ChatState
import com.duochat.app.data.MessageStore
import com.duochat.app.data.SettingsRepository
import com.duochat.app.data.local.DuoDatabase
import com.duochat.app.engine.ChatEngine
import com.duochat.app.notifications.DuoNotifications
import com.duochat.app.security.AndroidIdentityManager
import com.duochat.app.security.LOCAL_ID
import com.duochat.app.security.LocalCrypto
import android.net.ConnectivityManager
import android.net.Network
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import com.duochat.app.data.local.ContactEntity
import com.duochat.app.data.local.GroupEntity
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val settingsRepository = SettingsRepository(application)
    private val identityManager = AndroidIdentityManager(application)
    private val database by lazy {
        Room.databaseBuilder(application, DuoDatabase::class.java, "duochat.db")
            .addMigrations(DuoDatabase.MIGRATION_1_2, DuoDatabase.MIGRATION_2_3, DuoDatabase.MIGRATION_3_4)
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

    private val _chat = MutableStateFlow<ChatState?>(null)
    val chat: StateFlow<ChatState?> = _chat.asStateFlow()

    private var engine: ChatEngine? = null
    private var startJob: Job? = null
    private var stateJob: Job? = null
    private var visible = false

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            // A new network is a reason to retry signaling now instead of waiting out the backoff.
            viewModelScope.launch { engine?.onNetworkAvailable() }
        }
    }

    init {
        startEngine()
        loadConversations()
        runCatching {
            application.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback)
        }
    }

    /** First run / restore: derive the identity from the 12-word phrase, then start the engine. */
    fun createIdentity(phrase: String, passphrase: String, onResult: (Result<Unit>) -> Unit) {
        viewModelScope.launch {
            val result = runCatching {
                kotlinx.coroutines.withContext(Dispatchers.Default) { identityManager.createFromPhrase(phrase, passphrase) }
                Unit
            }
            onResult(result)
            if (result.isSuccess) startEngine()
        }
    }

    fun ownCard(): String = engine?.ownCard(settingsRepository.settings.value.peerNickname.ifBlank { null }) ?: ""

    fun previewContact(text: String): Result<Unit> = runCatching {
        (engine ?: throw IllegalStateException("Chat is not ready.")).previewContact(text)
    }

    fun confirmContact() {
        engine?.confirmContact()
    }

    fun cancelContact() {
        engine?.cancelContact()
    }

    /** (Re)starts the chat engine. Also used by the "Try again" button. */
    fun startEngine() {
        stopEngine()
        val application = getApplication<Application>()
        val crypto = LocalCrypto(application, LOCAL_ID)
        val store = MessageStore(database.dao(), crypto)
        val created = ChatEngine(
            scope = viewModelScope,
            conversationId = AppConfig.conversationId,
            store = store,
            identityManager = identityManager,
            networkConfig = { settingsRepository.settings.value.network },
            ble = com.duochat.app.ble.AndroidBleEnvironment(application),
            onNotify = { message ->
                if (!visible) {
                    val nickname = settingsRepository.settings.value.peerNickname
                    DuoNotifications.showIncoming(
                        application,
                        message,
                        nickname.ifBlank { "Your friend" },
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

    fun setVisible(isVisible: Boolean) {
        visible = isVisible
        engine?.setVisible(isVisible)
    }

    fun updateSettings(patch: AppSettings.() -> AppSettings) {
        val before = settingsRepository.settings.value.network
        settingsRepository.update(patch)
        if (settingsRepository.settings.value.network != before) engine?.reloadNetwork()
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

    fun clearNotice() {
        engine?.clearNotice()
    }

    fun confirmPeer() {
        engine?.confirmPeer()
    }

    /** Looks for the paired friend over Bluetooth. Fails with a readable message instead of prompting. */
    fun connectBluetooth(onResult: (Result<Unit>) -> Unit) {
        val current = engine ?: return onResult(Result.failure(IllegalStateException("Chat is not ready.")))
        viewModelScope.launch { onResult(current.connectBluetooth(manual = true)) }
    }

    /** Call after the user answered the Bluetooth permission prompt. */
    fun refreshBluetooth() {
        engine?.refreshBluetooth()
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

    fun resetPairing() {
        engine?.resetPairing()
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
     * App-wide emergency kill switch ("NUKE DUOCHAT"). Erases all local DuoChat
     * data, then restarts with a brand-new identity. The honest report is
     * exposed through [killSwitchReport] until acknowledged.
     */
    fun runNuke() {
        val application = getApplication<Application>()
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
                        uid = LOCAL_ID,
                    ),
                )
                _killSwitchReport.value = report
            } finally {
                // Regardless of partial failures, restart so the app lands on a
                // fresh identity (erased crypto state is reported as failed if not).
                startEngine()
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
     * conversation's local content only. Option B additionally forgets the
     * pinned peer. The engine is paused while erasing so a connection cannot
     * repopulate the store mid-wipe, then restarted.
     */
    fun runChatSwitch(
        withSessionState: Boolean,
        onResult: (Result<Boolean>) -> Unit,
    ) {
        val mode = if (withSessionState) {
            com.duochat.app.security.KillSwitchMode.LOCAL_PLUS_SESSION_STATE
        } else {
            com.duochat.app.security.KillSwitchMode.LOCAL_ONLY
        }
        viewModelScope.launch {
            stopEngine()
            try {
                val report = killSwitchExecutor.execute(
                    scope = com.duochat.app.security.KillSwitchScope.CONVERSATION,
                    mode = mode,
                    hooks = com.duochat.app.security.ConversationHooks(
                        conversationId = AppConfig.conversationId,
                        databaseProvider = { database },
                        identityManager = identityManager,
                        uid = LOCAL_ID,
                    ),
                )
                _killSwitchReport.value = report
                val summary = com.duochat.app.security.summarizeReport(report)
                onResult(Result.success(summary.complete))
            } catch (error: Exception) {
                onResult(Result.failure(error))
            } finally {
                startEngine()
            }
        }
    }

    private val _contacts = MutableStateFlow<List<ContactEntity>>(emptyList())
    val contacts: StateFlow<List<ContactEntity>> = _contacts.asStateFlow()

    private val _groups = MutableStateFlow<List<GroupEntity>>(emptyList())
    val groups: StateFlow<List<GroupEntity>> = _groups.asStateFlow()

    fun loadConversations() {
        viewModelScope.launch {
            runCatching {
                _contacts.value = database.dao().loadContacts()
                _groups.value = database.dao().loadGroups()
            }
        }
    }

    fun addContact(name: String, uid: String, onResult: (Result<Unit>) -> Unit = {}) {
        viewModelScope.launch {
            val res = runCatching {
                val entity = ContactEntity(
                    uid = uid,
                    name = name,
                    signPubX = "",
                    signPubY = "",
                    dhPubX = "",
                    dhPubY = "",
                    identityProof = "",
                    safetyNumber = "000000",
                )
                database.dao().putContact(entity)
                loadConversations()
            }
            onResult(res)
        }
    }

    fun createGroup(name: String, onResult: (Result<Unit>) -> Unit = {}) {
        viewModelScope.launch {
            val res = runCatching {
                val groupId = java.util.UUID.randomUUID().toString()
                val entity = GroupEntity(
                    groupId = groupId,
                    name = name,
                    avatarUrl = null,
                    createdBy = LOCAL_ID,
                    createdAt = System.currentTimeMillis(),
                )
                database.dao().putGroup(entity)
                loadConversations()
            }
            onResult(res)
        }
    }

    fun removeContact(uid: String) {
        viewModelScope.launch {
            database.dao().deleteContact(uid)
            loadConversations()
        }
    }

    fun removeGroup(groupId: String) {
        viewModelScope.launch {
            database.dao().deleteGroup(groupId)
            loadConversations()
        }
    }

    override fun onCleared() {
        runCatching {
            getApplication<Application>().getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback)
        }
        stopEngine()
        super.onCleared()
    }
}
