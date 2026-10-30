package com.duochat.app.signaling

import com.duochat.app.security.ContactCards
import com.duochat.app.security.EcKeys
import com.duochat.app.security.RecoveryIdentity
import com.duochat.app.security.Seal
import com.duochat.app.security.SealedBlob
import com.duochat.app.security.Vectors
import com.duochat.app.security.Vectors.objects
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.ServerSocket
import java.net.URL
import java.nio.file.Files

/**
 * Two Kotlin clients through the REAL relay (`relay/index.js`) and a minimal NIP-01 relay, both run
 * with Node. Skipped, with a message, when node or the relay's dependencies are not installed.
 */
class RelayInteropTest {
    private val repo: File = listOf("../../..", "../..", ".").map(::File).first { File(it, "relay/index.js").exists() }.canonicalFile
    private val node: String? = listOf("/usr/bin/node", "/usr/local/bin/node", "/opt/node22/bin/node").firstOrNull { File(it).exists() }
        ?: System.getenv("PATH")?.split(File.pathSeparator)?.map { File(it, "node") }?.firstOrNull { it.canExecute() }?.path
    private val processes = mutableListOf<Process>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val client = newSignalingClient()
    private val keys = Vectors.all.getJSONArray("recovery").objects().let { r ->
        RecoveryIdentity.derive(r[0].getString("phrase")) to RecoveryIdentity.derive(r[2].getString("phrase"))
    }
    private val ann get() = keys.first
    private val bob get() = keys.second

    @Before
    fun checkNode() {
        assumeTrue("node is not installed; skipping the real-relay interop test", node != null)
        assumeTrue("relay/node_modules is missing; run `npm ci` in relay/", File(repo, "relay/node_modules/ws").exists())
    }

    @After
    fun cleanup() {
        processes.forEach { it.destroy() }
        scope.cancel()
    }

    private fun freePort() = ServerSocket(0).use { it.localPort }

    private fun start(vararg command: String, env: Map<String, String> = emptyMap(), ready: String): Int {
        val port = freePort()
        val builder = ProcessBuilder(command.map { it.replace("{port}", port.toString()) }).directory(repo).redirectErrorStream(true)
        builder.environment().putAll(env.mapValues { it.value.replace("{port}", port.toString()) })
        val process = builder.start()
        processes += process
        val deadline = System.currentTimeMillis() + 10_000
        val log = StringBuilder()
        val reader = process.inputStream.bufferedReader()
        while (System.currentTimeMillis() < deadline) {
            if (reader.ready()) {
                val line = reader.readLine() ?: break
                log.appendLine(line)
                if (ready in line) return port
            } else if (!process.isAlive) break else Thread.sleep(30)
        }
        error("Process did not become ready: $log")
    }

    private fun startRelay(storeForward: Boolean): Int = start(
        node!!, "relay/index.js",
        env = mapOf(
            "PORT" to "{port}", "DATA_DIR" to Files.createTempDirectory("duo-relay").toString(),
            "ALLOW_STORE_FORWARD" to storeForward.toString(),
        ),
        ready = "listening",
    )

    private fun payloadOffer() = JSONObject().put("t", "offer").put("sdp", "v=0\r\ns=-\r\n")

    private fun seal(from: RecoveryIdentity.Keys, to: RecoveryIdentity.Keys, payload: JSONObject): SealedBlob =
        Seal.seal(payload, from.uid, to.uid, to.dhPub) { EcKeys.sign(from.signD, it) }

    private fun open(blob: SealedBlob, to: RecoveryIdentity.Keys, from: RecoveryIdentity.Keys): JSONObject? =
        Seal.open(blob, to.uid, { EcKeys.agree(to.dhD, it) }, from.signPub, from.uid)

    private suspend fun waitUntil(what: String, condition: () -> Boolean) {
        withTimeout(8_000) { while (!condition()) delay(25) }
    }

    @Test
    fun `two Kotlin clients exchange a sealed offer through the real relay`() = runBlocking {
        val port = startRelay(storeForward = false)
        val url = "ws://127.0.0.1:$port"
        val received = CompletableDeferred<SealedBlob>()
        val listener = RelayClient(url, client, scope)
        listener.start(Seal.mailboxFor(bob.uid)) { blob, _ -> received.complete(blob) }
        val sender = SignalingHub(listOf(RelayClient(url, client, scope)))
        sender.start(Seal.mailboxFor(ann.uid)) { _, _, _ -> }
        waitUntil("both online") { listener.status() == SignalingStatus.ONLINE && sender.status() == SignalingStatus.ONLINE }

        sender.put(Seal.mailboxFor(bob.uid), seal(ann, bob, payloadOffer()), "sig", 60)
        val blob = withTimeout(8_000) { received.await() }
        assertEquals("offer", open(blob, bob, ann)?.getString("t"))
        assertEquals(null, open(blob, ann, bob)) // not addressed to Ann
        listener.stop(); sender.stop()
    }

