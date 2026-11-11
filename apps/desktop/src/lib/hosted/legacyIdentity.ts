/**
 * Carries the identity the page already holds over to the Rust engine, so nobody re-enters their recovery phrase. The engine
 * keeps the identity as two private scalars (signing, then agreement; 32 bytes each); the page keeps them as the `d` of two
 * P-256 JWKs. The two come from the same derivation, so the scalars are the same bytes.
 */
import type { DeviceIdentity } from '../identity';

function scalarBytes(jwk: JsonWebKey): Uint8Array {
  if (!jwk.d) throw new Error('The identity has no private key.');
  const padded = jwk.d.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(jwk.d.length / 4) * 4, '=');
  const raw = atob(padded);
  if (raw.length > 32) throw new Error('The identity key has the wrong size.');
  const out = new Uint8Array(32);
  for (let i = 0; i < raw.length; i += 1) out[32 - raw.length + i] = raw.charCodeAt(i);
  return out;
}

/** Signing scalar then agreement scalar, as 128 hex characters. */
export function legacySecretsHex(identity: Pick<DeviceIdentity, 'privateJwk' | 'dhPrivateJwk'>): string {
  return [...scalarBytes(identity.privateJwk), ...scalarBytes(identity.dhPrivateJwk)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Give the shell the identity (once; it ignores this when the engine already has one). */
export async function seedEngineIdentity(identity: Pick<DeviceIdentity, 'privateJwk' | 'dhPrivateJwk'>): Promise<boolean> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<boolean>('engine_seed_identity', { secretsHex: legacySecretsHex(identity) });
}
