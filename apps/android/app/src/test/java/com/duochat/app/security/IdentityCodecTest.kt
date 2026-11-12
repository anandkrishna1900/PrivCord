package com.duochat.app.security

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Vectors produced by the TypeScript protocol (packages/protocol: deriveIdentityFromPhrase,
 * identityFingerprintHex, deriveSafetyNumber) so Android and desktop agree on the wire.
 */
class IdentityCodecTest {
    private val aSign = PublicJwk("Uc8IF7pvcRozSRkkKdFCb5slOPsdIBqXIhdgofU7S80", "tKBDXXrCyNVxGKO1z3TGzL0r-PT4nukAWfmE1ptutdk")
    private val aDh = PublicJwk("OyVbnLBhsYLY9xRJkEXDYQz_L532SLotLsmv-PKstiQ", "wJX41dT23t_LnQYG6RhIrWrupy2J4uw32tcwu90-reg")
    private val aProof = "0LSfXehqpOIuZax4iuaZFRZxEzQjg7nDa1RsNXGy0MOJZimy-X9HFMklsR58t4uiUKkZhjYAu_Jju4etU8-6uA"
    private val bSign = PublicJwk("6FuZPlrFou-tgfeRIYH6TGDLvMRoqPwU7HBP7hlcjdA", "whVjT1kBuYn2gDuSfBq2z2r1lbxqOillhJbTWOUsuDk")
    private val bDh = PublicJwk("zYcBKuj3Ij1qQqN-liw_a8DhfZvDG6tKgxCfRFG6uxU", "5mMzHrj708RGhJ15I1IYdy4cL8RFJxq9HeU0bjRmBl0")

    @Test
    fun `uid is the hash of both public keys`() {
        assertEquals("d2360f62fee1f1d2679278d1799927888ca4f8692d0e294918be14cae4d5798a", IdentityCodec.uidFor(aSign, aDh))
        assertEquals("3ad080e6c1cec573ea7a1f2ba74dfbe9bba7a0c143f8dd4b221a419254862c50", IdentityCodec.uidFor(bSign, bDh))
    }

    @Test
    fun `identity proof from the desktop verifies`() {
        assertTrue(IdentityCodec.verifyIdentityProof(aSign, aDh, aProof))
    }

    @Test
    fun `identity proof is bound to both keys`() {
        assertFalse(IdentityCodec.verifyIdentityProof(bSign, aDh, aProof))
        assertFalse(IdentityCodec.verifyIdentityProof(aSign, bDh, aProof))
        assertFalse(IdentityCodec.verifyIdentityProof(aSign, aDh, aProof.reversed()))
    }

    @Test
    fun `safety number matches the desktop and is symmetric`() {
        assertEquals("31645 65790 46562 50308 78044 20271", IdentityCodec.safetyNumber(aSign, bSign))
        assertEquals(IdentityCodec.safetyNumber(aSign, bSign), IdentityCodec.safetyNumber(bSign, aSign))
    }
}
