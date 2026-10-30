package com.duochat.app.signaling

import com.duochat.app.security.Vectors
import com.duochat.app.security.Vectors.hex
import com.duochat.app.security.Vectors.unhex
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** BIP-340 + Nostr events, checked against values from @noble/curves (the desktop's implementation). */
class SchnorrNostrTest {
    private val nostr = Vectors.all.getJSONObject("nostr")

    @Test
    fun `official BIP-340 vector 0`() {
        val sk = unhex("0000000000000000000000000000000000000000000000000000000000000003")
        assertEquals("f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9", hex(Schnorr.publicKey(sk)))
        val sig = Schnorr.sign(ByteArray(32), sk, ByteArray(32))
        assertEquals(
            "e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0",
            hex(sig),
        )
        assertTrue(Schnorr.verify(sig, ByteArray(32), Schnorr.publicKey(sk)))
    }

    @Test
    fun `public key and reproducible signature match TypeScript`() {
        val sk = unhex(nostr.getString("secretKeyHex"))
        assertEquals(nostr.getString("publicKeyHex"), hex(Schnorr.publicKey(sk)))
        val fixed = NostrEvent.fromJson(nostr.getJSONObject("fixedEvent"))!!
        assertEquals(fixed.sig, hex(Schnorr.sign(unhex(fixed.id), sk, ByteArray(32))))
    }

    @Test
    fun `events made by TypeScript verify and tampered ones do not`() {
        for (name in listOf("fixedEvent", "randomEvent")) {
            val e = NostrEvent.fromJson(nostr.getJSONObject(name))!!
            assertEquals(name, nostr.getBoolean(name + "Valid"), NostrCodec.verify(e))
            assertTrue(name, NostrCodec.verify(e))
        }
        val tampered = NostrEvent.fromJson(nostr.getJSONObject("tamperedEvent"))!!
        assertFalse(NostrCodec.verify(tampered))
        assertFalse(nostr.getBoolean("tamperedEventValid"))
        val fixed = NostrEvent.fromJson(nostr.getJSONObject("fixedEvent"))!!
        assertFalse(NostrCodec.verify(fixed.copy(sig = fixed.sig.reversed())))
        assertFalse(NostrCodec.verify(fixed.copy(pubkey = hex(Schnorr.publicKey(Schnorr.newSecretKey())))))
    }

    @Test
    fun `an event built in Kotlin is identical to the TypeScript one`() {
        val fixed = NostrEvent.fromJson(nostr.getJSONObject("fixedEvent"))!!
        val mine = NostrCodec.makeEvent(
            mailbox = "mailbox-x", blobWire = fixed.content, kind = "sig", ttlSec = 120, now = 1_700_000_000,
            secretKey = unhex(nostr.getString("secretKeyHex")), aux = ByteArray(32), dTag = "fixed-d",
        )
        assertEquals(fixed.id, mine.id)
        assertEquals(fixed.sig, mine.sig)
        assertEquals(fixed.tags, mine.tags)
        assertEquals(NOSTR_KIND_SIGNAL, mine.kind)
        assertEquals(NOSTR_KIND_MESSAGE, NostrCodec.makeEvent("m", "c", "msg", 60).kind)
    }

    @Test
    fun `random keys sign and verify, different events use different keys`() {
        val a = NostrCodec.makeEvent("m", "blob", "sig", 60)
        val b = NostrCodec.makeEvent("m", "blob", "sig", 60)
        assertTrue(NostrCodec.verify(a) && NostrCodec.verify(b))
        assertTrue(a.pubkey != b.pubkey)
        assertEquals("m", a.tag("t"))
        val json = a.toJson()
        assertEquals(a, NostrEvent.fromJson(JSONObject(json.toString())))
        assertNotNull(a.tag("expiration"))
        val sk = Schnorr.newSecretKey()
        val msg = ByteArray(32) { it.toByte() }
        val sig = Schnorr.sign(msg, sk)
        assertTrue(Schnorr.verify(sig, msg, Schnorr.publicKey(sk)))
        assertFalse(Schnorr.verify(sig, msg.also { it[0] = 99 }, Schnorr.publicKey(sk)))
        assertArrayEquals(Schnorr.publicKey(sk), Schnorr.publicKey(sk))
    }

    @Test
    fun `reconnect backoff matches the TypeScript schedule`() {
        val cases = Vectors.all.getJSONArray("reconnect")
        assertTrue(cases.length() >= 10)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals("attempt ${c.getInt("attempt")}", c.getLong("ms"), reconnectDelayMs(c.getInt("attempt")))
        }
    }
}
