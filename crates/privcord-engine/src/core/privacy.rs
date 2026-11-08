//! Emergency deletion: the engine's side of the kill-switch plans (`killswitch.ts`, `KillSwitch.kt`).
//!
//! The platform stops its own services and deletes its own files; the engine erases everything it holds, step by step,
//! and reports truthfully what happened. A report is saved after every step so a crash is visible on restart.

use super::{Core, StorageOp};
use crate::api::EngineEvent;
use privcord_domain::{
    killswitch::{
        planned_steps, run_kill_switch, KillSwitchExecutor, KillSwitchMode, KillSwitchReport,
        KillSwitchScope, PlanStep, StepResult, StepStatus,
    },
    link_policy::LivenessMonitor,
    mesh::MeshNode,
    ConversationId, UserId,
};
use privcord_ports::EraseScope;
use serde_json::{json, Value};

const KV_REPORT: &str = "killswitch.report";

fn status_str(s: StepStatus) -> &'static str {
    match s {
        StepStatus::Erased => "erased",
        StepStatus::Skipped => "skipped",
        StepStatus::Failed => "failed",
    }
}

fn report_to_json(r: &KillSwitchReport) -> Value {
    json!({
        "version": 1,
        "scope": if r.scope == KillSwitchScope::Application { "application" } else { "conversation" },
        "target": r.target,
        "mode": if r.mode == KillSwitchMode::LocalOnly { "local-only" } else { "local-plus-session-state" },
        "startedAt": r.started_at,
        "finishedAt": r.finished_at,
        "steps": r.steps.iter().map(|s| json!({
            "stepId": s.step_id, "status": status_str(s.status), "details": s.details,
        })).collect::<Vec<_>>(),
    })
}

