import { useCallback, useEffect, useState } from 'react';
import {
  applySettings,
  loadSettings,
  saveSettings,
  type AppSettings,
} from '../lib/settings';

export function useSettings(): {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
} {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (settings.theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applySettings(settings);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [settings]);

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  return { settings, update };
}
