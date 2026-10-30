package com.duochat.app.security

import com.duochat.app.security.Vectors.d
import com.duochat.app.security.Vectors.hex
import com.duochat.app.security.Vectors.jwkPub
import com.duochat.app.security.Vectors.objects
import com.duochat.app.security.Vectors.unhex
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every assertion compares Kotlin against values the TypeScript protocol produced. */
class SecurityVectorsTest {
    private val v = Vectors.all

    @Test
    fun `recovery phrases give the same keys and uid as TypeScript`() {
        val cases = v.getJSONArray("recovery").objects()
        assertTrue(cases.size >= 4)
        for (c in cases) {
            val label = c.getString("phrase").take(30) + " / " + c.getString("passphrase")
            val seed = Bip39.seed(c.getString("phrase"), c.getString("passphrase"))
            assertEquals(label, c.getString("seedHex"), hex(seed))
            assertEquals(label, c.getString("signMaterialHex"), hex(RecoveryIdentity.keyMaterial(seed, "identity-sign")))
            assertEquals(label, c.getString("agreementMaterialHex"), hex(RecoveryIdentity.keyMaterial(seed, "identity-agreement")))
            val keys = RecoveryIdentity.derive(c.getString("phrase"), c.getString("passphrase"))
            assertEquals(label, hex(d(c.getJSONObject("signPriv"))), hex(keys.signD))
            assertEquals(label, hex(d(c.getJSONObject("dhPriv"))), hex(keys.dhD))
            assertEquals(label, jwkPub(c.getJSONObject("signPub")), keys.signPub)
            assertEquals(label, jwkPub(c.getJSONObject("dhPub")), keys.dhPub)
            assertEquals(label, c.getString("uid"), keys.uid)
            // The proof TypeScript made verifies against the keys Kotlin derived.
            assertTrue(label, IdentityCodec.verifyIdentityProof(keys.signPub, keys.dhPub, c.getString("identityProof")))
        }
    }

    @Test
    fun `passphrase changes the identity`() {
        val c = v.getJSONArray("recovery").objects()
        assertNotEquals(c[0].getString("uid"), c[1].getString("uid"))
    }

    @Test
    fun `entropy to mnemonic matches TypeScript and validates`() {
        for (e in v.getJSONArray("entropy").objects()) {
            val phrase = Bip39.fromEntropy(unhex(e.getString("entropyHex")))
            assertEquals(e.getString("mnemonic"), phrase)
            assertNull(Bip39.validate(phrase))
        }
    }

    @Test
    fun `invalid phrases are rejected like TypeScript`() {
        for (p in v.getJSONArray("invalidPhrases").objects()) {
            assertEquals(p.getString("phrase"), p.getBoolean("valid"), Bip39.validate(p.getString("phrase")) == null)
        }
        assertNotNull(Bip39.validate(""))
        assertNotNull(Bip39.validate("   "))
    }

    @Test
    fun `phrase handling is forgiving about case and spacing`() {
        val phrase = v.getJSONArray("recovery").objects()[0].getString("phrase")
        assertNull(Bip39.validate("  " + phrase.uppercase().replace(" ", "   ") + "\n"))
        assertEquals(v.getJSONArray("recovery").objects()[0].getString("uid"), RecoveryIdentity.derive("  " + phrase.uppercase() + " ").uid)
    }

    @Test
    fun `generated phrases are valid 12 word phrases and differ`() {
        val a = Bip39.generate()
        val b = Bip39.generate()
        assertEquals(12, a.split(' ').size)
        assertNull(Bip39.validate(a))
        assertNotEquals(a, b)
        assertNotNull(RecoveryIdentity.derive(a).uid)
    }

    @Test
    fun `canonical json matches TypeScript byte for byte`() {
        for (c in v.getJSONArray("canonical").objects()) {
            val parsed: Any = if (c.getString("json").startsWith("[")) org.json.JSONArray(c.getString("json")) else JSONObject(c.getString("json"))
            assertEquals(c.getString("json"), c.getString("expected"), CanonicalJson.of(parsed))
        }
    }

