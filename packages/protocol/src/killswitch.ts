/**
 * Kill switch contracts shared by every DuoChat platform.
 *
 * A kill switch activation is an *ordered checklist execution*: each platform
 * provides step implementations (shutdown, database erase, key erase, cache
 * clear, ...), runs them through the same reporting machinery, and always
 * ends with a truthful report — partial failures are reported as partial, so
 * the UI never claims complete deletion when a step failed.
 *
 * The plan lists are canonical (single source of truth for UI copy order and
 * for tests); platform executors must claim every step they implement and
 * report 'skipped' (with details) for steps that do not exist on that platform
 * — e.g. Bluetooth shutdown runs only where Bluetooth transports exist.
 */

export type KillSwitchScope = 'application' | 'conversation';
export type StepStatus = 'erased' | 'skipped' | 'failed';
export type KillSwitchMode = 'local-only' | 'local-plus-session-state';

export interface KillSwitchPlanStep {
  index: number;
  id: string;
  label: string;
  /** Short explanation shown in the emergency UI. */
  detail: string;
}

export interface KillSwitchStepResult {
  stepId: string;
  status: StepStatus;
  /** Human-readable completion or failure reason; no message content ever. */
  details?: string;
}

export interface KillSwitchReport {
  version: 1;
  scope: KillSwitchScope;
  /** For conversation scope. Public routing id only. */
  target?: string;
  mode: KillSwitchMode;
  startedAt: number;
  finishedAt: number | null;
  steps: KillSwitchStepResult[];
}

/* ------------------------------------------------------------------ */
/* Canonical step lists                                                */
/* ------------------------------------------------------------------ */

export const APP_KILL_SWITCH_STEPS: KillSwitchPlanStep[] = [
  { index: 0, id: 'network.shutdown', label: 'Disconnect networking', detail: 'Bluetooth, WebRTC peers, signaling and relays are disconnected and all active transfers cancelled.' },
  { index: 1, id: 'services.stop', label: 'Stop background services', detail: 'Background reception and relay participation stop and cannot deliver anything anymore.' },
  { index: 2, id: 'transfers.cancel', label: 'Cancel transfers', detail: 'Active and queued file transfers are cancelled and their partial chunks deleted.' },
  { index: 3, id: 'messages.erase', label: 'Erase conversations and messages', detail: 'Every conversation, message, draft, search index, and delivery record is deleted.' },
  { index: 4, id: 'contacts.erase', label: 'Erase contacts and groups', detail: 'Contacts, trust records, and local group membership and group keys are deleted.' },
  { index: 5, id: 'attachments.erase', label: 'Erase files and media', detail: 'Downloaded attachments, previews, thumbnails and temporary transfer files are deleted.' },
  { index: 6, id: 'queues.erase', label: 'Erase queues and caches', detail: 'Outgoing, incoming and relay store-and-forward queues plus app-managed caches are deleted.' },
  { index: 7, id: 'keys.erase', label: 'Erase cryptographic state', detail: 'Identity keys, session keys and all other locally stored secrets are deleted.' },
  { index: 8, id: 'database.erase', label: 'Erase local database', detail: 'The local encrypted database and app-managed temporary files are deleted.' },
  { index: 9, id: 'settings.erase', label: 'Erase settings and reset app', detail: 'Application settings are cleared and the app returns to first-run onboarding.' },
];

export const CONVERSATION_KILL_SWITCH_STEPS: KillSwitchPlanStep[] = [
  { index: 0, id: 'conv.transfers.cancel', label: 'Cancel transfers in this chat', detail: 'Active and queued file transfers for this conversation are cancelled.' },
  { index: 1, id: 'conv.messages.erase', label: 'Erase this chat locally', detail: 'Messages, attachments, previews, drafts, queues and delivery records for this conversation are deleted.' },
  { index: 2, id: 'conv.session.erase', label: 'Erase chat encryption session', detail: 'Only with “Delete chat and local session state”: future messages will require a new secure session handshake.' },
];

/* ------------------------------------------------------------------ */
/* Report helpers                                                      */
/* ------------------------------------------------------------------ */

