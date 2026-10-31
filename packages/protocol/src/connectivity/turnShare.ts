import { isIceUrl, type TurnServer } from './networkConfig';

/*
 * One pasteable line that carries a relay server (TURN) setup, so a friend group sets it up once and everyone pastes it.
 * It contains the relay's password: share it only with people you want to let use your relay.
 */
export const TURN_SHARE_PREFIX = 'PRIVCORD-TURN1:';

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

export function encodeTurnShare(turn: TurnServer): string {
  return TURN_SHARE_PREFIX + b64(JSON.stringify({ u: turn.urls, n: turn.username, c: turn.credential }));
}

/** Null for anything that is not a well-formed share string. */
export function parseTurnShare(text: string): TurnServer | null {
  const t = text.trim();
  if (!t.startsWith(TURN_SHARE_PREFIX) || t.length > 2000) return null;
  try {
    const o = JSON.parse(unb64(t.slice(TURN_SHARE_PREFIX.length))) as { u?: unknown; n?: unknown; c?: unknown };
    if (!Array.isArray(o.u) || typeof o.n !== 'string' || typeof o.c !== 'string' || !o.n || !o.c) return null;
    const urls = o.u.filter((x): x is string => typeof x === 'string' && isIceUrl(x, ['turn', 'turns']));
    if (urls.length === 0 || urls.length !== o.u.length || urls.length > 6) return null;
    return { urls, username: o.n, credential: o.c };
  } catch {
    return null;
  }
}
