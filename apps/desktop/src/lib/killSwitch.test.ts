import { describe, expect, it } from 'vitest';
import {
  createAppKillSwitchExecutor,
  createConversationKillSwitchExecutor,
  runAppKillSwitch,
  runConversationKillSwitch,
  stepsForPlan,
  WebStorageLike,
  type DesktopKillSwitchDeps,
} from './killSwitch';
import {
  emptyReport,
  summarizeReport,
  type KillSwitchReport,
} from '@duochat/protocol';

interface FakeWebStorageData {
  [key: string]: string;
}

class FakeWebStorage implements WebStorageLike {
  private data = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.data.set(k, v);
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  get length(): number {
    return this.data.size;
  }
}

interface FakeBackend {
  deps: DesktopKillSwitchDeps;
  secrets: Map<string, string>;
  clearedAll: boolean;
  clearedMessages: boolean;
  destroyedSchema: boolean;
  stopped: boolean;
  chatContentCleared: boolean;
  sessionErased: boolean;
  persistedReports: KillSwitchReport[];
}

function makeBackend(options?: {
  secrets?: Record<string, string>;
  secretDeleteFails?: boolean;
  web?: Record<string, string>;
}): FakeBackend {
  const secrets = new Map(Object.entries(options?.secrets ?? {}));
  const web = new FakeWebStorage(options?.web ?? {});
  const backend: FakeBackend = {
    secrets,
    clearedAll: false,
    clearedMessages: false,
    destroyedSchema: false,
    stopped: false,
    chatContentCleared: false,
    sessionErased: false,
    persistedReports: [],
    deps: {
      uid: 'uid-alice',
      peerUid: 'uid-bob',
      store: {
        clearAll: async () => {
          backend.clearedAll = true;
        },
        clearMessages: async () => {
          backend.clearedMessages = true;
        },
        destroySchema: async () => {
          backend.destroyedSchema = true;
        },
      },
      deleteSecret: async (key: string) => {
        if (options?.secretDeleteFails) throw new Error('keyring locked');
        secrets.delete(key);
      },
      webStorage: web,
      stopNetworking: () => {
        backend.stopped = true;
      },
      clearChatContent: async () => {
        backend.chatContentCleared = true;
        backend.clearedMessages = true;
      },
      eraseChatSessionState: () => {
        backend.sessionErased = true;
        backend.deps.webStorage.removeItem('duochat.peer-key.uid-bob.device-1');
      },
      persistReport: (report: KillSwitchReport) => {
        backend.persistedReports.push(JSON.parse(JSON.stringify(report)) as KillSwitchReport);
        backend.deps.webStorage.setItem('duochat.killswitch.report.v1', JSON.stringify(report));
      },
      loadReport: () => {
        const raw = backend.deps.webStorage.getItem('duochat.killswitch.report.v1');
        return raw ? (JSON.parse(raw) as KillSwitchReport) : null;
      },
    },
  };
  return backend;
}

const stepIds = (report: KillSwitchReport) => report.steps.map((s) => s.stepId);

/* ------------------------------ app-wide ------------------------------ */

