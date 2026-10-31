import { describe, expect, it } from 'vitest';
import { DICTIONARIES, pickLocale, t } from './i18n';

describe('i18n', () => {
  it('every language has every English key, filled in', () => {
    for (const [lang, dict] of Object.entries(DICTIONARIES)) {
      expect(Object.keys(dict).sort(), lang).toEqual(Object.keys(DICTIONARIES.en!).sort());
      for (const v of Object.values(dict)) expect(v.trim().length).toBeGreaterThan(0);
    }
  });
  it('picks the first supported language, else English', () => {
    expect(pickLocale(['ml-IN', 'fr-CA', 'es'])).toBe('fr');
    expect(pickLocale(['ml-IN'])).toBe('en');
    expect(t('message.deleted', 'es')).toBe('Este mensaje fue eliminado');
    expect(t('message.deleted', 'xx')).toBe('This message was deleted');
  });
});
