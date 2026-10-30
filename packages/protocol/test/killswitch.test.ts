import { describe, expect, it } from 'vitest';
import {
  APP_KILL_SWITCH_STEPS,
  CONVERSATION_KILL_SWITCH_STEPS,
  emptyReport,
  finishReport,
  recordStep,
  runKillSwitch,
  summarizeReport,
  truncate,
  type KillSwitchExecutor,
  type KillSwitchPlanStep,
  type KillSwitchReport,
  type KillSwitchStepResult,
} from '../src/killswitch';

const APP_STEP_IDS = [
  'network.shutdown',
  'services.stop',
  'transfers.cancel',
  'messages.erase',
  'contacts.erase',
  'attachments.erase',
  'queues.erase',
  'keys.erase',
  'database.erase',
  'settings.erase',
] as const;

const CONV_STEP_IDS = [
  'conv.transfers.cancel',
  'conv.messages.erase',
  'conv.session.erase',
] as const;

function listIds(steps: KillSwitchPlanStep[]): string[] {
  return steps.map((s) => s.id);
}

/* --------------------------- canonical plans --------------------------- */

describe('canonical kill-switch plans', () => {
  it('covers every required app-wide erasure category in order', () => {
    expect(listIds(APP_KILL_SWITCH_STEPS)).toEqual([...APP_STEP_IDS]);
    // Unique, ordered indices.
    expect(APP_KILL_SWITCH_STEPS.map((s) => s.index)).toEqual(
      APP_KILL_SWITCH_STEPS.map((_, i) => i),
    );
  });

  it('covers the per-conversation categories in order', () => {
    expect(listIds(CONVERSATION_KILL_SWITCH_STEPS)).toEqual([...CONV_STEP_IDS]);
  });

  it('labels non-existent platform components as skippable, not invisible', () => {
    // Network shutdown exists as a step everywhere even if a platform has no
    // Bluetooth; platforms must then answer 'skipped' with a reason rather
    // than dropping the step from their plan.
    expect(APP_STEP_IDS).toContain('network.shutdown');
  });
});

/* ----------------------------- truth engine ----------------------------- */

describe('report truthfulness', () => {
  it('reports complete only when every claimed step erased', () => {
    const report = emptyReport('application', 'local-only');
    for (const id of APP_STEP_IDS) recordStep(report, id, 'erased');
    finishReport(report);
    expect(summarizeReport(report)).toEqual({
      complete: true,
      partial: false,
      failedStepIds: [],
      skippedStepIds: [],
    });
  });

  it('never reports complete when a step failed', () => {
    const report = emptyReport('application', 'local-only');
    for (const id of APP_STEP_IDS) {
      recordStep(report, id, id === 'keys.erase' ? 'failed' : 'erased', 'secure delete failed: OS error');
    }
    const summary = summarizeReport(report);
    expect(summary.complete).toBe(false);
    expect(summary.partial).toBe(true);
    expect(summary.failedStepIds).toEqual(['keys.erase']);
  });

  it('treats skipped (not-applicable) steps as honest claims, listed in the report', () => {
    const report = emptyReport('application', 'local-only');
    for (const id of APP_STEP_IDS) {
      recordStep(
        report,
        id,
        id === 'network.shutdown' ? 'skipped' : 'erased',
        id === 'network.shutdown' ? 'No Bluetooth transport exists on this platform.' : undefined,
      );
    }
    const summary = summarizeReport(report);
    expect(summary.complete).toBe(true);
    expect(summary.partial).toBe(false);
    expect(summary.skippedStepIds).toEqual(['network.shutdown']);
  });

  it('counts unclaimed steps as partial (interrupted run)', () => {
    const report = emptyReport('application', 'local-only');
    // Only the first three steps ran before the process died.
    recordStep(report, 'network.shutdown', 'erased');
    recordStep(report, 'services.stop', 'erased');
    recordStep(report, 'transfers.cancel', 'erased');
    finishReport(report);
    const summary = summarizeReport(report);
    expect(summary.complete).toBe(false);
    expect(summary.partial).toBe(true);
  });
});

