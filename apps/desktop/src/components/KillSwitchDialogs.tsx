/**
 * Emergency deletion dialogs.
 *
 * Both flows execute the real, shared kill-switch checklist through the
 * platform executor and render the truthful report afterwards: completed
 * steps, skipped (not-applicable) steps, and failures — never a fake
 * "everything erased" when something failed.
 */

import { useMemo, useState } from 'react';
import {
  summarizeReport,
  type KillSwitchMode,
  type KillSwitchPlanStep,
  type KillSwitchReport,
  type StepStatus,
} from '@duochat/protocol';
import type { ChatEngine } from '../lib/engine';
import {
  runConversationKillSwitch,
  runAppKillSwitch,
  stepsForPlan,
} from '../lib/killSwitch';
import {
  buildKillSwitchDeps,
  clearPersistedKillSwitchReport,
} from '../lib/killSwitchFactory';
import { Modal } from './Modal';
import {
  AlertIcon,
  CheckIcon,
  InfoIcon,
  LoaderIcon,
  XIcon,
} from './Icons';

type Phase = 'setup' | 'arms' | 'running' | 'result';

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === 'erased') return <CheckIcon size={15} />;
  if (status === 'failed') return <XIcon size={15} />;
  return <InfoIcon size={15} />;
}

function StepStatusEntry({
  step,
  status,
  details,
}: {
  step: KillSwitchPlanStep;
  status: StepStatus | null;
  details?: string;
}) {
  const cls = status ?? 'pending';
  return (
    <li className={`erase-step ${cls}`} key={step.id}>
      <span className="erase-step-icon">
        {status === null ? (
          <LoaderIcon size={15} className="spin" />
        ) : (
          <StatusIcon status={status} />
        )}
      </span>
      <div>
        <strong>{step.label}</strong>
        {details ? <p className="muted small">{details}</p> : <p className="muted small">{step.detail}</p>}
      </div>
    </li>
  );
}

