/**
 * Desktop kill switch executor.
 *
 * Implements the shared protocol kill-switch contract for the Tauri desktop
 * app: ordered step execution with a truthful report. Every platform step is
 * answered; components this platform does not have (Bluetooth, file
 * transfers, background services) are reported 'skipped' with a reason
 * instead of being silently dropped.
 *
 * Honesty rules:
 *  - a failed step keeps the report partial; the UI shows what remains,
 *  - no forensic erasure is claimed (see docs/EMERGENCY_DELETION.md),
 *  - report persistence between steps makes interruptions resumable; the
 *    completed report is removed by the UI after acknowledgement.
 */

import {
  APP_KILL_SWITCH_STEPS,
  CONVERSATION_KILL_SWITCH_STEPS,
  runKillSwitch,
  type KillSwitchExecutor,
  type KillSwitchMode,
  type KillSwitchPlanStep,
  type KillSwitchReport,
} from '@duochat/protocol';

export interface KillSwitchTargets {
  uid: string;
  peerUid: string;
}

/**
 * Key/value storage surface satisfied by the webview's localStorage and by
 * test fakes alike.
 */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/**
 * Narrow platform surface needed by the executors. Real wiring comes from
 * engine.ts / localDb.ts / identity.ts / secureStore.ts; tests can supply
 * fakes without a DOM or Tauri runtime.
 */
export interface DesktopKillSwitchDeps extends KillSwitchTargets {
  /** LocalStore subset (null when the store is already gone). */
  store: {
    clearAll(): Promise<void>;
    clearMessages(): Promise<void>;
    destroySchema(): Promise<void>;
  } | null;
  /** OS secure storage deletion (Tauri keyring or dev localStorage). */
  deleteSecret(key: string): Promise<void>;
  /** webview key/value storage, localStorage in this app. */
  webStorage: WebStorageLike;
  /** Close direct channels and timers. */
  stopNetworking(): void;
  /** Option A content erase for the conversation (engine + store). */
  clearChatContent(): Promise<void>;
  /** Option B session-state erase (engine teardown + trust cache purge). */
  eraseChatSessionState(): void;
  /** Live report persistence for crash-resumable execution. */
  persistReport(report: KillSwitchReport): void;
  loadReport(): KillSwitchReport | null;
}

export const KILL_SWITCH_REPORT_KEY = 'duochat.killswitch.report.v1';

/* ------------------------------------------------------------------ */
/* App-wide ("NUKE DUOCHAT") executor                                  */
/* ------------------------------------------------------------------ */

const SECRET_KEYS = (uid: string) => [
  `ec-private-${uid}`,
  `ec-dh-private-${uid}`,
  `ec-proof-${uid}`,
  `aes-key-${uid}`,
];

function purgeWebStorage(storage: WebStorageLike): number {
  return removeStorageKeys(storage, (key) => key.startsWith('duochat.'));
}

function removeStorageKeys(
  storage: WebStorageLike,
  predicate: (key: string) => boolean,
): number {
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && predicate(key)) doomed.push(key);
  }
  for (const key of doomed) storage.removeItem(key);
  return doomed.length;
}

