import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../config';

const devPrefix = 'duochat.dev-secret.';

export const usingOsSecureStorage = isTauri();

export async function secretGet(key: string): Promise<string | null> {
  if (isTauri()) {
    try {
      const value = await invoke<string | null>('secret_get', { key });
      return value ?? null;
    } catch (error) {
      throw new Error(`Secure storage read failed: ${String(error)}`);
    }
  }
  return localStorage.getItem(devPrefix + key);
}

export async function secretSet(key: string, value: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke('secret_set', { key, value });
      return;
    } catch (error) {
      throw new Error(`Secure storage write failed: ${String(error)}`);
    }
  }
  localStorage.setItem(devPrefix + key, value);
}

export async function secretDelete(key: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke('secret_delete', { key });
      return;
    } catch {
      // Deleting a missing key is not an error for callers.
    }
  }
  localStorage.removeItem(devPrefix + key);
}
