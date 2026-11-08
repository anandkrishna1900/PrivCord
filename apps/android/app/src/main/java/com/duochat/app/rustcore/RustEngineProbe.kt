package com.duochat.app.rustcore

import android.content.Context
import uniffi.privcord_ffi.NotifierCallbacks
import uniffi.privcord_ffi.PrivcordEngine
import uniffi.privcord_ffi.SignalKind
import uniffi.privcord_ffi.TransportCallbacks
import java.io.File

/**
 * Starts a real Rust engine on this phone against a throwaway database and Keystore slot, makes an identity, reads back
 * its own contact card and snapshot, then shuts down and deletes everything. It never touches the app's real data. Its
 * result is shown in Settings > About so a tester can see that the engine, its SQLite storage and the Keystore adapter all
 * work on this device, before the chat screens move onto the engine.
 */
object RustEngineProbe {
    private object NoTransport : TransportCallbacks {
        override fun send(peer: String, frame: String) = false
        override fun sendRaw(link: String, frame: String) = false
        override fun close(peer: String) {}
        override fun signalAvailable() = false
        override fun signalSubscribe(mailbox: String) = false
        override fun signalUnsubscribe(mailbox: String) {}
        override fun signalPut(mailbox: String, blob: String, kind: SignalKind, ttlSec: UInt) = false
    }

    private object NoNotifier : NotifierCallbacks {
        override fun messageReceived(conversation: String, sender: String, preview: String) {}
    }

    /** "ok", or "failed at <step>: <error>". Blocking: call it off the main thread. */
    fun run(context: Context): String {
        val slot = "probe"
        val dir = File(context.noBackupFilesDir, "rust-probe").apply { mkdirs() }
        val secure = KeystoreSecureStore(context, slot)
        var step = "start"
        var engine: PrivcordEngine? = null
        return try {
            secure.deleteIdentity()
            dir.listFiles()?.forEach { it.delete() }
            engine = PrivcordEngine.start(File(dir, "probe.db").path, "duo", secure, NoTransport, NoNotifier)
            step = "create identity"
            val phrase = engine.createIdentity()
            check(phrase.trim().split(Regex("\\s+")).size == 12) { "recovery phrase is not 12 words" }
            step = "own card"
            check(engine.ownCard("Probe").isNotBlank()) { "empty card" }
            step = "snapshot"
            val uid = engine.snapshot().ownUid
            check(!uid.isNullOrEmpty()) { "no uid in snapshot" }
            step = "keystore reload"
            check(secure.loadIdentity()?.size == 64) { "identity did not round-trip through the Keystore" }
            "ok"
        } catch (t: Throwable) {
            "failed at $step: ${t.javaClass.simpleName} ${t.message.orEmpty()}".take(160)
        } finally {
            runCatching { engine?.shutdown() }
            runCatching { engine?.close() }
            secure.deleteIdentity()
            dir.listFiles()?.forEach { it.delete() }
        }
    }
}