    @Test
    fun `contact cards decode to the TypeScript uid and re-encode identically`() {
        val cards = v.getJSONObject("cards")
        val ann = ContactCards.decode(cards.getJSONObject("ann").getString("encoded"))
        assertNotNull(ann)
        assertEquals(cards.getJSONObject("ann").getString("uid"), ann!!.uid)
        assertEquals("Ann ✓", ann.card.name)
        assertEquals(cards.getJSONObject("ann").getString("encoded"), ContactCards.encode(ann.card))
        val bob = ContactCards.decode(cards.getJSONObject("bob").getString("encoded"))!!
        assertNull(bob.card.name)
        assertEquals(cards.getJSONObject("bob").getString("encoded"), ContactCards.encode(bob.card))
        assertNull(ContactCards.decode(cards.getString("forged")))
        assertNull(ContactCards.decode("DUOID1:not-base64!!"))
        assertNull(ContactCards.decode("hello"))
    }

    private fun person(name: String): Triple<RecoveryIdentity.Keys, String, JSONObject> {
        val r = v.getJSONArray("recovery").objects()
        val c = when (name) { "ann" -> r[0]; "bob" -> r[2]; else -> error(name) }
        return Triple(RecoveryIdentity.derive(c.getString("phrase"), c.getString("passphrase")), c.getString("uid"), c)
    }

    @Test
    fun `blobs sealed by TypeScript open in Kotlin in both directions`() {
        val (ann, annUid, _) = person("ann")
        val (bob, bobUid, _) = person("bob")
        val sealed = v.getJSONArray("sealed").objects()
        for (s in sealed) {
            val toBob = s.getString("toUid") == bobUid
            val (recipient, sender) = if (toBob) bob to ann else ann to bob
            val blob = Seal.decode(s.getString("wire"))
            assertNotNull(s.getString("label"), blob)
            assertEquals(s.getString("mailbox"), Seal.mailboxFor(s.getString("toUid")))
            val opened = Seal.open(
                blob!!, s.getString("toUid"), { EcKeys.agree(recipient.dhD, it) }, sender.signPub, s.getString("fromUid"),
            )
            assertNotNull(s.getString("label"), opened)
            assertEquals(CanonicalJson.of(s.getJSONObject("payload")), CanonicalJson.of(opened))
            // Wrong recipient, wrong claimed sender, wrong signer: all refused.
            assertNull(Seal.open(blob, s.getString("toUid"), { EcKeys.agree((if (toBob) ann else bob).dhD, it) }, sender.signPub, s.getString("fromUid")))
            assertNull(Seal.open(blob, s.getString("toUid"), { EcKeys.agree(recipient.dhD, it) }, recipient.signPub, s.getString("fromUid")))
            assertNull(Seal.open(blob, s.getString("toUid"), { EcKeys.agree(recipient.dhD, it) }, sender.signPub, "someone-else"))
        }
        assertNull(Seal.decode(v.getString("flippedWire"))?.let {
            Seal.open(it, bobUid, { pub -> EcKeys.agree(bob.dhD, pub) }, ann.signPub, annUid)
        })
        assertEquals(annUid, v.getJSONObject("uids").getString("ann"))
    }

    @Test
    fun `Kotlin seal and open round trip, ciphertext hides the payload`() {
        val (ann, annUid, _) = person("ann")
        val (bob, bobUid, _) = person("bob")
        val payload = JSONObject().put("t", "msg").put("text", "marker-4242 héllo ✓")
        val blob = Seal.seal(payload, annUid, bobUid, bob.dhPub) { EcKeys.sign(ann.signD, it) }
        val wire = Seal.encode(blob)
        assertTrue(!wire.contains("marker-4242") && !String(SignatureCodec.base64UrlDecode(wire)).contains("marker-4242"))
        val opened = Seal.open(Seal.decode(wire)!!, bobUid, { EcKeys.agree(bob.dhD, it) }, ann.signPub, annUid)
        assertEquals("marker-4242 héllo ✓", opened!!.getString("text"))
    }

    @Test
    fun `safety number matches TypeScript`() {
        val (ann, _, _) = person("ann")
        val (bob, _, _) = person("bob")
        assertEquals(v.getJSONObject("safety").getString("ann_bob"), IdentityCodec.safetyNumber(ann.signPub, bob.signPub))
    }
}
