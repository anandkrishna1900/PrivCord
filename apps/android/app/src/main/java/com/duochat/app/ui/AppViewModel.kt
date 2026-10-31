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
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val settingsRepository = SettingsRepository(application)
    private val identityManager = AndroidIdentityManager(application)

    // No destructive fallback: a missing migration must fail loudly instead of silently wiping every message.
    private val database by lazy {
        Room.databaseBuilder(application, DuoDatabase::class.java, "duochat.db")
            .addMigrations(
                DuoDatabase.MIGRATION_1_2, DuoDatabase.MIGRATION_2_3, DuoDatabase.MIGRATION_3_4, DuoDatabase.MIGRATION_4_5, DuoDatabase.MIGRATION_5_6, DuoDatabase.MIGRATION_6_7,
            )
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

    /** (Re)starts the chat engine. Also used by the "Try again" button. */
    fun startEngine() {
        stopEngine()
        val application = getApplication<Application>()
        val crypto = LocalCrypto(application, LOCAL_ID)
        val store = MessageStore(database.dao(), crypto, java.io.File(application.filesDir, "privcord-files"))
        val created = ChatEngine(
            scope = viewModelScope,
            handshakeId = AppConfig.conversationId,
            store = store,
            identityManager = identityManager,
            networkConfig = { settingsRepository.settings.value.network },
            ownName = { settingsRepository.settings.value.displayName },
            legacyNickname = { settingsRepository.settings.value.peerNickname },
            isMuted = { id -> id in settingsRepository.settings.value.mutedChats },
            ble = com.duochat.app.ble.AndroidBleEnvironment(application),
            onNotify = { notice -> DuoNotifications.showNotice(application, notice, settingsRepository.settings.value) },
            initialGroupOnly = settingsRepository.settings.value.groupOnly,
            meshRadioFactory = { com.duochat.app.ble.AndroidMeshRadio(application) },
        )
        engine = created
        if (visible) created.setVisible(true)
        if (settingsRepository.settings.value.mesh) created.setMeshEnabled(true)
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

    fun setOpenChat(conversationId: String?) {
        engine?.setOpenChat(conversationId)
    }

    private val _locked = MutableStateFlow(false)

    /** True while the app lock covers the app. */
    val locked: StateFlow<Boolean> = _locked.asStateFlow()
    private var leftAt = 0L

    /** The screen left the foreground. */
    fun onLeft() {
        leftAt = System.currentTimeMillis()
    }

    /** The screen came (back) to the foreground: lock if the lock is on and the app was away long enough. */
    fun onEntered() {
        val lock = com.duochat.app.security.AppLock.shouldLock(
            enabled = settingsRepository.settings.value.appLock,
            available = com.duochat.app.security.AppLock.available(getApplication()),
            leftAt = leftAt,
            now = System.currentTimeMillis(),
        )
        if (lock) _locked.value = true
    }

    fun unlock() {
        _locked.value = false
    }

    fun updateSettings(patch: AppSettings.() -> AppSettings) {
        val before = settingsRepository.settings.value
        settingsRepository.update(patch)
        val after = settingsRepository.settings.value
        if (after.network != before.network) engine?.reloadNetwork()
        if (after.displayName != before.displayName) engine?.onOwnNameChanged()
        if (after.groupOnly != before.groupOnly) engine?.setGroupOnly(after.groupOnly)
        if (after.mesh != before.mesh) engine?.setMeshEnabled(after.mesh)
    }

    fun toggleMute(conversationId: String) {
        updateSettings {
            copy(mutedChats = if (conversationId in mutedChats) mutedChats - conversationId else mutedChats + conversationId)
        }
    }

    fun ownCard(): String = runCatching { engine?.ownCard() }.getOrNull().orEmpty()

    private fun <T> withEngine(onResult: (Result<T>) -> Unit, block: suspend (ChatEngine) -> Result<T>) {
        val current = engine ?: run {
            onResult(Result.failure(IllegalStateException("Chat is not ready.")))
            return
        }
        viewModelScope.launch { onResult(runCatching { block(current).getOrThrow() }) }
    }

    fun addFriend(text: String, onResult: (Result<String>) -> Unit) = withEngine(onResult) { it.addFriend(text) }

    fun createInvite(onResult: (Result<com.duochat.app.data.ActiveInvite>) -> Unit) = withEngine(onResult) { it.createInvite() }

    fun acceptRequest(uid: String, onResult: (Result<String>) -> Unit) = withEngine(onResult) { it.acceptRequest(uid) }

    fun retryAnswer() {
        engine?.retryAnswer()
    }

    fun clearAnswer() {
        engine?.clearAnswer()
    }

    fun dismissRequest(uid: String) {
        engine?.dismissRequest(uid)
    }

    fun joinChannel(name: String, onResult: (Result<String>) -> Unit) = withEngine(onResult) { it.joinChannel(name) }

    fun leaveChannel(id: String) {
        engine?.leaveChannel(id)
    }

    fun muteSender(uid: String) {
        engine?.muteSender(uid)
    }

    fun markChecked(uid: String) {
        viewModelScope.launch { engine?.markChecked(uid) }
    }

    fun renameFriend(uid: String, name: String) {
        viewModelScope.launch { engine?.renameFriend(uid, name) }
    }

    fun removeFriend(uid: String, onResult: (Result<Unit>) -> Unit) = withEngine(onResult) { it.removeFriend(uid) }

    fun removeBlocker(uid: String): String? = engine?.removeBlocker(uid)

    fun createGroup(name: String, memberUids: List<String>, onResult: (Result<String>) -> Unit) =
        withEngine(onResult) { it.createGroup(name, memberUids) }

    fun addToGroup(groupId: String, uids: List<String>, onResult: (Result<Unit>) -> Unit) =
        withEngine(onResult) { it.addToGroup(groupId, uids) }

    fun removeFromGroup(groupId: String, uid: String, onResult: (Result<Unit>) -> Unit) =
        withEngine(onResult) { it.removeFromGroup(groupId, uid) }

    fun leaveGroup(groupId: String, onResult: (Result<Unit>) -> Unit) = withEngine(onResult) { it.leaveGroup(groupId) }

    fun renameGroup(groupId: String, name: String, onResult: (Result<Unit>) -> Unit) =
        withEngine(onResult) { it.renameGroup(groupId, name) }

    fun send(conversationId: String, text: String, replyToId: String?, onResult: (Result<Unit>) -> Unit) =
        withEngine(onResult) { it.send(conversationId, text, replyToId) }

    fun sendFile(conversationId: String, name: String, mime: String, bytes: ByteArray, replyToId: String?, onResult: (Result<Unit>) -> Unit) =
        withEngine(onResult) { it.sendFile(conversationId, name, mime, bytes, replyToId) }

    suspend fun getFile(messageId: String) = engine?.getFile(messageId)

    fun retry(messageId: String) {
        viewModelScope.launch { engine?.retry(messageId) }
    }

    fun clearNotice() {
        engine?.clearNotice()
    }

    fun deleteMessage(messageId: String, everyone: Boolean) {
        viewModelScope.launch { engine?.deleteMessage(messageId, everyone) }
    }

    fun react(messageId: String, emoji: String) {
        viewModelScope.launch { engine?.react(messageId, emoji) }
    }

    fun setDisappearing(conversationId: String, seconds: Int) {
        engine?.setDisappearing(conversationId, seconds)
    }

    fun search(query: String): List<ChatEngine.SearchHit> = engine?.search(query).orEmpty()

    fun exportBackup(passphrase: String, onResult: (Result<String>) -> Unit) {
        viewModelScope.launch { onResult(engine?.exportBackup(passphrase) ?: Result.failure(IllegalStateException("Not ready yet."))) }
    }

    fun importBackup(text: String, passphrase: String, onResult: (Result<String>) -> Unit) {
        viewModelScope.launch { onResult(engine?.importBackup(text, passphrase) ?: Result.failure(IllegalStateException("Not ready yet."))) }
    }

    fun clearChat(conversationId: String) {
        viewModelScope.launch { engine?.clearChat(conversationId) }
    }

    fun clearLocalData(onResult: (Result<Unit>) -> Unit) {
        withEngine(onResult) { Result.success(it.clearLocalData()) }
    }

    /** Looks for a friend over Bluetooth. Fails with a readable message instead of prompting. */
    fun connectBluetooth(uid: String, onResult: (Result<Unit>) -> Unit) =
        withEngine(onResult) { it.connectBluetooth(uid, manual = true) }

    /** Call after the user answered the Bluetooth permission prompt. */
    fun refreshBluetooth() {
        engine?.refreshBluetooth()
    }

    fun cancelManual() {
        engine?.cancelManual()
    }

    fun confirmManual() {
        engine?.confirmManual()
    }

    fun createManualOffer(onResult: (Result<String>) -> Unit) = withEngine(onResult) { Result.success(it.createManualOffer()) }

    fun applyManualAnswer(code: String, onResult: (Result<Unit>) -> Unit) =
        withEngine(onResult) { Result.success(it.applyManualAnswer(code)) }

    fun acceptManualOffer(code: String, onResult: (Result<String>) -> Unit) =
        withEngine(onResult) { Result.success(it.acceptManualOffer(code)) }

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

    override fun onCleared() {
        runCatching {
            getApplication<Application>().getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback)
        }
        stopEngine()
        super.onCleared()
    }
}
