import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  GroupSessionManager,
  acceptInitialEnvelope,
  decryptEnvelope,
  restoreSession,
  validateBundle,
  validateEnvelope,
  authChallenge,
  decodeBlob,
  decodeManualSignal,
  parsePairingState,
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

  it('a Nostr event made by Rust has a valid id and BIP-340 signature and carries the blob', () => {
    const e = v.nostr.event;
    const id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
    expect(id).toBe(e.id);
    expect(schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey))).toBe(true);
    expect(e.tags.find((t: string[]) => t[0] === 't')[1]).toBe(v.nostr.mailbox);
    expect(decodeBlob(e.content)).toEqual(v.nostr.blob);
  });

  it('a manual connection code and a pairing record made by Rust are accepted', () => {
    const r = decodeManualSignal(v.manual.code, v.manual.conversation);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fromUid).toBe(v.manual.uid);
    const state = parsePairingState(v.pairing.serialized, v.pairing.peer);
    expect(state.record?.peerUid).toBe(v.pairing.peer);
    expect(state.autoReconnect).toBe(true);
  });

  it('an X3DH session, ratchet messages and a group message made by Rust are read by TypeScript', async () => {
    const e = v.e2ee;
    const dec = (b: Uint8Array) => new TextDecoder().decode(b);
    expect((await validateBundle(e.bundle)).ok).toBe(true);
    expect(validateEnvelope(e.first)).toBe(true);
    // Bob (TypeScript) accepts the first envelope using his identity and the prekeys Rust generated.
    const bob = (await deriveIdentityFromPhrase(v.people.bob.phrase)).identity as never;
    const inventory = {
      getSignedPrekey: (id: number) => (id === e.prekeys.signed.id ? { ...e.prekeys.signed } : null),
      getOneTimePrekey: (id: number) => (id === e.prekeys.oneTime.id ? { ...e.prekeys.oneTime } : null),
    };
    const accepted = await acceptInitialEnvelope(bob, inventory as never, e.first);
    expect(dec(accepted.payload)).toBe('hello from Rust');
    // Alice's side as Rust saved it reads Bob's reply (a DH ratchet step), then Bob reads Alice's next message.
    const alice = restoreSession(e.aliceAfterInit);
    expect(dec(await decryptEnvelope(alice, e.reply))).toBe('reply from Rust');
    const bobSession = restoreSession(e.bobAfterReply);
    expect(dec(await decryptEnvelope(bobSession, e.second))).toBe('second from Rust');
    // Group message.
    const gm = new GroupSessionManager();
    gm.setGroup({ groupId: 'g-rust', name: 'x', createdBy: 'u', createdAt: 1, epoch: 2, members: {} });
    gm.setEpochKey('g-rust', 2, Uint8Array.from(Buffer.from(e.group.epochKeyHex, 'hex')));
    expect(await gm.decrypt(e.group.message)).toEqual({ t: 'group hello from Rust' });
  });
});
