import { describe, expect, it } from 'vitest';
import { THEMES, accentFill, contrast, themeById, themeVars } from './themes';

describe('built-in themes', () => {
  it('has at least ten, with unique ids and names', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(new Set(THEMES.map((t) => t.name)).size).toBe(THEMES.length);
    expect(THEMES.some((t) => t.dark)).toBe(true);
    expect(THEMES.some((t) => !t.dark)).toBe(true);
  });

  it.each(THEMES)('$name: text, muted text and filled buttons are readable', (t) => {
    const v = themeVars(t);
    expect(contrast(t.text, t.bg), 'text on background').toBeGreaterThanOrEqual(7);
    expect(contrast(t.text, t.surface), 'text on surface').toBeGreaterThanOrEqual(7);
    expect(contrast(v['--muted']!, t.bg), 'muted text').toBeGreaterThanOrEqual(3.5);
    expect(contrast(v['--muted']!, t.surface), 'muted on surface').toBeGreaterThanOrEqual(3);
    expect(contrast('#ffffff', v['--accent-fill']!), 'white text on filled accent').toBeGreaterThanOrEqual(4.5);
    // the accent itself (links, icons, focus rings) must stand out from the page
    expect(contrast(t.accent, t.bg), 'accent on background').toBeGreaterThanOrEqual(3);
  });

  it('sets every variable as a plain CSS value', () => {
    for (const t of THEMES) for (const [k, val] of Object.entries(themeVars(t))) {
      expect(k.startsWith('--')).toBe(true);
      expect(val).not.toMatch(/undefined|NaN/);
    }
  });

  it('finds themes by id and darkens only as much as needed', () => {
    expect(themeById('nord')?.name).toBe('Nord');
    expect(themeById('nope')).toBeUndefined();
    expect(accentFill('#000080')).toBe('#000080');
  });
});
