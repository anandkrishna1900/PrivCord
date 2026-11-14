import {
  DEFAULT_NETWORK_CONFIG,
  iceServersFor,
  parseNetworkConfig,
  type NetworkConfig,
  type TurnServer,
} from '@duochat/protocol';

/**
 * The TURN relay this release was built with (VITE_PRIVCORD_TURN_URLS / _USERNAME / _CREDENTIAL at build time; see
 * docs/turn-server/README.md), or none. It relays encrypted traffic only when two devices cannot reach each other directly.
 */
export const BUILTIN_TURN: TurnServer | null = (() => {
  const env = import.meta.env as Record<string, string | undefined>;
  const urls = (env.VITE_PRIVCORD_TURN_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) return null;
  return { urls, username: env.VITE_PRIVCORD_TURN_USERNAME ?? '', credential: env.VITE_PRIVCORD_TURN_CREDENTIAL ?? '' };
})();

const KEY = 'duochat.network.v1';

/** Whether this window was opened through Tor (private mode); read from the app once at start. */
let torActive = false;

export async function loadTorMode(): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    torActive = (await invoke<boolean>('tor_mode')) === true;
  } catch {
    torActive = false;
  }
  return torActive;
}

export function torModeActive(): boolean {
  return torActive;
}

/** Turns private mode on or off. The app restarts to apply it. */
export async function setTorMode(on: boolean): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_tor_mode', { on });
}

export function loadNetworkConfig(): NetworkConfig {
  let config: NetworkConfig;
  try {
    config = parseNetworkConfig(localStorage.getItem(KEY));
  } catch {
    config = structuredClone(DEFAULT_NETWORK_CONFIG);
  }
  return torActive ? { ...config, torMode: true } : config;
}

export function saveNetworkConfig(config: NetworkConfig): void {
  const { torMode: _ignored, ...saved } = config;
  localStorage.setItem(KEY, JSON.stringify(saved));
}

export function rtcConfigFor(config: NetworkConfig): RTCConfiguration {
  return {
    iceServers: iceServersFor(config, BUILTIN_TURN),
    iceTransportPolicy: config.forceRelay ? 'relay' : 'all',
  };
}
