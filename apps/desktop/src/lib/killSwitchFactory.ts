/**
 * Real dependency wiring for the desktop kill switch executors. Thin bridge
 * between the app and lib/killSwitch.ts so the executor logic itself stays
 * platform-agnostic and unit-testable.
 */

import type { ChatEngine } from './engine';
import { purgePeerKeyCaches } from './identity';
import {
  KILL_SWITCH_REPORT_KEY,
  type DesktopKillSwitchDeps,
} from './killSwitch';
import { secretDelete } from './secureStore';
import type { KillSwitchReport } from '@duochat/protocol';

function parsePersistedReport(raw: string): KillSwitchReport | null {
  try {
    const parsed = JSON.parse(raw) as Partial<KillSwitchReport>;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.steps)) {
      return parsed as KillSwitchReport;
    }
  } catch {
    // Corrupt report: start fresh.
  }
  return null;
}

export function buildKillSwitchDeps(
  engine: ChatEngine | null,
  uid: string,
  peerUid: string,
): DesktopKillSwitchDeps | null {
  if (!engine) return null;
  const store = engine.localStore;
  if (!store) return null;
  return {
    uid,
    peerUid,
    store,
    deleteSecret: secretDelete,
    webStorage: window.localStorage,
    stopNetworking: () => engine.stop(),
    clearChatContent: () => engine.clearLocalChat(),
    eraseChatSessionState: () => {
      purgePeerKeyCaches(peerUid);
      engine.eraseLocalChatSession();
    },
    persistReport: (report) => {
      window.localStorage.setItem(KILL_SWITCH_REPORT_KEY, JSON.stringify(report));
    },
    loadReport: () => {
      const raw = window.localStorage.getItem(KILL_SWITCH_REPORT_KEY);
      return raw ? parsePersistedReport(raw) : null;
    },
  };
}

export function clearPersistedKillSwitchReport(): void {
  window.localStorage.removeItem(KILL_SWITCH_REPORT_KEY);
}
