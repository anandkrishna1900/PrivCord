import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeBlob,
  decodeContactCard,
  deriveIdentityFromPhrase,
  open,
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
