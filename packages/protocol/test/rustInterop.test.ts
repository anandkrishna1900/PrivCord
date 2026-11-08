import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  authChallenge,
  decodeBlob,
  parsePeerFrame,
  uidFromDh,
  decodeContactCard,
  deriveChannel,
  deriveIdentityFromPhrase,
  deriveInvite,
  fromB64Url,
  ecdsaVerify,
  openBackup,
  openChannelMessage,
  openInvite,
  open,
  verifyIdentityProof,
} from '../src';

// Produced by the Rust engine (`cargo run -p privcord-crypto --example gen_vectors`). The Rust tests assert the file is
// reproducible; this suite asserts the TypeScript implementation accepts everything in it, so both directions are covered.
const v = JSON.parse(readFileSync(new URL('../../../docs/rust-vectors.json', import.meta.url), 'utf8'));

describe('artifacts produced by the Rust engine', () => {
  it('contact cards decode with the same uid and a valid proof', async () => {
    const ann = await decodeContactCard(v.people.ann.card);
    expect(ann?.uid).toBe(v.people.ann.uid);
    expect(ann?.card.name).toBe('Ann ✓');
    const bob = await decodeContactCard(v.people.bob.card);
    expect(bob?.uid).toBe(v.people.bob.uid);
    expect(await verifyIdentityProof(ann!.card.sign, ann!.card.dh, v.people.ann.identityProof)).toBe(true);
  });

  it('sealed blobs open for the right recipient and nobody else', async () => {
    const ann = (await deriveIdentityFromPhrase(v.people.ann.phrase)).identity;
    const bob = (await deriveIdentityFromPhrase(v.people.bob.phrase)).identity;
    const [ab, ba] = v.sealed;
    const first = await open({ blob: decodeBlob(ab.wire)!, ownUid: v.people.bob.uid, ownDhPriv: bob.dhKey.privJwk, senderSign: ann.signKey.pubJwk, senderUid: v.people.ann.uid });
    expect(first).toEqual(ab.payload);
    const second = await open({ blob: decodeBlob(ba.wire)!, ownUid: v.people.ann.uid, ownDhPriv: ann.dhKey.privJwk, senderSign: bob.signKey.pubJwk, senderUid: v.people.bob.uid });
    expect(second).toEqual(ba.payload);
    expect(await open({ blob: decodeBlob(ab.wire)!, ownUid: v.people.ann.uid, ownDhPriv: ann.dhKey.privJwk, senderSign: bob.signKey.pubJwk, senderUid: v.people.bob.uid })).toBeNull();
  });

  it('a Rust signature verifies in WebCrypto', async () => {
    const ann = (await deriveIdentityFromPhrase(v.people.ann.phrase)).identity;
    expect(await ecdsaVerify(ann.signKey.pubJwk, fromB64Url(v.signature.sig), new TextEncoder().encode(v.signature.message))).toBe(true);
    expect(await ecdsaVerify(ann.signKey.pubJwk, fromB64Url(v.signature.sig), new TextEncoder().encode('something else'))).toBe(false);
  });

  it('invites derive the same mailbox and open', async () => {
    const rv = await deriveInvite(v.invite.words);
    expect(rv.mailbox).toBe(v.invite.mailbox);
    const card = await openInvite(rv, v.invite.card);
    expect(card?.kind).toBe('card');
    expect(card?.contact.uid).toBe(v.people.ann.uid);
    expect((await openInvite(rv, v.invite.reply))?.kind).toBe('reply');
  });

  it('channel messages open and carry the sender', async () => {
    const ch = await deriveChannel(v.channel.name);
    const m = await openChannelMessage(ch, v.channel.blob);
    expect(m?.text).toBe(v.channel.text);
    expect(m?.contact.uid).toBe(v.people.ann.uid);
  });

  it('backups open with the passphrase and not without it', async () => {
    expect(await openBackup(v.backup.text, v.backup.passphrase)).toEqual(v.backup.data);
    expect(await openBackup(v.backup.text, 'wrong passphrase')).toBeNull();
  });

  it('a legacy handshake made by Rust is accepted by the TypeScript checks', async () => {
    const h = v.peerAuth;
    const ann = (await deriveIdentityFromPhrase(v.people.ann.phrase)).identity;
    const bob = (await deriveIdentityFromPhrase(v.people.bob.phrase)).identity;
    for (const f of [h.annHello, h.bobHello, h.annProof[0], h.bobProof[0], h.annOk[0], h.bobOk[0]]) expect(parsePeerFrame(f)).not.toBeNull();
    // Hellos: the uid is the fingerprint of the ECDH key, and the identity proof binds it to the signing key.
    for (const [hello, id] of [[h.annHello, ann], [h.bobHello, bob]] as const) {
      expect(hello.uid).toBe(await uidFromDh(id.dhKey.pubJwk));
      expect(await verifyIdentityProof(hello.publicKeyJwk, hello.dhJwk, hello.identityProof)).toBe(true);
    }
    // Proofs: each signs the challenge built from both nonces, verified with the sender's signing key.
    const check = async (proof: { uid: string; signature: string }, signer: typeof h.annHello, other: typeof h.annHello) => {
      const challenge = authChallenge({ conversationId: h.context, uid: signer.uid, deviceId: signer.deviceId, nonceSelf: signer.nonce, noncePeer: other.nonce });
      return ecdsaVerify(signer.publicKeyJwk, fromB64Url(proof.signature), new TextEncoder().encode(challenge));
    };
    expect(await check(h.annProof[0], h.annHello, h.bobHello)).toBe(true);
    expect(await check(h.bobProof[0], h.bobHello, h.annHello)).toBe(true);
    expect(h.annOk[0]).toEqual({ v: 1, kind: 'auth_ok', uid: h.annHello.uid });
  });
});