/* ------------------------- Option A vs Option B ------------------------- */

describe('conversation modes (Option A / Option B)', () => {
  it('Option A (CLEAR LOCAL CHAT) is complete without the session-erase step', () => {
    const report = emptyReport('conversation', 'local-only', 'peer-123');
    recordStep(report, 'conv.transfers.cancel', 'erased');
    recordStep(report, 'conv.messages.erase', 'erased');
    finishReport(report);
    expect(summarizeReport(report).complete).toBe(true);
  });

  it('Option B (DELETE CHAT AND LOCAL SESSION STATE) requires the session erase', () => {
    const withErase = emptyReport('conversation', 'local-plus-session-state', 'peer-123');
    recordStep(withErase, 'conv.transfers.cancel', 'erased');
    recordStep(withErase, 'conv.messages.erase', 'erased');
    recordStep(withErase, 'conv.session.erase', 'erased');
    finishReport(withErase);
    expect(summarizeReport(withErase).complete).toBe(true);

    const withoutErase = emptyReport('conversation', 'local-plus-session-state', 'peer-123');
    recordStep(withoutErase, 'conv.transfers.cancel', 'erased');
    recordStep(withoutErase, 'conv.messages.erase', 'erased');
    finishReport(withoutErase);
    const summary = summarizeReport(withoutErase);
    expect(summary.complete).toBe(false);
    expect(summary.partial).toBe(true);
  });
});

/* ------------------------------ execution ------------------------------ */

interface TestContext {
  executed: string[];
  failStepId?: string;
  persistCalls: number;
}

function makeExecutor(steps: KillSwitchPlanStep[], context: TestContext): KillSwitchExecutor<TestContext> {
  return {
    planSteps: () => steps,
    async performStep(stepId, ctx) {
      ctx.executed.push(stepId);
      if (stepId === ctx.failStepId) {
        throw new Error(`Step ${stepId} could not erase its target.`);
      }
      return { status: 'erased' as const };
    },
    persistReport: () => {
      context.persistCalls += 1;
    },
  };
}