export function createAppKillSwitchExecutor(
  deps: DesktopKillSwitchDeps,
): KillSwitchExecutor<DesktopKillSwitchDeps> {
  return {
    planSteps: () => APP_KILL_SWITCH_STEPS,
    persistReport: (report) => deps.persistReport(report),
    async performStep(stepId, ctx) {
      switch (stepId) {
        case 'network.shutdown': {
          ctx.stopNetworking();
          return {
            status: 'erased',
            details: 'Direct channels closed and timers cancelled. (No Bluetooth transport exists on the desktop app.)',
          };
        }
        case 'services.stop': {
          return {
            status: 'skipped',
            details: 'No separate background services run on the desktop app; all networking stopped with the app instance.',
          };
        }
        case 'transfers.cancel': {
          return {
            status: 'skipped',
            details: 'No file transfer feature exists in this version.',
          };
        }
        case 'messages.erase': {
          if (!ctx.store) throw new Error('Local store unavailable.');
          await ctx.store.clearAll();
          return { status: 'erased' };
        }
        case 'contacts.erase': {
          removeStorageKeys(ctx.webStorage, (key) =>
            key.startsWith('duochat.peer-key.'),
          );
          return {
            status: 'erased',
            details: 'Local trust records (the pinned peer key) deleted.',
          };
        }
        case 'attachments.erase': {
          return {
            status: 'skipped',
            details: 'No attachments, media, or thumbnails are stored by this version.',
          };
        }
        case 'queues.erase': {
          return {
            status: 'erased',
            details: 'Outgoing and incoming queues were part of the local database erase.',
          };
        }
        case 'keys.erase': {
          const failedKeys: string[] = [];
          for (const secretKey of SECRET_KEYS(ctx.uid)) {
            try {
              await ctx.deleteSecret(secretKey);
            } catch {
              failedKeys.push(secretKey);
            }
          }
          const purged = removeStorageKeys(ctx.webStorage, (key) =>
            key.startsWith('duochat.peer-key.'),
          );
          if (failedKeys.length > 0) {
            return {
              status: 'failed',
              details: `Could not delete ${failedKeys.length} secret(s) from the OS credential store.`,
            };
          }
          return {
            status: 'erased',
            details: `Identity and local encryption keys removed (${purged} cached peer keys purged).`,
          };
        }
        case 'database.erase': {
          if (!ctx.store) throw new Error('Local store unavailable.');
          await ctx.store.destroySchema();
          return {
            status: 'erased',
            details: 'All rows and the schema deleted. The empty file remnant is handled by the OS until app close (documented limitation).',
          };
        }
        case 'settings.erase': {
          purgeWebStorage(ctx.webStorage);
          return { status: 'erased' };
        }
        default:
          throw new Error(`Unknown step ${stepId}.`);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Per-conversation executor                                           */
/* ------------------------------------------------------------------ */

export function createConversationKillSwitchExecutor(
  deps: DesktopKillSwitchDeps,
): KillSwitchExecutor<DesktopKillSwitchDeps> {
  return {
    planSteps: (mode: KillSwitchMode) =>
      CONVERSATION_KILL_SWITCH_STEPS.filter(
        (step) => !(step.id === 'conv.session.erase' && mode === 'local-only'),
      ),
    async performStep(stepId, ctx) {
      switch (stepId) {
        case 'conv.transfers.cancel': {
          return {
            status: 'skipped',
            details: 'No file transfer feature exists in this version.',
          };
        }
        case 'conv.messages.erase': {
          await ctx.clearChatContent();
          return { status: 'erased' };
        }
        case 'conv.session.erase': {
          ctx.eraseChatSessionState();
          return {
            status: 'erased',
            details: 'Direct-channel trust state erased. A new identity handshake is required before sending again. The contact stays paired at the account level.',
          };
        }
        default:
          throw new Error(`Unknown step ${stepId}.`);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Runners                                                             */
/* ------------------------------------------------------------------ */

export async function runAppKillSwitch(
  deps: DesktopKillSwitchDeps,
  onProgress?: (report: KillSwitchReport) => void,
): Promise<KillSwitchReport> {
  return runKillSwitch(createAppKillSwitchExecutor(deps), deps, {
    scope: 'application',
    mode: 'local-only',
    onProgress,
    existingReport: deps.loadReport() ?? undefined,
  });
}

export async function runConversationKillSwitch(
  deps: DesktopKillSwitchDeps,
  mode: KillSwitchMode,
  onProgress?: (report: KillSwitchReport) => void,
): Promise<KillSwitchReport> {
  return runKillSwitch(createConversationKillSwitchExecutor(deps), deps, {
    scope: 'conversation',
    mode,
    onProgress,
  });
}

export function stepsForPlan(
  scope: 'application' | 'conversation',
  mode: KillSwitchMode = 'local-only',
): KillSwitchPlanStep[] {
  if (scope === 'application') return APP_KILL_SWITCH_STEPS;
  return CONVERSATION_KILL_SWITCH_STEPS.filter(
    (step) => !(step.id === 'conv.session.erase' && mode === 'local-only'),
  );
}
