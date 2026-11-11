/**
 * Whether the page runs on the Rust engine hosted in the Tauri shell (M7). It is OFF unless the person turns it on in
 * Settings > Connection > Advanced, and only exists in the packaged app (the browser build has no shell to host it).
 */
import { isTauri } from '../../config';

const KEY = 'privcord.engine';

export function hostedEngineAvailable(): boolean {
  return isTauri();
}

export function hostedEngineEnabled(): boolean {
  if (!hostedEngineAvailable()) return false;
  try {
    return localStorage.getItem(KEY) === 'rust';
  } catch {
    return false;
  }
}

export function setHostedEngineEnabled(on: boolean): void {
  if (on) localStorage.setItem(KEY, 'rust');
  else localStorage.removeItem(KEY);
}
