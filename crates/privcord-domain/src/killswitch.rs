//! Emergency-erase plans and the truthful report (`killswitch.ts`).
//!
//! An activation is an ordered checklist: the platform implements each step (stop networking, erase the database, wipe
//! keys...), runs it through [`run_kill_switch`], and always ends with a report that never claims more than was done.
//! A failed or unclaimed step makes the result partial.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillSwitchScope {
    Application,
    Conversation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepStatus {
    Erased,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillSwitchMode {
    LocalOnly,
    LocalPlusSessionState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanStep {
    pub index: usize,
    pub id: &'static str,
    pub label: &'static str,
    /// Short explanation shown in the emergency screen.
    pub detail: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepResult {
    pub step_id: String,
    pub status: StepStatus,
    /// Why, in words; never message content.
    pub details: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillSwitchReport {
    pub scope: KillSwitchScope,
    /// For conversation scope: the public routing id only.
    pub target: Option<String>,
    pub mode: KillSwitchMode,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub steps: Vec<StepResult>,
}

pub const APP_STEPS: [PlanStep; 10] = [
    PlanStep { index: 0, id: "network.shutdown", label: "Disconnect networking", detail: "Bluetooth, WebRTC peers, signaling and relays are disconnected and all active transfers cancelled." },
    PlanStep { index: 1, id: "services.stop", label: "Stop background services", detail: "Background reception and relay participation stop and cannot deliver anything anymore." },
    PlanStep { index: 2, id: "transfers.cancel", label: "Cancel transfers", detail: "Active and queued file transfers are cancelled and their partial chunks deleted." },
    PlanStep { index: 3, id: "messages.erase", label: "Erase conversations and messages", detail: "Every conversation, message, draft, search index, and delivery record is deleted." },
    PlanStep { index: 4, id: "contacts.erase", label: "Erase contacts and groups", detail: "Contacts, trust records, and local group membership and group keys are deleted." },
    PlanStep { index: 5, id: "attachments.erase", label: "Erase files and media", detail: "Downloaded attachments, previews, thumbnails and temporary transfer files are deleted." },
    PlanStep { index: 6, id: "queues.erase", label: "Erase queues and caches", detail: "Outgoing, incoming and relay store-and-forward queues plus app-managed caches are deleted." },
    PlanStep { index: 7, id: "keys.erase", label: "Erase cryptographic state", detail: "Identity keys, session keys and all other locally stored secrets are deleted." },
    PlanStep { index: 8, id: "database.erase", label: "Erase local database", detail: "The local encrypted database and app-managed temporary files are deleted." },
    PlanStep { index: 9, id: "settings.erase", label: "Erase settings and reset app", detail: "Application settings are cleared and the app returns to first-run onboarding." },
];

pub const CONVERSATION_STEPS: [PlanStep; 3] = [
    PlanStep { index: 0, id: "conv.transfers.cancel", label: "Cancel transfers in this chat", detail: "Active and queued file transfers for this conversation are cancelled." },
    PlanStep { index: 1, id: "conv.messages.erase", label: "Erase this chat locally", detail: "Messages, attachments, previews, drafts, queues and delivery records for this conversation are deleted." },
    PlanStep { index: 2, id: "conv.session.erase", label: "Erase chat encryption session", detail: "Only with \u{201c}Delete chat and local session state\u{201d}: future messages will require a new secure session handshake." },
];

/// The steps a scope and mode must answer. "Clear local chat" deliberately has no session-erase step.
pub fn planned_steps(scope: KillSwitchScope, mode: KillSwitchMode) -> Vec<PlanStep> {
    match scope {
        KillSwitchScope::Application => APP_STEPS.to_vec(),
        KillSwitchScope::Conversation => CONVERSATION_STEPS
            .iter()
            .copied()
            .filter(|s| !(s.id == "conv.session.erase" && mode == KillSwitchMode::LocalOnly))
            .collect(),
    }
}

impl KillSwitchReport {
    pub fn empty(
        scope: KillSwitchScope,
        mode: KillSwitchMode,
        target: Option<&str>,
        now: i64,
    ) -> Self {
        Self {
            scope,
            target: target.map(str::to_owned),
            mode,
            started_at: now,
            finished_at: None,
            steps: Vec::new(),
        }
    }

    pub fn record(&mut self, step_id: &str, status: StepStatus, details: Option<String>) {
        self.steps.push(StepResult {
            step_id: step_id.to_owned(),
            status,
            details,
        });
    }

    pub fn finish(&mut self, now: i64) {
        self.finished_at = Some(now);
    }

    /// The screen must show exactly this, never a false "complete".
    pub fn summarize(&self) -> KillSwitchSummary {
        let ids_with = |status: StepStatus| -> Vec<String> {
            self.steps
                .iter()
                .filter(|s| s.status == status)
                .map(|s| s.step_id.clone())
                .collect()
        };
        let failed = ids_with(StepStatus::Failed);
        let skipped = ids_with(StepStatus::Skipped);
        let unclaimed = planned_steps(self.scope, self.mode)
            .iter()
            .any(|p| !self.steps.iter().any(|s| s.step_id == p.id));
        KillSwitchSummary {
            complete: failed.is_empty() && !unclaimed,
            partial: !failed.is_empty() || unclaimed,
            failed_step_ids: failed,
            skipped_step_ids: skipped,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillSwitchSummary {
    pub complete: bool,
    pub partial: bool,
    pub failed_step_ids: Vec<String>,
    pub skipped_step_ids: Vec<String>,
}

/// Failure details are kept short (160 UTF-16 units) and never carry content.
pub fn truncate(text: &str, max: usize) -> String {
    if text.encode_utf16().count() <= max {
        return text.to_owned();
    }
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    out.push('\u{2026}');
    out
}

/// What a platform provides. Every step in the plan must be answered, including failures, so the report stays truthful
/// even if the app dies half way: on restart the stored report is compared with the plan.
pub trait KillSwitchExecutor {
    fn plan_steps(&self, mode: KillSwitchMode) -> Vec<PlanStep>;
    /// `Err` is a failure; keep its text free of message content.
    fn perform_step(&mut self, step_id: &str) -> Result<(StepStatus, Option<String>), String>;
    /// Save the in-progress report between steps (crash resilience).
    fn persist_report(&mut self, _report: &KillSwitchReport) {}
}

/// Run the plan. With `existing`, steps already erased are not repeated (resuming after a crash or a retry).
pub fn run_kill_switch(
    executor: &mut dyn KillSwitchExecutor,
    scope: KillSwitchScope,
    mode: KillSwitchMode,
    target: Option<&str>,
    existing: Option<KillSwitchReport>,
    now: &mut dyn FnMut() -> i64,
) -> KillSwitchReport {
    let mut report = match existing {
        Some(mut r) => {
            r.finished_at = None;
            r
        }
        None => KillSwitchReport::empty(scope, mode, target, now()),
    };
    for step in executor.plan_steps(report.mode) {
        let previous = report.steps.iter().find(|s| s.step_id == step.id);
        if previous.is_some_and(|p| p.status == StepStatus::Erased) {
            continue; // done in an earlier attempt
        }
        report.steps.retain(|s| s.step_id != step.id);
        match executor.perform_step(step.id) {
            Ok((status, details)) => report.record(step.id, status, details),
            Err(e) => report.record(step.id, StepStatus::Failed, Some(truncate(&e, 160))),
        }
        executor.persist_report(&report);
    }
    report.finish(now());
    executor.persist_report(&report);
    report
}
