import { describe, expect, it } from 'vitest';
import {
  INVITE_WORDS,
  deriveInvite,
  deriveIdentityFromPhrase,
  generateRecoveryPhrase,
  newInviteWords,
  openInvite,
  parseInviteWords,
  sealInvite,
  uidFromDh,
  validateBlob,
  encodeBlob,
  MAX_SEALED_BLOB_BYTES,
  type ContactCard,
} from '../src';

async function person(name: string) {
  const { identity } = await deriveIdentityFromPhrase(generateRecoveryPhrase());
  const card: ContactCard = { v: 1, sign: identity.signKey.pubJwk, dh: identity.dhKey.pubJwk, proof: identity.identityProof, name };
  return { uid: await uidFromDh(identity.dhKey.pubJwk), card, signPriv: identity.signKey.privJwk };
}

describe('six-word invite codes', () => {
  it('makes six distinct-looking valid words that parse back from messy typing', () => {
    const words = newInviteWords();
    expect(words).toHaveLength(INVITE_WORDS);
    expect(parseInviteWords(words.join(' '))).toEqual(words);
    expect(parseInviteWords('  ' + words.join(' - ').toUpperCase() + '\n')).toEqual(words);
    expect(parseInviteWords(words.slice(0, 5).join(' '))).toBeNull();
    expect(parseInviteWords([...words.slice(0, 5), 'notaword'].join(' '))).toBeNull();
    expect(parseInviteWords([...words, 'abandon'].join(' '))).toBeNull();
    expect(new Set(Array.from({ length: 20 }, () => newInviteWords().join(' '))).size).toBe(20);
  });

  it('the same words always meet at the same mailbox with the same key; other words do not', async () => {
    const words = ['abandon', 'ability', 'able', 'about', 'above', 'absent'];
    const a = await deriveInvite(words);
    const b = await deriveInvite([...words]);
    expect(a.mailbox).toBe(b.mailbox);
    expect(Array.from(a.key)).toEqual(Array.from(b.key));
    const other = await deriveInvite(['abandon', 'ability', 'able', 'about', 'above', 'absorb']);
    expect(other.mailbox).not.toBe(a.mailbox);
  });

  it('card goes in, the same card comes out, and the reply works the other way', async () => {
    const [ann, ben] = [await person('Ann'), await person('Ben')];
    const rv = await deriveInvite(newInviteWords());
    const cardBlob = await sealInvite({ rendezvous: rv, kind: 'card', card: ann.card, uid: ann.uid, signPriv: ann.signPriv });
    expect(validateBlob(cardBlob)).toBe(true);
    expect(encodeBlob(cardBlob).length).toBeLessThan(MAX_SEALED_BLOB_BYTES);
    const got = await openInvite(rv, cardBlob);
    expect(got?.kind).toBe('card');
    expect(got?.contact.uid).toBe(ann.uid);
    expect(got?.contact.card.name).toBe('Ann');
    const reply = await sealInvite({ rendezvous: rv, kind: 'reply', card: ben.card, uid: ben.uid, signPriv: ben.signPriv });
    const back = await openInvite(rv, reply);
    expect(back?.kind).toBe('reply');
    expect(back?.contact.uid).toBe(ben.uid);
  });

  it('wrong code, tampering, a card that is not the sender, and a forged signature are all rejected', async () => {
    const [ann, mallory] = [await person('Ann'), await person('Mallory')];
    const rv = await deriveInvite(newInviteWords());
    const blob = await sealInvite({ rendezvous: rv, kind: 'card', card: ann.card, uid: ann.uid, signPriv: ann.signPriv });
    expect(await openInvite(await deriveInvite(newInviteWords()), blob)).toBeNull();
    expect(await openInvite(rv, { ...blob, ct: blob.ct.slice(0, -4) + 'AAAA' })).toBeNull();
    expect(await openInvite(rv, { ...blob, from: mallory.uid })).toBeNull();
    expect(await openInvite(rv, { ...blob, to: 'someone' })).toBeNull();
    // Mallory knows the code and publishes Ann's card but signs with her own key: signature check fails.
    const forged = await sealInvite({ rendezvous: rv, kind: 'card', card: ann.card, uid: ann.uid, signPriv: mallory.signPriv });
    expect(await openInvite(rv, forged)).toBeNull();
    // Mallory publishes her own genuine card: it opens, but as Mallory, never as Ann.
    const hers = await sealInvite({ rendezvous: rv, kind: 'card', card: mallory.card, uid: mallory.uid, signPriv: mallory.signPriv });
    expect((await openInvite(rv, hers))?.contact.uid).toBe(mallory.uid);
    expect(await openInvite(rv, null)).toBeNull();
  });
});
