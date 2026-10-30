package com.duochat.app.security

import com.duochat.app.security.Vectors.d
import com.duochat.app.security.Vectors.jwkPub
import com.duochat.app.security.Vectors.objects
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The Bluetooth link encryption. The "TypeScript" tests replay frames produced by the real TypeScript
 * `SecureChannel` (docs/android-vectors.json, fixed ephemeral keys) and compare bytes. The last test
 * writes Kotlin's own frames for packages/protocol/test/androidInterop.test.ts to verify the other way round.
 */
class SecureChannelTest {
    private val v = Vectors.all
    private val sc = v.getJSONObject("secureChannel")
    private val recovery = v.getJSONArray("recovery").objects()
    private val ann = RecoveryIdentity.derive(recovery[0].getString("phrase"), recovery[0].getString("passphrase"))
    private val bob = RecoveryIdentity.derive(recovery[2].getString("phrase"), recovery[2].getString("passphrase"))
    private val cat = RecoveryIdentity.derive(recovery[3].getString("phrase"), recovery[3].getString("passphrase"))

    private fun channel(me: RecoveryIdentity.Keys, other: RecoveryIdentity.Keys, fixed: JSONObject? = null, signer: RecoveryIdentity.Keys = me) =
        SecureChannel.create(
            ownUid = me.uid,
            peerUid = other.uid,
            sign = { EcKeys.sign(signer.signD, it) },
            peerSign = other.signPub,
            testEphemeral = fixed?.let { SecureChannel.ephemeralFrom(d(it.getJSONObject("ephPriv")), jwkPub(it.getJSONObject("ephPub"))) },
            testNonce = fixed?.getString("nonce"),
        )

    private fun pair(): Pair<SecureChannel, SecureChannel> {
        val a = channel(ann, bob)
        val b = channel(bob, ann)
        a.accept(b.hello())
        b.accept(a.hello())
        return a to b
    }

    private fun frames(from: String) = sc.getJSONArray("frames").objects().filter { it.getString("from") == from }

    @Test
    fun `fixture identities match the vector uids`() {
        assertEquals(sc.getJSONObject("ann").getString("uid"), ann.uid)
        assertEquals(sc.getJSONObject("bob").getString("uid"), bob.uid)
    }

    @Test
    fun `Kotlin as Bob accepts the TypeScript hello, decrypts its frames and produces identical ciphertext`() {
        val b = channel(bob, ann, sc.getJSONObject("bob"))
        // Our own hello carries the same ephemeral key and nonce the TypeScript side used.
        val hello = b.hello()
        assertEquals(sc.getJSONObject("bob").getJSONObject("hello").getString("nonce"), hello.getString("nonce"))
        assertEquals(sc.getJSONObject("bob").getJSONObject("hello").getJSONObject("epk").getString("x"), hello.getJSONObject("epk").getString("x"))
        b.accept(sc.getJSONObject("ann").getJSONObject("hello"))
        assertTrue(b.ready)
        for (f in frames("ann")) assertEquals(f.getString("plaintext"), b.decryptText(f.getJSONObject("frame")))
        val own = frames("bob").single()
        assertEquals(own.getJSONObject("frame").getString("ct"), b.encryptText(own.getString("plaintext")).getString("ct"))
    }

    @Test
    fun `Kotlin as Ann accepts the TypeScript hello, decrypts its frame and produces identical ciphertext`() {
        val a = channel(ann, bob, sc.getJSONObject("ann"))
        a.accept(sc.getJSONObject("bob").getJSONObject("hello"))
        val bobFrame = frames("bob").single()
        assertEquals(bobFrame.getString("plaintext"), a.decryptText(bobFrame.getJSONObject("frame")))
        for (f in frames("ann")) {
            val mine = a.encryptText(f.getString("plaintext"))
            assertEquals(f.getInt("n"), mine.getInt("n"))
            assertEquals(f.getJSONObject("frame").getString("ct"), mine.getString("ct"))
        }
    }

    @Test
    fun `a hello signed by someone other than the pinned contact is refused`() {
        val a = channel(ann, bob, sc.getJSONObject("ann"))
        val error = assertThrows(SecurityException::class.java) { a.accept(sc.getJSONObject("impostorHello")) }
        assertTrue(error.message!!.contains("not signed"))
        assertFalse(a.ready)
    }

    @Test
    fun `a hello replayed into the wrong direction is refused`() {
        // Ann's own hello fed back to Ann: signed for (ann|bob) but verified as (bob|ann).
        val a = channel(ann, bob)
        assertThrows(SecurityException::class.java) { a.accept(a.hello()) }
    }