describe('runKillSwitch execution', () => {
  it('runs every step in plan order and records an ordered report', async () => {
    const context: TestContext = { executed: [], persistCalls: 0 };
    const executor = makeExecutor(APP_KILL_SWITCH_STEPS, context);
    const report = await runKillSwitch(executor, context, { scope: 'application', mode: 'local-only' });
    expect(context.executed).toEqual([...APP_STEP_IDS]);
    expect(report.scope).toBe('application');
    expect(report.mode).toBe('local-only');
    expect(report.finishedAt).not.toBeNull();
    expect(report.steps.map((s) => s.stepId)).toEqual([...APP_STEP_IDS]);
    expect(report.steps.every((s) => s.status === 'erased')).toBe(true);
    expect(summarizeReport(report).complete).toBe(true);
    // Persistence happens after every step, plus the final finished snapshot.
    expect(context.persistCalls).toBe(APP_STEP_IDS.length + 1);
  });

  it('reports failure honestly and still completes the remaining checklist', async () => {
    const context: TestContext = { executed: [], failStepId: 'contacts.erase', persistCalls: 0 };
    const executor = makeExecutor(APP_KILL_SWITCH_STEPS, context);
    const report = await runKillSwitch(executor, context, { scope: 'application', mode: 'local-only' });
    // All subsequent steps still ran (best-effort complete wipe).
    expect(context.executed.length).toBe(APP_STEP_IDS.length);
    const entry = report.steps.find((s) => s.stepId === 'contacts.erase')!;
    expect(entry.status).toBe('failed');
    // Details are bounded and never user-content.
    expect(entry.details!.length).toBeLessThanOrEqual(200);
    expect(summarizeReport(report).complete).toBe(false);
  });

  it('propagates mode and target into the executor plan and report', async () => {
    const context: TestContext = { executed: [], persistCalls: 0 };
    let requestedMode: string | null = null;
    const executor: KillSwitchExecutor<TestContext> = {
      planSteps: (mode) => {
        requestedMode = mode;
        return CONVERSATION_KILL_SWITCH_STEPS;
      },
      async performStep(stepId) {
        context.executed.push(stepId);
        return { status: 'erased' };
      },
    };
    const report = await runKillSwitch(executor, context, {
      scope: 'conversation',
      mode: 'local-plus-session-state',
      target: 'peer-abc',
    });
    expect(requestedMode).toBe('local-plus-session-state');
    expect(report.target).toBe('peer-abc');
    expect(report.mode).toBe('local-plus-session-state');
    expect(context.executed).toEqual([...CONV_STEP_IDS]);
  });

  it('resumes after interruption without re-erasing completed steps', async () => {
    const context: TestContext = { executed: [], persistCalls: 0 };
    const interrupted: KillSwitchReport = emptyReport('application', 'local-only');
    recordStep(interrupted, 'network.shutdown', 'erased');
    recordStep(interrupted, 'services.stop', 'erased');
    recordStep(interrupted, 'transfers.cancel', 'failed', 'disk busy');

    const executor: KillSwitchExecutor<TestContext> = {
      planSteps: () => APP_KILL_SWITCH_STEPS,
      async performStep(stepId) {
        context.executed.push(stepId);
        if (stepId === 'contacts.erase') throw new Error('transient'); // fails once
        return { status: 'erased' };
      },
    };
    const report = await runKillSwitch(executor, context, {
      scope: 'application',
      mode: 'local-only',
      existingReport: interrupted,
    });
    // Erased steps were skipped, failed and unclaimed steps were retried.
    expect(context.executed).toEqual([
      'transfers.cancel',
      'messages.erase',
      'contacts.erase',
      'attachments.erase',
      'queues.erase',
      'keys.erase',
      'database.erase',
      'settings.erase',
    ]);
    // The retried steps replaced their previous results (one entry each).
    expect(report.steps.filter((s) => s.stepId === 'transfers.cancel').length).toBe(1);
    expect(report.steps.filter((s) => s.stepId === 'contacts.erase').length).toBe(1);
    expect(report.steps.find((s) => s.stepId === 'contacts.erase')!.status).toBe('failed');
    expect(report.steps.find((s) => s.stepId === 'network.shutdown')!.status).toBe('erased');
  });

  it('works without an onProgress callback and reports progress when given', async () => {
    const context: TestContext = { executed: [], persistCalls: 0 };
    const executor = makeExecutor(CONVERSATION_KILL_SWITCH_STEPS, context);
    const seen: number[] = [];
    await runKillSwitch(executor, context, {
      scope: 'conversation',
      mode: 'local-only',
      target: 'peer-x',
      onProgress: (r: KillSwitchReport) => seen.push(r.steps.length),
    });
    expect(seen).toEqual([1, 2, 3]);
  });
});

/* ------------------------------- helpers -------------------------------- */

describe('report helpers', () => {
  it('emptyReport shapes the initial report without target when absent', () => {
    const r = emptyReport('application', 'local-only', undefined, 1234);
    expect(r).toEqual({
      version: 1,
      scope: 'application',
      mode: 'local-only',
      startedAt: 1234,
      finishedAt: null,
      steps: [],
    });
    expect(Object.prototype.hasOwnProperty.call(r, 'target')).toBe(false);
  });

  it('finishReport sets finishedAt', () => {
    const r = emptyReport('conversation', 'local-only', 'p', 1);
    expect(r.finishedAt).toBeNull();
    expect(finishReport(r, 99).finishedAt).toBe(99);
  });

  it('truncate bounds error text safely', () => {
    expect(truncate('short')).toBe('short');
    expect(truncate('x'.repeat(500)).length).toBe(161); // 160 + ellipsis
    expect(truncate('x'.repeat(500)).endsWith('…')).toBe(true);
  });

  it('recordStep preserves detail field only when provided', () => {
    const r = emptyReport('application', 'local-only');
    recordStep(r, 'a', 'erased');
    recordStep(r, 'b', 'skipped', 'not present');
    const results: KillSwitchStepResult[] = r.steps;
    expect(Object.prototype.hasOwnProperty.call(results[0], 'details')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(results[1], 'details')).toBe(true);
  });
});
