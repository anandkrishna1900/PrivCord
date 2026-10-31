import { aesGcmDecrypt, aesGcmEncrypt, fromB64Url, randomBytes, toB64Url } from './e2ee';

/*
 * Encrypted chat backup. The file holds chats, friends, groups and channels, protected by a passphrase the user
 * chooses (the 12-word recovery phrase restores the identity itself; it is deliberately not stored here).
 * Files and photos are not included. A wrong passphrase and a damaged file look the same: nothing opens.
 */

export const BACKUP_PREFIX = 'PRIVCORD-BACKUP1:';
export const BACKUP_MIN_PASSPHRASE = 8;
const ITERATIONS = 300_000;
const AAD = new TextEncoder().encode('privcord-backup-v1');

async function keyFrom(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, 256));
}

export async function sealBackup(data: unknown, passphrase: string): Promise<string> {
  if (passphrase.length < BACKUP_MIN_PASSPHRASE) throw new Error(`Use at least ${BACKUP_MIN_PASSPHRASE} characters.`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await keyFrom(passphrase, salt, ITERATIONS);
  const ct = await aesGcmEncrypt(key, iv, new TextEncoder().encode(JSON.stringify(data)), AAD);
  const body = { v: 1, it: ITERATIONS, salt: toB64Url(salt), iv: toB64Url(iv), ct: toB64Url(ct) };
  return BACKUP_PREFIX + toB64Url(new TextEncoder().encode(JSON.stringify(body)));
}

/** The data, or null for a wrong passphrase, a damaged file or something that is not a backup. */
export async function openBackup(text: string, passphrase: string): Promise<unknown | null> {
  try {
    const trimmed = text.trim();
    if (!trimmed.startsWith(BACKUP_PREFIX)) return null;
    const body = JSON.parse(new TextDecoder().decode(fromB64Url(trimmed.slice(BACKUP_PREFIX.length)))) as {
      v?: unknown; it?: unknown; salt?: unknown; iv?: unknown; ct?: unknown;
    };
    if (body.v !== 1 || typeof body.it !== 'number' || body.it < 100_000 || body.it > 2_000_000) return null;
    if (typeof body.salt !== 'string' || typeof body.iv !== 'string' || typeof body.ct !== 'string') return null;
    const key = await keyFrom(passphrase, fromB64Url(body.salt), body.it);
    const plain = await aesGcmDecrypt(key, fromB64Url(body.iv), fromB64Url(body.ct), AAD);
    return JSON.parse(new TextDecoder().decode(plain)) as unknown;
  } catch {
    return null;
  }
}
