import { DEFAULT_STUN_URLS } from '@duochat/protocol';

const env = import.meta.env;

function value(name: keyof ImportMetaEnv): string {
  return (env[name] ?? '').trim();
}

const stunSetting = value('VITE_STUN_URLS');
const stunDisabled = stunSetting.toLowerCase() === 'none';
const stunUrls = stunDisabled
  ? []
  : stunSetting
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean);

const turnUrl = value('VITE_TURN_URL');
const turnUsername = value('VITE_TURN_USERNAME');
const turnCredential = value('VITE_TURN_CREDENTIAL');

export const config = {
  conversationId: value('VITE_CONVERSATION_ID') || 'duo',
  stunUrls: stunDisabled ? [] : stunUrls.length > 0 ? stunUrls : DEFAULT_STUN_URLS,
  turn:
    turnUrl && turnUsername && turnCredential
      ? {
          urls: turnUrl.split(',').map((url) => url.trim()).filter(Boolean),
          username: turnUsername,
          credential: turnCredential,
        }
      : null,
  appVersion: '0.1.0',
} as const;

export function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = config.stunUrls.length > 0 ? [{ urls: [...config.stunUrls] }] : [];
  if (config.turn) servers.push(config.turn);
  return servers;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}
