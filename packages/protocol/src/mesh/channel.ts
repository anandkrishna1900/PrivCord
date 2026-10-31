import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  createEcdhKeypair,
  fromB64Url,
  hkdf,
  randomBytes,
  sha256,
  toB64Url,
  type PrivateJwk,
} from '../e2ee';
import { decodeContactCard, encodeContactCard, type Contact, type ContactCard } from '../connectivity/contactCard';
import { signBlob, validateBlob, verifyBlobSignature, type SealedBlob } from '../connectivity/seal';

/*
 * Open channels: public, named chat rooms such as #general or #lagos. Anyone who types the same name is in the
 * same room, there is no owner and no member list. Every message is signed with the sender's identity, so nobody
 * can speak as somebody else, but it is NOT private: anyone who knows the channel name can read it. (A
 * hard-to-guess name works like a shared password, which is useful for a private room among friends.)
 *
 * The name is turned into a relay mailbox and an AES key, so a relay operator sees only a hash and ciphertext
 * unless they already know the name. The same sealed message travels over internet relays and over the
 * Bluetooth mesh (see node.ts).
 */

export const MAX_CHANNEL_NAME = 32;
export const MAX_CHANNEL_TEXT = 500;
export const CHANNEL_TTL_SEC = 24 * 3600;
const SALT = 'duochat-channel-v1';
const MAILBOX_PREFIX = 'duochat-channel-mailbox-v1|';

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** "  #General Chat " -> "general-chat". Letters, digits (any language) and dashes only; null if nothing is left. */
export function normalizeChannelName(raw: string): string | null {
  const name = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_CHANNEL_NAME)
    .replace(/-+$/g, '');
  return name.length > 0 ? name : null;
}

export interface ChannelKeys {
  name: string;
  /** Where the channel meets on a relay. */
  mailbox: string;
  key: Uint8Array;
  /** Short label stored in a blob's `to` so a receiver knows which joined channel it is for. */
  tag: string;
}

export async function deriveChannel(name: string): Promise<ChannelKeys> {
  const digest = await sha256(enc.encode(MAILBOX_PREFIX + name));
  const mailbox = hex(digest);
  return { name, mailbox, tag: `ch:${mailbox.slice(0, 16)}`, key: await hkdf(digest, enc.encode(SALT), enc.encode('key'), 32) };
}

export interface ChannelMessage {
  channel: string;
  text: string;
  /** The sender's clock; only used to order messages. */
  at: number;
  contact: Contact;
}

export async function sealChannelMessage(input: {
  channel: ChannelKeys;
  text: string;
  at: number;
  card: ContactCard;
  uid: string;
  signPriv: PrivateJwk;
}): Promise<SealedBlob> {
  const text = Array.from(input.text.trim()).slice(0, MAX_CHANNEL_TEXT).join('');
  if (!text) throw new Error('Message cannot be empty.');
  const iv = randomBytes(12);
  const body = JSON.stringify({ c: input.channel.name, t: text, at: input.at, card: encodeContactCard(input.card) });
  const ct = await aesGcmEncrypt(input.channel.key, iv, enc.encode(body), enc.encode(`${input.channel.tag}|${input.uid}`));
  const ephemeral = await createEcdhKeypair(); // unused; keeps the blob shape that relays and clients already validate
  const unsigned = {
    v: 1 as const,
    to: input.channel.tag,
    from: input.uid,
    epk: { kty: ephemeral.pubJwk.kty, crv: ephemeral.pubJwk.crv, x: ephemeral.pubJwk.x, y: ephemeral.pubJwk.y },
    iv: toB64Url(iv),
    ct: toB64Url(ct),
  };
  return { ...unsigned, sig: await signBlob(unsigned, input.signPriv) };
}

/** Decrypts with the channel name, checks the sender's card is genuine and really signed this. Null otherwise. */
export async function openChannelMessage(channel: ChannelKeys, blob: unknown): Promise<ChannelMessage | null> {
  try {
    if (!validateBlob(blob) || blob.to !== channel.tag) return null;
    const plain = await aesGcmDecrypt(channel.key, fromB64Url(blob.iv), fromB64Url(blob.ct), enc.encode(`${channel.tag}|${blob.from}`));
    const body = JSON.parse(dec.decode(plain)) as { c?: unknown; t?: unknown; at?: unknown; card?: unknown };
    if (body.c !== channel.name || typeof body.t !== 'string' || typeof body.card !== 'string') return null;
    if (typeof body.at !== 'number' || !Number.isFinite(body.at) || body.at <= 0) return null;
    if (body.t.trim().length === 0 || Array.from(body.t).length > MAX_CHANNEL_TEXT) return null;
    const contact = await decodeContactCard(body.card);
    if (!contact || contact.uid !== blob.from) return null;
    if (!(await verifyBlobSignature(blob, contact.card.sign))) return null;
    return { channel: channel.name, text: body.t, at: body.at, contact };
  } catch {
    return null;
  }
}
