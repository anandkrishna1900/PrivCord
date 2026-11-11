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

export function loadNetworkConfig(): NetworkConfig {
  try {
    return parseNetworkConfig(localStorage.getItem(KEY));
  } catch {
    return structuredClone(DEFAULT_NETWORK_CONFIG);
  }
}

export function saveNetworkConfig(config: NetworkConfig): void {
  localStorage.setItem(KEY, JSON.stringify(config));
}

export function rtcConfigFor(config: NetworkConfig): RTCConfiguration {
  return {
    iceServers: iceServersFor(config, BUILTIN_TURN),
    iceTransportPolicy: config.forceRelay ? 'relay' : 'all',
  };
}
