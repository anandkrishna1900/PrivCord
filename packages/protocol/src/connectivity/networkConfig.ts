import { DEFAULT_STUN_URLS } from '../constants';

export type TransportMode = 'AUTOMATIC' | 'BLUETOOTH_ONLY' | 'INTERNET_ONLY';

export interface TurnServer {
  urls: string[];
  username: string;
  credential: string;
}

export type SignalingConfig =
  | { kind: 'nostr'; relays: string[] }
  | { kind: 'relay'; url: string };

export interface NetworkConfig {
  stun: string[];
  turn: TurnServer[];
  signaling: SignalingConfig[];
  /** Hold sealed messages on relays while the contact is offline. Off by default. */
  storeForward: boolean;
  /** Use only TURN (hides your IP from the peer; needs a TURN server). */
  forceRelay: boolean;
  /** Also look for the paired friend over Bluetooth LE (needs a Bluetooth-capable build). */
  bluetooth: boolean;
  /** User-selected transport mode: AUTOMATIC (default), BLUETOOTH_ONLY, INTERNET_ONLY */
  transportMode?: TransportMode;
}

export const DEFAULT_NOSTR_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

export const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  stun: [...DEFAULT_STUN_URLS],
  turn: [],
  signaling: [{ kind: 'nostr', relays: [...DEFAULT_NOSTR_RELAYS] }],
  storeForward: false,
  forceRelay: false,
  bluetooth: true,
  transportMode: 'AUTOMATIC',
};

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 512;
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr).map((s) => s.trim()) : []);

export function isWsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'wss:' || u.protocol === 'ws:';
  } catch {
    return false;
  }
}

export function isIceUrl(value: string, schemes: string[]): boolean {
  const m = /^([a-z]+):[^\s]+$/i.exec(value.trim());
  return m !== null && schemes.includes(m[1]!.toLowerCase());
}

/** Tolerant parser: bad entries are dropped, a bad blob falls back to defaults. */
export function parseNetworkConfig(raw: string | null | undefined): NetworkConfig {
  if (!raw) return structuredClone(DEFAULT_NETWORK_CONFIG);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return structuredClone(DEFAULT_NETWORK_CONFIG);
  }
  if (typeof parsed !== 'object' || parsed === null) return structuredClone(DEFAULT_NETWORK_CONFIG);
  const p = parsed as Record<string, unknown>;
  const turn: TurnServer[] = Array.isArray(p.turn)
    ? p.turn.flatMap((t): TurnServer[] => {
        if (typeof t !== 'object' || t === null) return [];
        const o = t as Record<string, unknown>;
        const urls = strList(o.urls).filter((u) => isIceUrl(u, ['turn', 'turns']));
        if (urls.length === 0 || typeof o.username !== 'string' || typeof o.credential !== 'string') return [];
        return [{ urls, username: o.username, credential: o.credential }];
      })
    : [];
  const signaling: SignalingConfig[] = Array.isArray(p.signaling)
    ? p.signaling.flatMap((s): SignalingConfig[] => {
        if (typeof s !== 'object' || s === null) return [];
        const o = s as Record<string, unknown>;
        if (o.kind === 'nostr') {
          const relays = strList(o.relays).filter(isWsUrl);
          return relays.length > 0 ? [{ kind: 'nostr', relays }] : [];
        }
        if (o.kind === 'relay' && isStr(o.url) && isWsUrl(o.url)) return [{ kind: 'relay', url: o.url.trim() }];
        return [];
      })
    : structuredClone(DEFAULT_NETWORK_CONFIG.signaling);

  let mode: TransportMode = 'AUTOMATIC';
  if (p.transportMode === 'BLUETOOTH_ONLY' || p.transportMode === 'INTERNET_ONLY') {
    mode = p.transportMode;
  }

  return {
    stun: Array.isArray(p.stun) ? strList(p.stun).filter((u) => isIceUrl(u, ['stun', 'stuns'])) : [...DEFAULT_STUN_URLS],
    turn,
    signaling,
    storeForward: p.storeForward === true,
    forceRelay: p.forceRelay === true,
    bluetooth: p.bluetooth !== false,
    transportMode: mode,
  };
}

export function iceServersFor(config: NetworkConfig): { urls: string[]; username?: string; credential?: string }[] {
  const servers: { urls: string[]; username?: string; credential?: string }[] = [];
  if (config.stun.length > 0) servers.push({ urls: config.stun });
  for (const t of config.turn) servers.push({ urls: t.urls, username: t.username, credential: t.credential });
  return servers;
}
