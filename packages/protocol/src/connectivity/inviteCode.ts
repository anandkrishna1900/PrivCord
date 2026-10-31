import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  createEcdhKeypair,
  hkdf,
  randomBytes,
  sha256,
  toB64Url,
  fromB64Url,
  type PrivateJwk,
} from '../e2ee';
import { decodeContactCard, encodeContactCard, type Contact, type ContactCard } from './contactCard';
import { signBlob, validateBlob, verifyBlobSignature, type SealedBlob } from './seal';

/*
 * Six-word invite codes.
 *
 * A contact card is too big for six words, so the code is a meeting point instead: 66 bits of randomness
 * (six words from the 2048-word BIP-39 list) from which both people derive the same relay mailbox and the
 * same AES key. The person showing the code publishes their card there, encrypted. Whoever knows the code
 * fetches and decrypts it, then publishes their own card back the same way. The relay only ever sees a
 * hash and an encrypted blob, and a code lives for INVITE_TTL_SEC.
 *
 * Whoever knows the code can read the card (it is public information anyway) and can answer it, so the
 * receiving side always confirms who answered, with the safety numbers.
 */

export const INVITE_WORDS = 6;
export const INVITE_TTL_SEC = 15 * 60;
const PBKDF2_ITERATIONS = 150_000;
const SALT = 'duochat-invite-v1';
const MAILBOX_PREFIX = 'duochat-invite-mailbox-v1|';

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Six random words. 2048 words = 11 bits each, so a masked random value is unbiased. */
export function newInviteWords(): string[] {
  const bytes = randomBytes(INVITE_WORDS * 2);
  return Array.from({ length: INVITE_WORDS }, (_, i) => wordlist[((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!) & 0x7ff]!);
}

/** The six words from what a person typed (any spacing, case or separators), or null if it is not a valid code. */
export function parseInviteWords(text: string): string[] | null {
  const parts = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (parts.length !== INVITE_WORDS) return null;
  return parts.every((w) => wordlist.includes(w)) ? parts : null;
}

export interface InviteRendezvous {
  /** Where both sides meet on the relay. */
  mailbox: string;
  key: Uint8Array;
}

export async function deriveInvite(words: string[]): Promise<InviteRendezvous> {
  const base = await crypto.subtle.importKey('raw', enc.encode(words.join(' ')), 'PBKDF2', false, ['deriveBits']);
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT), iterations: PBKDF2_ITERATIONS }, base, 256),
  );
  return {
    mailbox: hex(await sha256(enc.encode(MAILBOX_PREFIX + hex(seed)))),
    key: await hkdf(seed, enc.encode(SALT), enc.encode('key'), 32),
  };
}

/** `card`: the code's owner publishes their card. `reply`: the person who used the code answers with theirs. */
export type InviteMessageKind = 'card' | 'reply';

export interface InviteMessage {
  kind: InviteMessageKind;
  contact: Contact;
}

export async function sealInvite(input: {
  rendezvous: InviteRendezvous;
  kind: InviteMessageKind;
  card: ContactCard;
  uid: string;
  signPriv: PrivateJwk;
}): Promise<SealedBlob> {
  const iv = randomBytes(12);
  const aad = enc.encode(`invite|${input.uid}`);
  const ct = await aesGcmEncrypt(
    input.rendezvous.key,
    iv,
    enc.encode(JSON.stringify({ t: input.kind, card: encodeContactCard(input.card) })),
    aad,
  );
  const ephemeral = await createEcdhKeypair(); // unused: keeps the blob shape every relay and client already validates
  const unsigned = {
    v: 1 as const,
    to: 'invite',
    from: input.uid,
    epk: { kty: ephemeral.pubJwk.kty, crv: ephemeral.pubJwk.crv, x: ephemeral.pubJwk.x, y: ephemeral.pubJwk.y },
    iv: toB64Url(iv),
    ct: toB64Url(ct),
  };
  return { ...unsigned, sig: await signBlob(unsigned, input.signPriv) };
}

/** Decrypts with the code, checks the card is genuine, belongs to the sender and signed the blob. Null otherwise. */
export async function openInvite(rendezvous: InviteRendezvous, blob: unknown): Promise<InviteMessage | null> {
  try {
    if (!validateBlob(blob) || blob.to !== 'invite') return null;
    const plain = await aesGcmDecrypt(rendezvous.key, fromB64Url(blob.iv), fromB64Url(blob.ct), enc.encode(`invite|${blob.from}`));
    const body = JSON.parse(dec.decode(plain)) as { t?: unknown; card?: unknown };
    if ((body.t !== 'card' && body.t !== 'reply') || typeof body.card !== 'string') return null;
    const contact = await decodeContactCard(body.card);
    if (!contact || contact.uid !== blob.from) return null;
    if (!(await verifyBlobSignature(blob, contact.card.sign))) return null;
    return { kind: body.t, contact };
  } catch {
    return null;
  }
}
