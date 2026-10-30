import {
  DEFAULT_NETWORK_CONFIG,
  iceServersFor,
  parseNetworkConfig,
  type NetworkConfig,
} from '@duochat/protocol';

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
    iceServers: iceServersFor(config),
    iceTransportPolicy: config.forceRelay ? 'relay' : 'all',
  };
}
