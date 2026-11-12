import {
  canonicalJson,
  concatBytes,
  fromB64Url,
  sha256,
  toB64Url,
  validatePublicJwk,
  verifyIdentityProof,
  type PublicJwk,
} from '../e2ee';

export const CONTACT_CARD_PREFIX = 'DUOID1:';

/** Public identity handed to a friend (QR / paste). Contains no secrets. */
export interface ContactCard {
  v: 1;
  sign: PublicJwk;
  dh: PublicJwk;
  proof: string;
  name?: string;
}

export interface Contact {
  uid: string;
  card: ContactCard;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function keyBytes(key: PublicJwk): Uint8Array {
  if (!key.x || !key.y) throw new Error('incomplete public key');
  return concatBytes(enc.encode(`${key.kty}|${key.crv}|`), fromB64Url(key.x), enc.encode('|'), fromB64Url(key.y));
}

/**
 * The person's id: SHA-256 (hex) of both public keys, `duocord-uid-v2\n<ECDH key>\n<signing key>`. Both are in it: a card
 * proves only that its signing key signed the ECDH key, so an id from the ECDH key alone let anyone claim someone else's
 * id with their own signing key. Same as `uid_from_keys` in the Rust crate.
 */
export async function uidFromKeys(sign: PublicJwk, dh: PublicJwk): Promise<string> {
  const bytes = await sha256(concatBytes(enc.encode('duocord-uid-v2\n'), keyBytes(dh), enc.encode('\n'), keyBytes(sign)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function encodeContactCard(card: ContactCard): string {
  const slim: ContactCard = {
    v: 1,
    sign: { kty: card.sign.kty, crv: card.sign.crv, x: card.sign.x, y: card.sign.y },
    dh: { kty: card.dh.kty, crv: card.dh.crv, x: card.dh.x, y: card.dh.y },
    proof: card.proof,
    ...(card.name ? { name: card.name.slice(0, 40) } : {}),
  };
  return CONTACT_CARD_PREFIX + toB64Url(enc.encode(canonicalJson(slim)));
}

/** Parses and cryptographically validates a card. Returns null if anything is off. */
export async function decodeContactCard(text: string): Promise<Contact | null> {
  try {
    const trimmed = text.trim();
    if (!trimmed.startsWith(CONTACT_CARD_PREFIX)) return null;
    const card: unknown = JSON.parse(dec.decode(fromB64Url(trimmed.slice(CONTACT_CARD_PREFIX.length))));
    if (typeof card !== 'object' || card === null) return null;
    const c = card as Record<string, unknown>;
    if (c.v !== 1 || typeof c.proof !== 'string') return null;
    if (!validatePublicJwk(c.sign) || !validatePublicJwk(c.dh)) return null;
    if (c.name !== undefined && typeof c.name !== 'string') return null;
    if (!(await verifyIdentityProof(c.sign, c.dh, c.proof))) return null;
    return {
      uid: await uidFromKeys(c.sign, c.dh),
      card: { v: 1, sign: c.sign, dh: c.dh, proof: c.proof, ...(c.name ? { name: String(c.name).slice(0, 40) } : {}) },
    };
  } catch {
    return null;
  }
}
