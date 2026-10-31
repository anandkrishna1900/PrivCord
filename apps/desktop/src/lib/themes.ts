/*
 * Built-in colour themes. Each theme is five colours; everything else (hover states, borders, muted text,
 * filled buttons) is derived so a theme cannot end up with unreadable text. "classic" is not in this list:
 * it is the original look that follows the system light/dark setting and the accent colour picker.
 */

export interface ThemeDef {
  id: string;
  name: string;
  /** Light themes get the light variant of scrollbars, form controls and shadows. */
  dark: boolean;
  bg: string;
  surface: string;
  text: string;
  accent: string;
}

export const THEMES: ThemeDef[] = [
  { id: 'midnight', name: 'Midnight', dark: true, bg: '#0b1020', surface: '#141b2f', text: '#e6e9f5', accent: '#6c8cff' },
  { id: 'graphite', name: 'Graphite', dark: true, bg: '#121212', surface: '#1c1c1e', text: '#ececec', accent: '#6ea0f0' },
  { id: 'amoled', name: 'AMOLED black', dark: true, bg: '#000000', surface: '#0d0d0d', text: '#f2f2f2', accent: '#b57cff' },
  { id: 'ocean', name: 'Ocean', dark: true, bg: '#08141c', surface: '#0f2230', text: '#e3f2f8', accent: '#1fa8cc' },
  { id: 'forest', name: 'Forest', dark: true, bg: '#0c1510', surface: '#14231a', text: '#e6f2ea', accent: '#3fb67c' },
  { id: 'sunset', name: 'Sunset', dark: true, bg: '#1a100c', surface: '#2a1913', text: '#f8ebe3', accent: '#f0783a' },
  { id: 'rose', name: 'Rose', dark: true, bg: '#1a0d13', surface: '#2a1520', text: '#f8e8ef', accent: '#e8447f' },
  { id: 'lavender', name: 'Lavender', dark: true, bg: '#13101f', surface: '#1e1a31', text: '#ece8fa', accent: '#9a7cf5' },
  { id: 'nord', name: 'Nord', dark: true, bg: '#2e3440', surface: '#3b4252', text: '#eceff4', accent: '#5e9fb3' },
  { id: 'dracula', name: 'Dracula', dark: true, bg: '#282a36', surface: '#343746', text: '#f8f8f2', accent: '#a37cf0' },
  { id: 'solarized-dark', name: 'Solarized dark', dark: true, bg: '#002b36', surface: '#073642', text: '#eee8d5', accent: '#2f95c9' },
  { id: 'paper', name: 'Paper', dark: false, bg: '#f6f1e7', surface: '#fffdf8', text: '#2b2620', accent: '#b45f06' },
  { id: 'sky', name: 'Sky', dark: false, bg: '#eaf3fb', surface: '#ffffff', text: '#10222e', accent: '#1478c8' },
  { id: 'mint', name: 'Mint', dark: false, bg: '#e9f6f0', surface: '#ffffff', text: '#10261c', accent: '#14805a' },
  { id: 'solarized-light', name: 'Solarized light', dark: false, bg: '#fdf6e3', surface: '#eee8d5', text: '#073642', accent: '#1f78b4' },
];

export const DEFAULT_PALETTE = 'classic';

export function themeById(id: string): ThemeDef | undefined {
  return THEMES.find((t) => t.id === id);
}

/* ---------------- colour maths ---------------- */

type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb {
  const v = hex.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(v.slice(i, i + 2), 16)) as Rgb;
}

const toHex = (c: Rgb): string => `#${c.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;

/** `t` of the way from a to b. */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * t) as Rgb);
}

const lum = (hex: string): number => {
  const [r, g, b] = parseHex(hex).map((n) => {
    const s = n / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const rgba = (hex: string, alpha: number): string => {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** Darken the accent until white text on it reaches 4.5:1, so filled buttons and own message bubbles stay readable. */
export function accentFill(accent: string): string {
  let fill = accent;
  for (let i = 0; i < 20 && contrast('#ffffff', fill) < 4.5; i += 1) fill = mix(fill, '#000000', 0.08);
  return fill;
}

/** Every CSS variable a theme sets. Removing these puts the classic look back. */
export function themeVars(t: ThemeDef): Record<string, string> {
  const fill = accentFill(t.accent);
  const elevated = mix(t.bg, t.surface, 0.5);
  return {
    '--bg': t.bg,
    '--bg-elevated': elevated,
    '--sidebar': mix(t.bg, t.surface, 0.3),
    '--surface': t.surface,
    '--surface-hover': mix(t.surface, t.text, 0.06),
    '--surface-strong': mix(t.surface, t.text, 0.12),
    '--text': t.text,
    '--text-soft': mix(t.text, t.bg, 0.2),
    '--muted': mix(t.text, t.bg, 0.42),
    '--border': rgba(t.text, 0.1),
    '--border-strong': rgba(t.text, 0.2),
    '--accent': t.accent,
    '--accent-soft': rgba(t.accent, 0.18),
    '--accent-strong': mix(t.accent, '#000000', 0.14),
    '--accent-fill': fill,
    '--accent-fill-strong': mix(fill, '#000000', 0.2),
    '--bubble-own': `linear-gradient(150deg, ${fill}, ${mix(fill, '#000000', 0.2)})`,
    '--bubble-theirs': t.dark ? mix(t.surface, t.text, 0.04) : t.surface,
    '--danger': t.dark ? '#f87171' : '#dc2626',
    '--danger-soft': t.dark ? 'rgba(248, 113, 113, 0.14)' : 'rgba(220, 38, 38, 0.09)',
    '--warning': t.dark ? '#fbbf24' : '#b45309',
    '--success': t.dark ? '#34d399' : '#059669',
    '--shadow': t.dark ? '0 20px 60px rgba(0, 0, 0, 0.45)' : '0 24px 70px rgba(15, 23, 42, 0.16)',
  };
}
