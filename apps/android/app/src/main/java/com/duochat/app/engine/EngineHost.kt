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
                override fun onAvailable(network: Network) {
                    val e = engine ?: return
                    scope?.launch { e.onNetworkAvailable() }
                }
            })
        }
    }
}
