/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONVERSATION_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;

interface Window {
  __TAURI_INTERNALS__?: unknown;
}
