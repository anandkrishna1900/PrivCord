import { isValidPublicJwk } from './signaling';

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function jwkThumbprintInput(jwk: JsonWebKey): string {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

/**
 * Six five-digit groups derived from both identity keys. Both users compare
 * this value out of band. It detects a swapped/mismatched peer key; it is not a
 * substitute for an audited end-to-end encryption protocol.
 */
export async function deriveSafetyNumber(
  first: JsonWebKey,
  second: JsonWebKey,
): Promise<string> {
  if (!isValidPublicJwk(first) || !isValidPublicJwk(second)) {
    throw new Error('Both P-256 public keys are required.');
  }
  const a = bytesToHex(await sha256(new TextEncoder().encode(jwkThumbprintInput(first))));
  const b = bytesToHex(await sha256(new TextEncoder().encode(jwkThumbprintInput(second))));
  const ordered = [a, b].sort();
  const digest = await sha256(new TextEncoder().encode(`${ordered[0]}|${ordered[1]}`));
  const groups: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const offset = i * 3;
    const value = ((digest[offset]! << 16) | (digest[offset + 1]! << 8) | digest[offset + 2]!) % 100000;
    groups.push(value.toString().padStart(5, '0'));
  }
  return groups.join(' ');
}

export function exportPublicJwk(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', key).then((jwk) => ({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  }));
}

export function importPublicJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

export function signatureToBase64(signature: ArrayBuffer): string {
  const bytes = new Uint8Array(signature);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function signatureFromBase64(value: string): Uint8Array<ArrayBuffer> {
  return base64UrlToBytes(value);
}
