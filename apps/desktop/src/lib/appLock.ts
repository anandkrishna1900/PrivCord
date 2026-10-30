/*
 * App lock with a platform passkey (Windows Hello: face, fingerprint or PIN). It uses WebAuthn, so the
 * private key never leaves the device's authenticator, and "user verification" is always required.
 *
 * What it protects: someone who sits down at your unlocked computer or opens the app window. What it does
 * not protect: someone who copies the app's files off the disk. That is a different threat; the files on
 * disk are encrypted separately (see docs/KNOWN_LIMITATIONS.md).
 */

const KEY = 'duochat.applock.v1';

interface LockRecord {
  /** The passkey's credential id, base64url. */
  id: string;
  /** Its public key (SPKI, ES256), base64url, used to check every unlock. */
  pub: string;
}

const b64 = (bytes: ArrayBuffer | Uint8Array): string => {
  let s = '';
  for (const b of new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes.buffer)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const unb64 = (v: string): Uint8Array<ArrayBuffer> => {
  const n = v.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(n + '='.repeat((4 - (n.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
};

function read(): LockRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LockRecord>;
    return typeof v.id === 'string' && typeof v.pub === 'string' ? { id: v.id, pub: v.pub } : null;
  } catch {
    return null;
  }
}

export function isLockEnabled(): boolean {
  return read() !== null;
}

/** Can this device make a platform passkey (a Windows Hello / biometric / PIN authenticator)? */
export async function lockSupported(): Promise<boolean> {
  try {
    return (
      typeof PublicKeyCredential !== 'undefined' &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
    );
  } catch {
    return false;
  }
}

/** Create the passkey and turn the lock on. Throws a readable error if the user cancels or it is not possible. */
export async function enableLock(): Promise<void> {
  if (!(await lockSupported())) throw new Error('This device has no Windows Hello, fingerprint, face or PIN set up for passkeys.');
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'PrivCord' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'privcord-local', displayName: 'PrivCord on this device' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60_000,
      attestation: 'none',
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was created.');
  const response = cred.response as AuthenticatorAttestationResponse;
  const pub = response.getPublicKey?.();
  if (!pub) throw new Error('This device did not give a usable passkey key.');
  localStorage.setItem(KEY, JSON.stringify({ id: b64(cred.rawId), pub: b64(pub) } satisfies LockRecord));
}

/** Turn the lock off. The caller must have unlocked just before. */
export function disableLock(): void {
  localStorage.removeItem(KEY);
}

/** ECDSA signatures from WebAuthn are DER; WebCrypto wants the raw r||s form. */
function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> {
  let i = 2;
  if (der[1]! & 0x80) i += der[1]! & 0x7f;
  const read = (): Uint8Array => {
    i += 1; // 0x02
    const len = der[i]!;
    i += 1;
    let part = der.slice(i, i + len);
    i += len;
    while (part.length > 32 && part[0] === 0) part = part.slice(1);
    const out = new Uint8Array(32);
    out.set(part, 32 - part.length);
    return out;
  };
  const r = read();
  const s = read();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/**
 * Ask the user to prove it is them (Windows Hello). True only if the authenticator verified the user AND the
 * signature checks out against the passkey we stored, for a fresh challenge and this app's origin.
 */
export async function unlock(): Promise<boolean> {
  const rec = read();
  if (!rec) return true;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const got = (await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ type: 'public-key', id: unb64(rec.id) }],
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!got) return false;
  const r = got.response as AuthenticatorAssertionResponse;
  const authData = new Uint8Array(r.authenticatorData);
  const clientBytes = new Uint8Array(r.clientDataJSON);
  const client = JSON.parse(new TextDecoder().decode(clientBytes)) as { type?: string; challenge?: string; origin?: string };
  if (client.type !== 'webauthn.get' || client.challenge !== b64(challenge) || client.origin !== location.origin) return false;
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(location.hostname)));
  if (authData.length < 37 || !rpHash.every((b, k) => b === authData[k])) return false;
  const flags = authData[32]!;
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) return false; // user present AND user verified
  const key = await crypto.subtle.importKey('spki', unb64(rec.pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData, 0);
  signed.set(new Uint8Array(await crypto.subtle.digest('SHA-256', clientBytes)), authData.length);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(new Uint8Array(r.signature)), signed);
}

/** Lock again after the window has been out of sight this long. */
export const RELOCK_AFTER_MS = 5 * 60_000;
