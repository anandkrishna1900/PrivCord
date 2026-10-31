/*
 * Translation-ready text. English is the source; Spanish and French cover the strings moved here so far (the rest of
 * the app is still English and falls back automatically). To add a language: add a block below, nothing else.
 */
const en = {
  'search.placeholder': 'Search messages',
  'diagnosis.deliverViaRelays': 'Deliver via relays',
  'diagnosis.connectionSettings': 'Connection settings',
  'message.deleted': 'This message was deleted',
  'voice.record': 'Record a voice note',
} as const;

export type MessageKey = keyof typeof en;

const es: Record<MessageKey, string> = {
  'search.placeholder': 'Buscar mensajes',
  'diagnosis.deliverViaRelays': 'Entregar por los relés',
  'diagnosis.connectionSettings': 'Ajustes de conexión',
  'message.deleted': 'Este mensaje fue eliminado',
  'voice.record': 'Grabar una nota de voz',
};

const fr: Record<MessageKey, string> = {
  'search.placeholder': 'Rechercher des messages',
  'diagnosis.deliverViaRelays': 'Livrer via les relais',
  'diagnosis.connectionSettings': 'Réglages de connexion',
  'message.deleted': 'Ce message a été supprimé',
  'voice.record': 'Enregistrer une note vocale',
};

export const DICTIONARIES: Record<string, Record<MessageKey, string>> = { en, es, fr };

export function pickLocale(languages: readonly string[]): string {
  for (const l of languages) {
    const base = l.toLowerCase().split('-')[0] ?? '';
    if (base in DICTIONARIES) return base;
  }
  return 'en';
}

export function t(key: MessageKey, locale: string = pickLocale(typeof navigator === 'undefined' ? [] : navigator.languages ?? [])): string {
  return (DICTIONARIES[locale] ?? en)[key] ?? en[key];
}