function ReportView({
  planSteps,
  report,
  running,
}: {
  planSteps: KillSwitchPlanStep[];
  report: KillSwitchReport;
  running: boolean;
}) {
  const summary = useMemo(
    () => summarizeReport(report),
    [report],
  );
  return (
    <div>
      {running ? (
        <div className="callout warning" role="status">
          <LoaderIcon size={17} className="spin" />
          <p>Erasing. Keep this window open until the report below is finished.</p>
        </div>
      ) : summary.complete ? (
        <div className="callout subtle" role="status">
          <CheckIcon size={17} />
          <p>
            <strong>Erase finished.</strong> Everything DuoChat could remove on
            this device was removed.
          </p>
        </div>
      ) : (
        <div className="callout warning" role="alert">
          <AlertIcon size={17} />
          <p>
            <strong>Partial erase.</strong> Some items could not be deleted
            (marked red below). Data marked green is erased; the erase can be
            retried.
          </p>
        </div>
      )}
      {!running && !summary.complete ? (
        <p className="muted small">
          {summary.failedStepIds.length} step(s) reported failures
          {summary.skippedStepIds.length > 0
            ? `; ${summary.skippedStepIds.length} do(es) not apply on this platform.`
            : '.'}
        </p>
      ) : null}
      <ul className="erase-steps">
        {planSteps.map((step) => {
          const result = report.steps.find((s) => s.stepId === step.id);
          return (
            <StepStatusEntry
              key={step.id}
              step={step}
              status={result?.status ?? null}
              details={result?.details}
            />
          );
        })}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* NUKE DUOCHAT (app-wide)                                             */
/* ------------------------------------------------------------------ */

export function NukeDialog({
  open,
  onClose,
  engine,
  uid,
  peerUid,
  onFinished,
}: {
  open: boolean;
  onClose: () => void;
  engine: ChatEngine | null;
  uid: string;
  peerUid: string;
  onFinished: () => void | Promise<void>;
}) {
  const [phase, setPhase] = useState<Phase>('setup');
  const [understood, setUnderstood] = useState(false);
  const [armed, setArmed] = useState('');
  const [report, setReport] = useState<KillSwitchReport | null>(null);
  const planSteps = useMemo(() => stepsForPlan('application'), []);

  function reset() {
    setPhase('setup');
    setUnderstood(false);
    setArmed('');
    setReport(null);
  }

  function close() {
    // Not closable while a wipe runs — the erase continues regardless, but the
    // user should watch the report.
    if (phase === 'running') return;
    reset();
    onClose();
  }

  async function execute() {
    const deps = buildKillSwitchDeps(engine, uid, peerUid);
    if (!deps) return;
    setPhase('running');
    const finished = await runAppKillSwitch(deps, (progress) => {
      setReport({ ...progress, steps: [...progress.steps] });
    }).catch((error) => {
      // Reaching here means runKillSwitch itself failed (never a step).
      const failed = {
        version: 1 as const,
        scope: 'application' as const,
        mode: 'local-only' as const,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        steps: [
          {
            stepId: 'run.abort',
            status: 'failed' as const,
            details: `Erase aborted before completion: ${String(error).slice(0, 120)}`,
          },
        ],
      };
      setReport(failed);
      return failed as KillSwitchReport;
    });
    setReport(finished);
    setPhase('result');
  }

  const canFinish =
    report !== null &&
    phase === 'result' &&
    summarizeReport(report).complete;

  return (
    <Modal
      open={open}
      onClose={close}
      eyebrow="Settings · Security · Emergency Actions"
      title="NUKE DUOCHAT"
    >
      {phase === 'setup' ? (
        <div>
          <div className="callout warning" role="alert">
            <AlertIcon size={17} />
            <p>
              <strong>This action permanently deletes the local DuoChat
              identity, conversations, contacts, files, cryptographic state,
              and application data. You will need your separately backed-up
              12-word recovery phrase to restore your identity.</strong>
            </p>
          </div>
          <p className="muted small">
            What gets erased on this device:
          </p>
          <ul className="erase-steps preview">
            {planSteps.map((step) => (
              <StepStatusEntry key={step.id} step={step} status={null} details={undefined} />
            ))}
          </ul>
          <label className="check-row">
            <input
              type="checkbox"
              checked={understood}
              onChange={(event) => setUnderstood(event.target.checked)}
            />
            <span>
              I understand that this is irreversible on this device, that data
              on the other person's device is not affected, and that screenshots,
              exports, and external copies cannot be deleted by any app.
            </span>
          </label>
          <div className="button-row">
            <button
              type="button"
              className="button ghost"
              onClick={close}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              disabled={!understood}
              onClick={() => setPhase('arms')}
            >
              <AlertIcon size={15} />
              Continue to arming
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'arms' ? (
        <div>
          <div className="callout warning" role="alert">
            <InfoIcon size={17} />
            <p>
              Final confirmation before anything is deleted. The deletion
              begins only when you press <strong>ERASE EVERYTHING</strong>.
            </p>
          </div>
          <label className="field">
            <span>Type ERASE to confirm</span>
            <input
              value={armed}
              onChange={(event) => setArmed(event.target.value)}
              placeholder="ERASE"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="button-row">
            <button type="button" className="button ghost" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              disabled={armed.trim() !== 'ERASE'}
              onClick={() => void execute()}
            >
              <AlertIcon size={15} />
              ERASE EVERYTHING
            </button>
          </div>
        </div>
      ) : null}

      {(phase === 'running' || phase === 'result') && report ? (
        <div>
          <ReportView planSteps={planSteps} report={report} running={phase === 'running'} />
          <div className="button-row">
            <button
              type="button"
              className={canFinish ? 'button danger' : 'button ghost'}
              disabled={phase === 'running'}
              onClick={() => {
                clearPersistedKillSwitchReport();
                if (canFinish) {
                  reset();
                  void onFinished();
                } else {
                  reset();
                  onClose();
                }
              }}
            >
              {canFinish
                ? 'Done — return to identity setup'
                : 'Close'}
            </button>
          </div>
          <p className="muted small">
            Nothing stored outside DuoChat (browser caches managed by the
            operating system, OS-level backups, screenshots) is deleted or
            overwritable — see the deletion documentation.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Per-conversation: Conversation → Security → Clear Everything         */
/* ------------------------------------------------------------------ */

export function ClearChatDialog({
  open,
  onClose,
  engine,
  uid,
  peerUid,
}: {
  open: boolean;
  onClose: () => void;
  engine: ChatEngine | null;
  uid: string;
  peerUid: string;
}) {
  const [phase, setPhase] = useState<Phase>('setup');
  const [mode, setMode] = useState<KillSwitchMode>('local-only');
  const [understood, setUnderstood] = useState(false);
  const [report, setReport] = useState<KillSwitchReport | null>(null);
  const planSteps = useMemo(
    () => stepsForPlan('conversation', mode),
    [mode],
  );

  function reset() {
    setPhase('setup');
    setMode('local-only');
    setUnderstood(false);
    setReport(null);
  }

  function close() {
    if (phase === 'running') return;
    reset();
    onClose();
  }

  async function execute() {
    const deps = buildKillSwitchDeps(engine, uid, peerUid);
    if (!deps) return;
    setPhase('running');
    setReport(null);
    const finished = await runConversationKillSwitch(deps, mode, (progress) => {
      setReport({ ...progress, steps: [...progress.steps] });
    }).catch((error) => {
      const failed = {
        version: 1 as const,
        scope: 'conversation' as const,
        mode,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        steps: [
          {
            stepId: 'conv.run.abort',
            status: 'failed' as const,
            details: `Erase aborted before completion: ${String(error).slice(0, 120)}`,
          },
        ],
      };
      setReport(failed);
      return failed as KillSwitchReport;
    });
    setReport(finished);
    setPhase('result');
  }

  return (
    <Modal
      open={open}
      onClose={close}
      eyebrow="Conversation · Security"
      title="Clear Everything"
    >
      {phase === 'setup' ? (
        <div>
          <p className="muted small">
            Choose what to erase for this conversation only. Your global
            identity keys stay. Other conversations are not affected.
          </p>
          <label className="option-row">
            <input
              type="radio"
              name="clear-mode"
              checked={mode === 'local-only'}
              onChange={() => setMode('local-only')}
            />
            <div>
              <strong>CLEAR LOCAL CHAT</strong>
              <p className="muted small">
                Deletes every local message, delivery record, and draft row for
                this conversation. The contact stays in the list and the
                encryption session is kept, so history up to the next exchange
                remains mutually consistent.
              </p>
            </div>
          </label>
          <label className="option-row">
            <input
              type="radio"
              name="clear-mode"
              checked={mode === 'local-plus-session-state'}
              onChange={() => setMode('local-plus-session-state')}
            />
            <div>
              <strong>DELETE CHAT AND LOCAL SESSION STATE</strong>
              <p className="muted small">
                Everything from CLEAR LOCAL CHAT, plus this conversation's
                session trust state: the authenticated direct channel is torn
                down and locally cached peer trust entries are erased. Sending
                again requires a new identity handshake first.
              </p>
            </div>
          </label>
          {mode === 'local-plus-session-state' ? (
            <div className="callout subtle">
              <InfoIcon size={17} />
              <p>
                For group conversations this affects only this device's local
                group state, never other members' devices. After erasing, a new
                subject handshake may be needed before the next exchange.
              </p>
            </div>
          ) : null}
          <label className="check-row">
            <input
              type="checkbox"
              checked={understood}
              onChange={(event) => setUnderstood(event.target.checked)}
            />
            <span>
              I understand this deletes local data only; the other side keeps
              its copy and screenshots or exports cannot be deleted.
            </span>
          </label>
          <div className="button-row">
            <button type="button" className="button ghost" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              disabled={!understood}
              onClick={() => setPhase('arms')}
            >
              <AlertIcon size={15} />
              {mode === 'local-only'
                ? 'Continue: CLEAR LOCAL CHAT'
                : 'Continue: DELETE CHAT AND LOCAL SESSION STATE'}
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'arms' ? (
        <div>
          <div className="callout warning" role="alert">
            <AlertIcon size={17} />
            <p>
              This deletes local content for the selected conversation only.
              Press the button below to wipe; Cancel leaves everything intact.
            </p>
          </div>
          <div className="button-row">
            <button type="button" className="button ghost" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => void execute()}
            >
              <AlertIcon size={15} />
              {mode === 'local-only'
                ? 'CLEAR LOCAL CHAT'
                : 'DELETE CHAT AND LOCAL SESSION STATE'}
            </button>
          </div>
        </div>
      ) : null}

      {(phase === 'running' || phase === 'result') && report ? (
        <div>
          <ReportView planSteps={planSteps} report={report} running={phase === 'running'} />
          <div className="button-row">
            <button
              type="button"
              className="button ghost"
              disabled={phase === 'running'}
              onClick={() => {
                reset();
                onClose();
              }}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
