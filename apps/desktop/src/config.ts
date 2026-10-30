const env = import.meta.env;

function value(name: keyof ImportMetaEnv): string {
  return (env[name] ?? '').trim();
}

export const config = {
  conversationId: value('VITE_CONVERSATION_ID') || 'duo',
  appVersion: __APP_VERSION__,
} as const;

export function isTauri(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}
