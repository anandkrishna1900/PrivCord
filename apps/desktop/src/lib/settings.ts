import { DEFAULT_PALETTE, THEMES, themeById, themeVars } from './themes';

export type ThemeMode = 'system' | 'dark' | 'light';

export interface AppSettings {
  theme: ThemeMode;
  accent: string;
  notificationsEnabled: boolean;
  notificationPreviews: boolean;
  /** A built-in colour theme (see themes.ts), or 'classic' for the system light/dark look with the accent picker. */
  palette: string;
  /** The name friends see on your invite. */
  displayName: string;
  /**
   * Privacy: stay group-only with people you only meet through a group. You still get their group messages
   * and they get yours, but neither of you can start a direct chat unless you swap invites yourselves.
   */
  groupOnly: boolean;
  /** Panic wipe: pressing Ctrl+Shift+Backspace three times quickly erases everything on this device, with no questions. */
  panicWipe: boolean;
}

export const ACCENTS = [
  { name: 'Indigo', value: '#6366f1' },
  { name: 'Teal', value: '#0d9488' },
  { name: 'Rose', value: '#e11d48' },
  { name: 'Amber', value: '#d97706' },
  { name: 'Sky', value: '#0284c7' },
] as const;

const SETTINGS_KEY = 'duochat.settings.v1';

const DEFAULTS: AppSettings = {
  theme: 'system',
  accent: ACCENTS[0].value,
  notificationsEnabled: true,
  notificationPreviews: true,
  palette: DEFAULT_PALETTE,
  displayName: '',
  groupOnly: false,
  panicWipe: false,
};

export function parseSettings(raw: string | null): AppSettings {
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      theme:
        parsed.theme === 'dark' || parsed.theme === 'light' || parsed.theme === 'system'
          ? parsed.theme
          : DEFAULTS.theme,
      accent:
        typeof parsed.accent === 'string' && /^#[0-9a-f]{6}$/i.test(parsed.accent)
          ? parsed.accent
          : DEFAULTS.accent,
      notificationsEnabled:
        typeof parsed.notificationsEnabled === 'boolean'
          ? parsed.notificationsEnabled
          : DEFAULTS.notificationsEnabled,
      notificationPreviews:
        typeof parsed.notificationPreviews === 'boolean'
          ? parsed.notificationPreviews
          : DEFAULTS.notificationPreviews,
      palette: typeof parsed.palette === 'string' && (parsed.palette === DEFAULT_PALETTE || themeById(parsed.palette)) ? parsed.palette : DEFAULT_PALETTE,
      groupOnly: typeof parsed.groupOnly === 'boolean' ? parsed.groupOnly : DEFAULTS.groupOnly,
      panicWipe: typeof parsed.panicWipe === 'boolean' ? parsed.panicWipe : DEFAULTS.panicWipe,
      displayName:
        typeof parsed.displayName === 'string'
          ? parsed.displayName.trim().slice(0, 40)
          : DEFAULTS.displayName,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function loadSettings(): AppSettings {
  return parseSettings(localStorage.getItem(SETTINGS_KEY));
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function resolvedTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }
  return mode;
}

const THEME_VAR_NAMES = Object.keys(themeVars(THEMES[0]!));

export function applySettings(settings: AppSettings): void {
  const root = document.documentElement;
  for (const name of THEME_VAR_NAMES) root.style.removeProperty(name);
  const theme = themeById(settings.palette);
  if (theme) {
    root.dataset.theme = theme.dark ? 'dark' : 'light';
    for (const [name, value] of Object.entries(themeVars(theme))) root.style.setProperty(name, value);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.bg);
    return;
  }
  root.dataset.theme = resolvedTheme(settings.theme);
  root.style.setProperty('--accent', settings.accent);
  root.style.setProperty('--accent-soft', hexToRgba(settings.accent, 0.16));
  root.style.setProperty('--accent-strong', shade(settings.accent, -14));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', root.dataset.theme === 'light' ? '#f5f5f7' : '#0e1116');
  }
}

export function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function shade(hex: string, percent: number): string {
  const value = hex.replace('#', '');
  const amount = Math.round(2.55 * percent);
  const channels = [0, 2, 4].map((offset) => {
    const parsed = Number.parseInt(value.slice(offset, offset + 2), 16);
    return Math.max(0, Math.min(255, parsed + amount))
      .toString(16)
      .padStart(2, '0');
  });
  return `#${channels.join('')}`;
}
