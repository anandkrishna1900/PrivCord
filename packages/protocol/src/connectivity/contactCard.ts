import {
  canonicalJson,
  fromB64Url,
  identityFingerprintHex,
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

export function uidFromDh(dh: PublicJwk): Promise<string> {
  return identityFingerprintHex(dh);
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
      uid: await uidFromDh(c.dh),
      card: { v: 1, sign: c.sign, dh: c.dh, proof: c.proof, ...(c.name ? { name: String(c.name).slice(0, 40) } : {}) },
    };
  } catch {
    return null;
  }
}
