package com.duochat.app.ble

import com.duochat.app.security.Bip39
import com.duochat.app.security.ContactCard
import com.duochat.app.security.EcKeys
import com.duochat.app.security.IdentityCodec
import com.duochat.app.security.RecoveryIdentity

/** A test identity made from a fixed (public, test-only) phrase. */
class TestPerson(val name: String, val phrase: String) {
    private val keys = RecoveryIdentity.derive(phrase)
    val uid: String = keys.uid
    val card = ContactCard(
        keys.signPub, keys.dhPub,
        EcKeys.sign(keys.signD, IdentityCodec.identityProofPayload(keys.dhPub)), name,
    )
    val signer: (ByteArray) -> String = { EcKeys.sign(keys.signD, it) }

    companion object {
        fun numbered(i: Int, name: String = "P$i") = TestPerson(name, Bip39.fromEntropy(ByteArray(16) { (it + i * 7 + 1).toByte() }))
    }
}
