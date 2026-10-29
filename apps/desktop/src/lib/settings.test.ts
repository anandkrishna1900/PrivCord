import { describe, expect, it } from 'vitest';
import { normalizeMessageMode, parseSettings } from './settings';

describe('normalizeMessageMode', () => {
  it('loads the persisted direct mode', () => {
    expect(normalizeMessageMode('direct')).toBe('direct');
  });

  it('defaults missing or invalid values to cloud', () => {
    expect(normalizeMessageMode(undefined)).toBe('cloud');
    expect(normalizeMessageMode(null)).toBe('cloud');
    expect(normalizeMessageMode('unexpected')).toBe('cloud');
  });
});

describe('parseSettings', () => {
  it('restores a persisted direct mode', () => {
    expect(
      parseSettings(
        JSON.stringify({
          theme: 'dark',
          accent: '#0d9488',
          notificationsEnabled: false,
          notificationPreviews: false,
          messageMode: 'direct',
        }),
      ),
    ).toMatchObject({
      theme: 'dark',
      accent: '#0d9488',
      notificationsEnabled: false,
      notificationPreviews: false,
      messageMode: 'direct',
    });
  });

  it('defaults missing mode and malformed storage to cloud', () => {
    expect(parseSettings(JSON.stringify({ theme: 'light' })).messageMode).toBe('cloud');
    expect(parseSettings('{not json').messageMode).toBe('cloud');
    expect(parseSettings(null).messageMode).toBe('cloud');
  });
});
