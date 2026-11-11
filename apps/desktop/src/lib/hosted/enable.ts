/**
 * Whether the page runs on the Rust engine hosted in the Tauri shell (M7). It is the default in the packaged app; the person can
 * go back to the older TypeScript engine in Settings > Connection > Advanced. The browser build has no shell to host the engine,
 * so it always runs the TypeScript one.
 */
import { isTauri } from '../../config';

const KEY = 'privcord.engine';

export function hostedEngineAvailable(): boolean {
  return isTauri();
}

export function hostedEngineEnabled(): boolean {
  if (!hostedEngineAvailable()) return false;
  try {
    return localStorage.getItem(KEY) !== 'legacy';
  } catch {
    return false;
  }
}

export function setHostedEngineEnabled(on: boolean): void {
  if (on) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, 'legacy');
}
