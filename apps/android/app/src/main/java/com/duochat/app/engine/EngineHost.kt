package com.duochat.app.engine

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Where the running chat engine lives. It belongs to the process, not to the screen: when the screen is closed with
 * "Keep running in the background" on, the engine (links, relays, Bluetooth mesh) keeps going, and the next screen
 * picks it up again instead of starting over.
 */
object EngineHost {
    @Volatile var engine: ChatEngineApi? = null
    @Volatile var startJob: Job? = null
    @Volatile private var scope: CoroutineScope? = null
    private var networkWatching = false

    /** Whether the phone has a network at all (from the default-network callback; true until it says otherwise). */
    @Volatile var online: Boolean = true
        private set

    /** A fresh scope for a new engine (same dispatcher the screen's scope used). */
    fun newScope(): CoroutineScope {
        scope?.cancel()
        return CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + survive).also { scope = it }
    }

    /**
     * An error in one piece of the engine's background work (one event, one link) must not close the whole app: it is
     * written down (shown on the next launch, to copy) and the rest keeps running.
     */
    @Volatile var app: Application? = null
    private val survive = CoroutineExceptionHandler { _, error ->
        android.util.Log.e("EngineHost", "background error", error)
        app?.let { com.duochat.app.CrashLog.record(it, error, "engine (app kept running)", fatal = false) }
    }

    /**
     * Starts the chat engine for this process (the screen and the background service share it). Returns the one that
     * is already running, if any.
     */
    @Synchronized
    fun ensureStarted(app: Application): ChatEngineApi {
        engine?.let { return it }
        val settings = com.duochat.app.data.SettingsRepository(app)
        val s = settings.settings.value
        val newScope = newScope()
        val created: ChatEngineApi = com.duochat.app.rustcore.RustChatEngine(
            app = app,
            scope = newScope,
            conversationId = com.duochat.app.AppConfig.conversationId,
            networkConfig = { settings.settings.value.network },
            ownName = { settings.settings.value.displayName },
            isMuted = { id -> id in settings.settings.value.mutedChats },
            onNotify = { notice -> com.duochat.app.notifications.DuoNotifications.showNotice(app, notice, settings.settings.value) },
            initialGroupOnly = s.groupOnly,
        )
        engine = created
        if (s.mesh) created.setMeshEnabled(true)
        startJob = newScope.launch { created.start() }
        watchNetwork(app)
        BackgroundPolicy.watch(app)
        // Weekly automatic backups (when turned on): checked a minute after start and then every few hours, with the
        // screen open or only the background service running.
        newScope.launch(Dispatchers.IO) {
            kotlinx.coroutines.delay(60_000)
            while (true) {
                runCatching { com.duochat.app.data.AutoBackup.runIfDue(app, { p -> created.exportBackup(p) }) }
                kotlinx.coroutines.delay(6L * 3600 * 1000)
            }
        }
        return created
    }

    /** Stops the engine and everything it launched. */
    fun stop() {
        startJob?.cancel()
        startJob = null
        engine?.stop()
        engine = null
        scope?.cancel()
        scope = null
    }

    /** A new network is a reason to retry signaling now instead of waiting out the backoff. Registered once per process. */
    fun watchNetwork(app: Application) {
        if (networkWatching) return
        networkWatching = true
        runCatching {
            app.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                // Android reports the current network as soon as this is registered: only a change is a reason to reset.
                private var current: Network? = null
                private var lost = false

                override fun onAvailable(network: Network) {
                    online = true
                    BackgroundPolicy.refresh()
                    val changed = lost || (current != null && current != network)
                    current = network
                    lost = false
                    if (!changed) return
                    val e = engine ?: return
                    scope?.launch { e.onNetworkAvailable() }
                }

                override fun onLost(network: Network) {
                    if (network != current) return
                    online = false
                    BackgroundPolicy.refresh()
                    // Coming back, on this network or another, counts as a change: everything is reset then.
                    lost = true
                    engine?.let { e -> scope?.launch { e.onNetworkAvailable() } }
                }
            })
        }
    }
}
