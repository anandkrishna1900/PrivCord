import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeBlob,
  decodeContactCard,
  deriveIdentityFromPhrase,
  open,
  SecureChannel,
  uidFromDh,
  verifyIdentityProof,
} from '../src';
import { verifyEvent } from '../../../apps/desktop/src/lib/signaling/nostr';

// Written by the Android unit tests (RelayInteropTest "export Kotlin made artifacts"). Run
// `gradle :app:testDebugUnitTest` in apps/android first; without the file these checks are skipped.
const file = new URL('../../../apps/android/app/build/interop/kotlin-vectors.json', import.meta.url);
const phrases = {
  ann: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  bob: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
};

describe.skipIf(!existsSync(file))('artifacts produced by the Android app', () => {
  const k = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};

  it('contact card decodes with the same uid and a valid identity proof', async () => {
    const contact = await decodeContactCard(k.card);
    expect(contact?.uid).toBe(k.cardUid);
    expect(contact?.card.name).toBe('Kotlin Ann');
    expect(await verifyIdentityProof(contact!.card.sign, contact!.card.dh, k.proof)).toBe(true);
  });

  it('a blob sealed in Kotlin opens in TypeScript for the right recipient only', async () => {
    const ann = (await deriveIdentityFromPhrase(phrases.ann)).identity;
    const bob = (await deriveIdentityFromPhrase(phrases.bob)).identity;
    const blob = decodeBlob(k.sealedWire)!;
    const payload = await open({
      blob,
      ownUid: k.sealedToUid,
      ownDhPriv: bob.dhKey.privJwk,
      senderSign: ann.signKey.pubJwk,
      senderUid: k.sealedFromUid,
    });
    expect(payload).toEqual({ t: 'msg', text: 'from kotlin ✓' });
    expect(await uidFromDh(bob.dhKey.pubJwk)).toBe(k.sealedToUid);
    const wrong = await open({ blob, ownUid: k.sealedFromUid, ownDhPriv: ann.dhKey.privJwk, senderSign: ann.signKey.pubJwk, senderUid: k.sealedFromUid });
    expect(wrong).toBeNull();
  });

  it('a Nostr event signed in Kotlin passes the desktop verifier', () => {
    expect(verifyEvent(k.event)).toBe(true);
    expect(verifyEvent({ ...k.event, content: k.event.content + 'x' })).toBe(false);
  });
});

// Written by SecureChannelTest ("export Kotlin made frames"). Kotlin plays Bob with the fixed ephemeral key and nonce
// from docs/android-vectors.json; TypeScript plays Ann with hers and must accept, decrypt and reply.
const scFile = new URL('../../../apps/android/app/build/interop/kotlin-securechannel.json', import.meta.url);

describe.skipIf(!existsSync(scFile))('secure channel frames produced by the Android app', () => {
  const k = existsSync(scFile) ? JSON.parse(readFileSync(scFile, 'utf8')) : {};
  const v = JSON.parse(readFileSync(new URL('../../../docs/android-vectors.json', import.meta.url), 'utf8')).secureChannel;

  async function annChannel() {
    const ann = (await deriveIdentityFromPhrase(phrases.ann)).identity;
    const bob = (await deriveIdentityFromPhrase(phrases.bob)).identity;
    return SecureChannel.create({
      ownUid: v.ann.uid,
      peerUid: v.bob.uid,
      signPriv: ann.signKey.privJwk,
      peerSign: bob.signKey.pubJwk,
      testEphemeral: { pubJwk: v.ann.ephPub, privJwk: v.ann.ephPriv },
      testNonce: v.ann.nonce,
    });
  }

  it('accepts the Kotlin hello (signature over the swapped uid order verifies)', async () => {
    const ch = await annChannel();
    await ch.accept(k.hello);
    expect(ch.ready).toBe(true);
  });

  it('decrypts every Kotlin frame, in order, and rejects replay and tampering', async () => {
    const ch = await annChannel();
    await ch.accept(k.hello);
    for (const f of k.frames) expect(JSON.stringify(await ch.decrypt(f.frame))).toBe(f.plaintext);
    await expect(ch.decrypt(k.frames[0].frame)).rejects.toThrow(/replayed/i);
    const ch2 = await annChannel();
    await ch2.accept(k.hello);
    const f = k.frames[0].frame;
    await expect(ch2.decrypt({ ...f, ct: f.ct.slice(0, -2) + (f.ct.endsWith('AA') ? 'BB' : 'AA') })).rejects.toThrow();
  });

  it('the bytes Kotlin encrypts equal what TypeScript encrypts for the same keys (AES-GCM is deterministic)', async () => {
    const ch = await annChannel();
    await ch.accept(k.hello);
    const mine = await ch.encrypt(JSON.parse(k.annReplyPlaintext));
    expect(mine.ct).toBe(k.annReplyCt);
  });
});