export function emptyReport(
  scope: KillSwitchScope,
  mode: KillSwitchMode,
  target?: string,
  now = Date.now(),
): KillSwitchReport {
  return {
    version: 1,
    scope,
    mode,
    ...(target !== undefined ? { target } : {}),
    startedAt: now,
    finishedAt: null,
    steps: [],
  };
}

export function recordStep(
  report: KillSwitchReport,
  stepId: string,
  status: StepStatus,
  details?: string,
): KillSwitchReport {
  report.steps.push({ stepId, status, ...(details !== undefined ? { details } : {}) });
  return report;
}

export function finishReport(report: KillSwitchReport, now = Date.now()): KillSwitchReport {
  report.finishedAt = now;
  return report;
}

export interface KillSwitchSummary {
  complete: boolean;
  partial: boolean;
  failedStepIds: string[];
  skippedStepIds: string[];
}

/** The UI must render exactly this truth — never a false "complete". */
export function summarizeReport(report: KillSwitchReport): KillSwitchSummary {
  const failedStepIds = report.steps.filter((s) => s.status === 'failed').map((s) => s.stepId);
  const skippedStepIds = report.steps.filter((s) => s.status === 'skipped').map((s) => s.stepId);
  // Mode-aware claim coverage: Option A ("CLEAR LOCAL CHAT") deliberately
  // omits the session-erase step, so its absence must not count as unclaimed.
  const claimed =
    report.scope === 'application'
      ? APP_KILL_SWITCH_STEPS
      : CONVERSATION_KILL_SWITCH_STEPS.filter(
          (step) => !(step.id === 'conv.session.erase' && report.mode === 'local-only'),
        );
  const claimedIds = new Set(claimed.map((s) => s.id));
  const unclaimed = Array.from(claimedIds).filter(
    (id) => !report.steps.some((s) => s.stepId === id),
  );
  return {
    complete: failedStepIds.length === 0 && unclaimed.length === 0,
    partial: failedStepIds.length > 0 || unclaimed.length > 0,
    failedStepIds,
    skippedStepIds,
  };
}

/**
 * Executor contract for platforms. Every step id from the canonical list must
 * be answered exactly once ('failed' steps included), so the report stays
 * truthful even when the executor is interrupted by app death — on restart,
 * callers compare the stored report to the canonical list.
 */
export interface KillSwitchExecutor<Context> {
  planSteps(mode: KillSwitchMode): KillSwitchPlanStep[];
  performStep(stepId: string, context: Context): Promise<{ status: StepStatus; details?: string }>;
  /** Persist the in-progress report between steps (crash resilience). */
  persistReport?(report: KillSwitchReport): Promise<void> | void;
}

export async function runKillSwitch<Context>(
  executor: KillSwitchExecutor<Context>,
  context: Context,
  options: {
    scope: KillSwitchScope;
    mode: KillSwitchMode;
    target?: string;
    /** Called after each step for progress UI. */
    onProgress?: (report: KillSwitchReport) => void;
    /** When provided and the executor supports persistence, resume skips steps already erased. */
    existingReport?: KillSwitchReport;
  },
): Promise<KillSwitchReport> {
  const report = options.existingReport
    ? { ...options.existingReport, finishedAt: null, steps: [...options.existingReport.steps] }
    : emptyReport(options.scope, options.mode, options.target);
  const steps = executor.planSteps(report.mode);
  for (const step of steps) {
    const previous = report.steps.find((s) => s.stepId === step.id);
    if (previous && previous.status === 'erased') {
      continue; // already done in an earlier attempt
    }
    if (previous) {
      report.steps = report.steps.filter((s) => s.stepId !== step.id);
    }
    try {
      const outcome = await executor.performStep(step.id, context);
      recordStep(report, step.id, outcome.status, outcome.details);
    } catch (error) {
      // Error strings must never contain message content; steps stringify
      // bounded platform errors only.
      recordStep(report, step.id, 'failed', truncate(String(error)));
    }
    if (executor.persistReport) {
      await executor.persistReport(report);
    }
    options.onProgress?.(report);
  }
  const finished = finishReport(report);
  // Persist the completed report so a restart can see the wipe finished even
  // if the app crashed between the last step and the final toast.
  if (executor.persistReport) {
    await executor.persistReport(finished);
  }
  return finished;
}

/** Keep failure details short and non-content-bearing. */
export function truncate(text: string, max = 160): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