    @Test
    fun `round trip both ways between two Kotlin channels`() {
        val (a, b) = pair()
        assertEquals("{\"x\":1}", b.decryptText(a.encryptText("{\"x\":1}")))
        assertEquals("{\"y\":2}", a.decryptText(b.encryptText("{\"y\":2}")))
        val frame = a.encrypt(JSONObject().put("secret", "needle-123"))
        assertFalse(frame.toString().contains("needle"))
    }

    @Test
    fun `tampering is rejected`() {
        val (a, b) = pair()
        val frame = a.encryptText("{\"a\":1}")
        val ct = frame.getString("ct")
        val flipped = JSONObject(frame.toString()).put("ct", ct.dropLast(2) + if (ct.endsWith("AA")) "BB" else "AA")
        assertThrows(Exception::class.java) { b.decryptText(flipped) }
        // A failed attempt must not advance the counter: the genuine frame still opens.
        assertEquals("{\"a\":1}", b.decryptText(frame))
        // The counter is bound into the IV and AAD: relabelling a frame breaks it.
        val second = a.encryptText("{\"b\":2}")
        assertThrows(Exception::class.java) { b.decryptText(JSONObject(second.toString()).put("n", 7)) }
    }

    @Test
    fun `replayed and out of order frames are rejected`() {
        val (a, b) = pair()
        val f0 = a.encryptText("0")
        val f1 = a.encryptText("1")
        assertEquals("1", b.decryptText(f1))
        assertThrows(SecurityException::class.java) { b.decryptText(f1) }
        assertThrows(SecurityException::class.java) { b.decryptText(f0) }
    }

    @Test
    fun `a different signer cannot complete a handshake with the pinned contact`() {
        val a = channel(ann, bob)
        val evil = channel(bob, ann, signer = cat)
        assertThrows(SecurityException::class.java) { a.accept(evil.hello()) }
    }

    @Test
    fun `every session has fresh keys so a recorded frame never opens in another session`() {
        val (a1, _) = pair()
        val recorded = a1.encryptText("{\"old\":true}")
        val (_, b2) = pair()
        assertThrows(Exception::class.java) { b2.decryptText(recorded) }
        assertNotEquals(pair().first.hello().getString("nonce"), pair().first.hello().getString("nonce"))
    }

    @Test
    fun `cannot be used before the handshake finishes`() {
        val a = channel(ann, bob)
        assertThrows(IllegalStateException::class.java) { a.encryptText("{}") }
        assertThrows(IllegalStateException::class.java) { a.decryptText(JSONObject("{\"v\":1,\"kind\":\"sc_data\",\"n\":0,\"ct\":\"AAAA\"}")) }
    }

    @Test
    fun `malformed hellos are refused`() {
        val a = channel(ann, bob)
        assertThrows(IllegalArgumentException::class.java) { a.accept(JSONObject("{\"v\":1,\"kind\":\"sc_hello\"}")) }
        assertThrows(IllegalArgumentException::class.java) { a.accept(JSONObject("{\"v\":2,\"kind\":\"sc_hello\"}")) }
    }

    @Test
    fun `export Kotlin made frames so TypeScript can verify them`() {
        // Kotlin plays Bob with the vector's fixed ephemeral key; TypeScript will play Ann.
        val b = channel(bob, ann, sc.getJSONObject("bob"))
        b.accept(sc.getJSONObject("ann").getJSONObject("hello"))
        val out = listOf(
            "{\"v\":1,\"kind\":\"hello\",\"uid\":\"${bob.uid}\",\"note\":\"from kotlin ✓ 😀\"}",
            "{\"v\":1,\"kind\":\"ping\",\"at\":1700000000999}",
        ).map { JSONObject().put("plaintext", it).put("frame", b.encryptText(it)) }
        // What Ann would send, computed by Kotlin with Ann's fixed ephemeral key.
        val a = channel(ann, bob, sc.getJSONObject("ann"))
        a.accept(sc.getJSONObject("bob").getJSONObject("hello"))
        val reply = "{\"v\":1,\"kind\":\"pong\",\"at\":1700000000999}"
        val json = JSONObject()
            .put("hello", channel(bob, ann, sc.getJSONObject("bob")).hello())
            .put("frames", org.json.JSONArray(out))
            .put("annReplyPlaintext", reply)
            .put("annReplyCt", a.encryptText(reply).getString("ct"))
        val dir = File("build/interop").also { it.mkdirs() }
        File(dir, "kotlin-securechannel.json").writeText(json.toString(2))
    }
}
