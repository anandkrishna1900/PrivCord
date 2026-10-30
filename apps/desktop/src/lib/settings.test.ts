import { describe, expect, it } from 'vitest';
import { parseSettings } from './settings';

describe('parseSettings', () => {
  it('restores persisted values', () => {
    expect(
      parseSettings(
        JSON.stringify({
          theme: 'dark',
          accent: '#0d9488',
          notificationsEnabled: false,
          notificationPreviews: false,
          displayName: '  Sam  ',
        }),
      ),
    ).toMatchObject({
      theme: 'dark',
      accent: '#0d9488',
      notificationsEnabled: false,
      notificationPreviews: false,
      displayName: 'Sam',
    });
  });

  it('falls back to defaults for missing or malformed storage', () => {
    expect(parseSettings(JSON.stringify({ theme: 'light' })).displayName).toBe('');
    expect(parseSettings('{not json').theme).toBe('system');
    expect(parseSettings(null).accent).toBe('#6366f1');
  });

  it('rejects an invalid accent color', () => {
    expect(parseSettings(JSON.stringify({ accent: 'red' })).accent).toBe('#6366f1');
  });
});