describe('app-wide kill switch executor', () => {
  it('erases database rows, schema, secrets, and web storage in order', async () => {
    const backend = makeBackend({
      secrets: { 'ec-private-uid-alice': '{}', 'aes-key-uid-alice': 'raw' },
      web: {
        'duochat.settings.v1': '{}',
        'duochat.device-id': 'd-1',
        'duochat.peer-key.uid-bob.dev': '{}',
        'duochat.dev-store.v1': '{}',
      },
    });
    const report = await runAppKillSwitch(backend.deps);

    expect(stepIds(report)).toEqual(stepsForPlan('application').map((s) => s.id));
    expect(backend.stopped).toBe(true);
    expect(backend.clearedAll).toBe(true);
    expect(backend.destroyedSchema).toBe(true);
    expect(backend.secrets.size).toBe(0);
    expect(summarizeReport(report).complete).toBe(true);
    expect(summarizeReport(report).partial).toBe(false);

    const storage = backend.deps.webStorage;
    // Only the crash-resume record remains; it is not DuoChat user data and
    // the UI removes it when acknowledging the report.
    expect(storage.length).toBe(1);
    expect(storage.getItem('duochat.killswitch.report.v1')).not.toBeNull();
  });

  it('reports honestly when a key cannot be deleted', async () => {
    const backend = makeBackend({ secretDeleteFails: true });
    const report = await runAppKillSwitch(backend.deps);
    const summary = summarizeReport(report);
    expect(summary.complete).toBe(false);
    expect(summary.partial).toBe(true);
    expect(summary.failedStepIds).toEqual(['keys.erase']);
    const entry = report.steps.find((s) => s.stepId === 'keys.erase');
    expect(entry?.status).toBe('failed');
    expect(entry?.details).toContain('OS credential store');
  });

  it('runs all remaining steps even after one fails (best effort wipe)', async () => {
    const backend = makeBackend({ secretDeleteFails: true });
    const report = await runAppKillSwitch(backend.deps);
    expect(stepIds(report)).toEqual(stepsForPlan('application').map((s) => s.id));
    expect(backend.destroyedSchema).toBe(true);
  });

  it('skips steps this platform cannot perform and still counts them claimed', async () => {
    const backend = makeBackend();
    const report = await runAppKillSwitch(backend.deps);
    const summary = summarizeReport(report);
    expect(summary.complete).toBe(true);
    expect(summary.skippedStepIds).toEqual([
      'services.stop',
      'transfers.cancel',
      'attachments.erase',
    ]);
  });

  it('persists progress after every step so an interruption can resume', async () => {
    const backend = makeBackend();
    await runAppKillSwitch(backend.deps);
    // One persisted snapshot per executed step, plus the finished report.
    expect(backend.persistedReports.length).toBe(stepsForPlan('application').length + 1);
    const last = backend.persistedReports.at(-1)!;
    expect(last.finishedAt).not.toBeNull();
  });

  it('never claims a conversation content erase for the app-wide run', async () => {
    const backend = makeBackend();
    await runAppKillSwitch(backend.deps);
    expect(backend.chatContentCleared).toBe(false);
  });
});

/* --------------------------- per-conversation --------------------------- */

describe('conversation kill switch executor', () => {
  it('Option A erases chat content but never touches identity keys', async () => {
    const backend = makeBackend({
      secrets: { 'ec-private-uid-alice': 'PRIVATE' },
      web: { 'duochat.peer-key.uid-bob.device-1': '{}' },
    });
    const report = await runConversationKillSwitch(backend.deps, 'local-only');

    expect(stepIds(report)).toEqual(['conv.transfers.cancel', 'conv.messages.erase']);
    expect(backend.chatContentCleared).toBe(true);
    expect(backend.secrets.get('ec-private-uid-alice')).toBe('PRIVATE');
    expect(backend.deps.webStorage.getItem('duochat.peer-key.uid-bob.device-1')).toBe('{}');
    expect(summarizeReport(report).complete).toBe(true);
    expect(backend.sessionErased).toBe(false);
  });

  it('Option B additionally erases the conversation session trust state', async () => {
    const backend = makeBackend({
      secrets: { 'ec-private-uid-alice': 'PRIVATE' },
      web: { 'duochat.peer-key.uid-bob.device-1': '{}' },
    });
    const report = await runConversationKillSwitch(backend.deps, 'local-plus-session-state');

    expect(stepIds(report)).toEqual([
      'conv.transfers.cancel',
      'conv.messages.erase',
      'conv.session.erase',
    ]);
    expect(backend.sessionErased).toBe(true);
    expect(backend.deps.webStorage.getItem('duochat.peer-key.uid-bob.device-1')).toBeNull();
    // Global identity survives even Option B.
    expect(backend.secrets.get('ec-private-uid-alice')).toBe('PRIVATE');
    expect(summarizeReport(report).complete).toBe(true);
  });

  it('other conversations and the global settings survive a chat erase', async () => {
    const backend = makeBackend({
      web: {
        'duochat.settings.v1': '{"theme":"dark"}',
        'duochat.dev-store.v1': '{}',
        'duochat.peer-key.uid-bob.device-1': '{}',
      },
    });
    await runConversationKillSwitch(backend.deps, 'local-plus-session-state');
    expect(backend.deps.webStorage.getItem('duochat.settings.v1')).toBe('{"theme":"dark"}');
    expect(backend.deps.webStorage.getItem('duochat.dev-store.v1')).toBe('{}');
    expect(backend.clearedAll).toBe(false);
  });
});

/* ------------------------------- helpers ------------------------------- */

describe('report helper integration', () => {
  it('emptyReport plus executor produces a renderable, serializable report', async () => {
    const backend = makeBackend();
    const pristine = emptyReport('application', 'local-only');
    expect(JSON.parse(JSON.stringify(pristine)).steps).toEqual([]);
    const report = await runConversationKillSwitch(backend.deps, 'local-only');
    // Round-trip through JSON without losing status discrimination.
    const parsed = JSON.parse(JSON.stringify(report)) as KillSwitchReport;
    expect(summarizeReport(parsed).complete).toBe(true);
  });
});
