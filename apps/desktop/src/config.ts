const env = import.meta.env;

function value(name: keyof ImportMetaEnv): string {
  return (env[name] ?? '').trim();
}

export const config = {
  conversationId: value('VITE_CONVERSATION_ID') || 'duo',
  appVersion: '0.1.0',
} as const;

export function isTauri(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}