fn report_from_json(v: &Value) -> Option<KillSwitchReport> {
    let o = v.as_object()?;
    let steps = o
        .get("steps")?
        .as_array()?
        .iter()
        .map(|s| {
            Some(StepResult {
                step_id: s.get("stepId")?.as_str()?.to_owned(),
                status: match s.get("status")?.as_str()? {
                    "erased" => StepStatus::Erased,
                    "skipped" => StepStatus::Skipped,
                    "failed" => StepStatus::Failed,
                    _ => return None,
                },
                details: s.get("details").and_then(Value::as_str).map(str::to_owned),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(KillSwitchReport {
        scope: if o.get("scope")?.as_str()? == "application" {
            KillSwitchScope::Application
        } else {
            KillSwitchScope::Conversation
        },
        target: o.get("target").and_then(Value::as_str).map(str::to_owned),
        mode: if o.get("mode")?.as_str()? == "local-only" {
            KillSwitchMode::LocalOnly
        } else {
            KillSwitchMode::LocalPlusSessionState
        },
        started_at: o.get("startedAt")?.as_i64()?,
        finished_at: o.get("finishedAt").and_then(Value::as_i64),
        steps,
    })
}

struct Wipe<'a> {
    core: &'a mut Core,
    scope: KillSwitchScope,
    conversation: Option<ConversationId>,
}

type StepOutcome = Result<(StepStatus, Option<String>), String>;

impl Wipe<'_> {
    fn storage(&mut self, op: StorageOp) -> StepOutcome {
        self.core
            .ports
            .storage
            .apply(&[op])
            .map(|()| (StepStatus::Erased, None))
            .map_err(|e| e.to_string())
    }

    fn peer_of(&self) -> Option<UserId> {
        match &self.conversation {
            Some(ConversationId::Direct(u)) => Some(u.clone()),
            _ => None,
        }
    }

    fn forget_messages_where(&mut self, keep: impl Fn(&ConversationId) -> bool) {
        self.core.messages.retain(|_, m| keep(&m.conversation));
        let alive = |id: &privcord_domain::MessageId, core: &Core| core.messages.contains_key(id);
        let ids: Vec<_> = self
            .core
            .outbox
            .iter()
            .filter(|o| !alive(&o.message_id, self.core))
            .map(|o| o.message_id.clone())
            .collect();
        self.core.outbox.retain(|o| !ids.contains(&o.message_id));
    }

    fn app_step(&mut self, id: &str) -> StepOutcome {
        match id {
            "network.shutdown" => {
                let peers: Vec<UserId> = self.core.peers.keys().cloned().collect();
                for p in &peers {
                    self.core.link_down(p);
                    self.core.ports.transport.close(p);
                }
                self.core.mesh = MeshNode::default();
                self.core.stop_invite();
                self.core.clear_answer();
                Ok((StepStatus::Erased, None))
            }
            "services.stop" => Ok((
                StepStatus::Skipped,
                Some(
                    "The engine runs no background service of its own; the app stops its own."
                        .into(),
                ),
            )),
            "transfers.cancel" => {
                for p in self.core.peers.values_mut() {
                    p.files.clear();
                }
                Ok((StepStatus::Erased, None))
            }
            "messages.erase" => {
                let r = self.storage(StorageOp::Erase(EraseScope::Messages));
                if r.is_ok() {
                    self.core.messages.clear();
                    self.core.outbox.clear();
                }
                r
            }
            "contacts.erase" => {
                let r = self.storage(StorageOp::Erase(EraseScope::Contacts));
                if r.is_ok() {
                    self.core.contacts.clear();
                    self.core.peers.clear();
                    self.core.groups = None;
                    self.core.channels.clear();
                }
                r
            }
            "attachments.erase" => self.storage(StorageOp::Erase(EraseScope::Files)),
            "queues.erase" => {
                let r = self.storage(StorageOp::Erase(EraseScope::Outbox));
                if r.is_ok() {
                    self.core.outbox.clear();
                    self.core.mesh = MeshNode::default();
                }
                r
            }
            "keys.erase" => {
                let r = self
                    .core
                    .ports
                    .secure
                    .delete_identity()
                    .map(|()| (StepStatus::Erased, None))
                    .map_err(|e| e.to_string());
                if r.is_ok() {
                    self.core.identity = None;
                    self.core.uid = None;
                    self.core.groups = None;
                }
                r
            }
            "database.erase" => self.storage(StorageOp::Erase(EraseScope::All)),
            "settings.erase" => {
                self.core.group_only = false;
                self.core.display_name = None;
                self.core.channels.clear();
                self.core.invites = super::invites::InviteState::default();
                Ok((StepStatus::Erased, None))
            }
            _ => Err("unknown step".into()),
        }
    }

    fn conversation_step(&mut self, id: &str) -> StepOutcome {
        let Some(conv) = self.conversation.clone() else {
            return Err("no conversation".into());
        };
        match id {
            "conv.transfers.cancel" => {
                if let Some(p) = self.peer_of().and_then(|u| self.core.peers.get_mut(&u)) {
                    p.files.clear();
                }
                Ok((StepStatus::Erased, None))
            }
            "conv.messages.erase" => {
                let r = self.storage(StorageOp::Erase(EraseScope::Conversation(conv.clone())));
                if r.is_ok() {
                    self.forget_messages_where(|c| *c != conv);
                }
                r
            }
            "conv.session.erase" => match self.peer_of() {
                Some(u) => {
                    self.core.link_down(&u);
                    self.core.ports.transport.close(&u);
                    if let Some(p) = self.core.peers.get_mut(&u) {
                        p.liveness = LivenessMonitor::new(0);
                        p.group_only = None;
                    }
                    Ok((StepStatus::Erased, None))
                }
                None => Ok((
                    StepStatus::Skipped,
                    Some("Only one-to-one chats have an encryption session.".into()),
                )),
            },
            _ => Err("unknown step".into()),
        }
    }
}

impl KillSwitchExecutor for Wipe<'_> {
    fn plan_steps(&self, mode: KillSwitchMode) -> Vec<PlanStep> {
        planned_steps(self.scope, mode)
    }

    fn perform_step(&mut self, step_id: &str) -> StepOutcome {
        match self.scope {
            KillSwitchScope::Application => self.app_step(step_id),
            KillSwitchScope::Conversation => self.conversation_step(step_id),
        }
    }

    fn persist_report(&mut self, report: &KillSwitchReport) {
        // Step ids and statuses only, never content: after a crash the next start can see how far it got.
        let _ = self.core.ports.storage.apply(&[StorageOp::SetKv {
            key: KV_REPORT.into(),
            value: report_to_json(report).to_string().into_bytes(),
        }]);
    }
}

impl Core {
    /// The report of the last emergency deletion that was started, if any.
    pub fn last_kill_switch_report(&self) -> Option<KillSwitchReport> {
        let bytes = self.ports.storage.kv(KV_REPORT).ok().flatten()?;
        report_from_json(&serde_json::from_slice(&bytes).ok()?)
    }

    /// Delete one chat here. With `erase_session` a one-to-one chat also forgets its secure session.
    pub fn kill_switch_conversation(
        &mut self,
        conversation: ConversationId,
        erase_session: bool,
    ) -> KillSwitchReport {
        let mode = if erase_session {
            KillSwitchMode::LocalPlusSessionState
        } else {
            KillSwitchMode::LocalOnly
        };
        let target = conversation.storage_key();
        let now = self.ports.clock.clone();
        let mut exec = Wipe {
            core: self,
            scope: KillSwitchScope::Conversation,
            conversation: Some(conversation),
        };
        let report = run_kill_switch(
            &mut exec,
            KillSwitchScope::Conversation,
            mode,
            Some(&target),
            None,
            &mut || now.now_ms(),
        );
        self.hub.publish(EngineEvent::Wiped);
        report
    }

    /// Erase everything this device holds. A report left unfinished by a crash is continued, not started over.
    pub fn kill_switch_app(&mut self) -> KillSwitchReport {
        let existing = self
            .last_kill_switch_report()
            .filter(|r| r.scope == KillSwitchScope::Application && r.finished_at.is_none());
        let now = self.ports.clock.clone();
        let mut exec = Wipe {
            core: self,
            scope: KillSwitchScope::Application,
            conversation: None,
        };
        let report = run_kill_switch(
            &mut exec,
            KillSwitchScope::Application,
            KillSwitchMode::LocalOnly,
            None,
            existing,
            &mut || now.now_ms(),
        );
        self.hub.publish(EngineEvent::Wiped);
        report
    }
}