    @Test
    fun `store and forward holds a sealed message for an offline contact and replays it`() = runBlocking {
        val port = startRelay(storeForward = true)
        val url = "ws://127.0.0.1:$port"
        val sender = SignalingHub(listOf(RelayClient(url, client, scope)))
        sender.start(Seal.mailboxFor(ann.uid)) { _, _, _ -> }
        waitUntil("sender online") { sender.status() == SignalingStatus.ONLINE }
        val msg = JSONObject().put("t", "msg").put("id", "m-1").put("text", "while you were away").put("at", 1L)
        sender.put(Seal.mailboxFor(bob.uid), seal(ann, bob, msg), "msg", 3600)

        // Bob comes online later and gets it.
        val received = CompletableDeferred<Pair<SealedBlob, String>>()
        val late = RelayClient(url, client, scope)
        late.start(Seal.mailboxFor(bob.uid)) { blob, id -> received.complete(blob to id) }
        val (blob, id) = withTimeout(8_000) { received.await() }
        assertEquals("while you were away", open(blob, bob, ann)?.getString("text"))
        late.remove(Seal.mailboxFor(bob.uid), id)
        late.stop(); sender.stop()
    }

    @Test
    fun `an unconfigured relay refuses store and forward but still relays live signaling`() = runBlocking {
        val port = startRelay(storeForward = false)
        val sender = RelayClient("ws://127.0.0.1:$port", client, scope)
        sender.start(Seal.mailboxFor(ann.uid)) { _, _ -> }
        waitUntil("online") { sender.status() == SignalingStatus.ONLINE }
        val blob = seal(ann, bob, JSONObject().put("t", "msg"))
        var refused = false
        try {
            sender.put(Seal.mailboxFor(bob.uid), blob, "msg", 3600)
        } catch (_: Exception) {
            refused = true
        }
        assertTrue("store-and-forward must be refused while disabled", refused)
        sender.put(Seal.mailboxFor(bob.uid), blob, "sig", 60)
        sender.stop()
    }

    @Test
    fun `nostr transport exchanges sealed blobs through a NIP-01 relay`() = runBlocking {
        val script = File(repo, "apps/android/app/src/test/resources/nostr-relay.mjs")
        val port = start(node!!, script.path, "{port}", File(repo, "relay/node_modules/ws").path, ready = "ready")
        val url = "ws://127.0.0.1:$port"
        val received = CompletableDeferred<SealedBlob>()
        val listener = NostrTransport(listOf(url), client, scope)
        listener.start(Seal.mailboxFor(bob.uid)) { blob, _ -> received.complete(blob) }
        val sender = NostrTransport(listOf(url), client, scope)
        sender.start(Seal.mailboxFor(ann.uid)) { _, _ -> }
        waitUntil("both online") { listener.status() == SignalingStatus.ONLINE && sender.status() == SignalingStatus.ONLINE }
        delay(200) // let the REQ reach the relay before publishing
        sender.put(Seal.mailboxFor(bob.uid), seal(ann, bob, payloadOffer()), "sig", 60)
        val blob = withTimeout(8_000) { received.await() }
        assertEquals("offer", open(blob, bob, ann)?.getString("t"))
        listener.stop(); sender.stop()
    }

    @Test
    fun `export Kotlin made artifacts so TypeScript can verify them`() {
        val card = ContactCards.encode(com.duochat.app.security.ContactCard(ann.signPub, ann.dhPub, kotlinProof(ann), "Kotlin Ann"))
        val blob = seal(ann, bob, JSONObject().put("t", "msg").put("text", "from kotlin ✓"))
        val sk = Schnorr.newSecretKey()
        val event = NostrCodec.makeEvent("kotlin-mailbox", Seal.encode(blob), "msg", 3600, secretKey = sk)
        val out = JSONObject()
            .put("card", card).put("cardUid", ann.uid)
            .put("sealedWire", Seal.encode(blob)).put("sealedFromUid", ann.uid).put("sealedToUid", bob.uid)
            .put("event", event.toJson())
            .put("proof", kotlinProof(ann))
        val dir = File("build/interop").also { it.mkdirs() }
        File(dir, "kotlin-vectors.json").writeText(out.toString(2))
        assertNotNull(ContactCards.decode(card))
        assertTrue(NostrCodec.verify(event))
    }

    private fun kotlinProof(k: RecoveryIdentity.Keys): String =
        EcKeys.sign(k.signD, com.duochat.app.security.IdentityCodec.identityProofPayload(k.dhPub))
}
