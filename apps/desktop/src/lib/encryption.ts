import { secretGet, secretSet } from './secureStore';

export interface TextCipher {
  encrypt(text: string): Promise<string>;
  decrypt(payload: string): Promise<string>;
  /** Files at rest: output is 12-byte IV followed by AES-GCM ciphertext. */
  encryptBytes(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
  decryptBytes(payload: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
}

const PREFIX = 'enc1.';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}

export async function createTextCipher(uid: string): Promise<TextCipher> {
  const secretKey = `aes-key-${uid}`;
  let raw = await secretGet(secretKey);
  if (!raw) {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    raw = toBase64Url(keyBytes);
    await secretSet(secretKey, raw);
  }
  const key = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(raw),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );

  return {
    async encryptBytes(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes as Uint8Array<ArrayBuffer>));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv, 0);
      out.set(ct, 12);
      return out;
    },
    async decryptBytes(payload: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
      if (payload.length < 29) throw new Error('Malformed encrypted file.');
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.slice(0, 12) }, key, payload.slice(12));
      return new Uint8Array(pt);
    },
    async encrypt(text: string): Promise<string> {
      if (!text) return text;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(text),
      );
      return `${PREFIX}${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
    },
    async decrypt(payload: string): Promise<string> {
      if (!payload.startsWith(PREFIX)) return payload;
      const [ivPart, cipherPart] = payload.slice(PREFIX.length).split('.');
      if (!ivPart || !cipherPart) throw new Error('Malformed encrypted message.');
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64Url(ivPart) },
        key,
        fromBase64Url(cipherPart),
      );
      return new TextDecoder().decode(plaintext);
    },
  };
}
