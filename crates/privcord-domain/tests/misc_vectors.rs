//! Pairing, reconnect backoff, kill-switch plans and manual connection codes against what the TypeScript produced
//! (`docs/misc-vectors.json`, from `packages/protocol/scripts/gen-misc-vectors.ts`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_domain::{
    killswitch::{
        planned_steps, run_kill_switch, KillSwitchExecutor, KillSwitchMode, KillSwitchReport,
        KillSwitchScope, PlanStep, StepStatus, APP_STEPS, CONVERSATION_STEPS,
    },
    link_policy::{
        accept_incoming, due_links, group_delivery_detail, is_initiator, LinkInfo, LivenessMonitor,
        LivenessTick, PendingGroupBuffer, DEAD_LINK_MS, MAX_CONNECTING, MAX_LINKS,
    },
    pairing::{
        derive_pairing_status, reconnect_delay_ms, should_persist_pairing, PairingRecord,
        PairingStoreState,
    },
    signaling::{
        aggregate_status, relay, socket_backoff_ms, ManualSignal, SeenSet, SignalingStatus,
    },
};
use serde_json::Value;

fn vectors() -> Value {
    let root = env!("CARGO_MANIFEST_DIR");
    serde_json::from_str(
        &std::fs::read_to_string(format!("{root}/../../docs/misc-vectors.json")).unwrap(),
    )
    .unwrap()
}

#[test]
fn pairing_records_and_state_match_typescript() {
    let v = vectors();
    let p = &v["pairing"];
    let rec = PairingRecord::from_value(&p["record"], None).unwrap();
    assert_eq!(rec.to_value()["peerUid"], "uid1");
    // Same person, device and key: paired_at is kept and last_connected_at moves.
    let again = PairingRecord::create(
        "uid1",
        "dev1",
        rec.public_key.clone(),
        None,
        "12345 67890",
        Some(&rec),
        5000,
    );
    assert_eq!(again.paired_at, p["again"]["pairedAt"].as_i64().unwrap());
    assert_eq!(again.last_connected_at, 5000);
    let other = PairingRecord::create(
        "uid1",
        "dev2",
        rec.public_key.clone(),
        None,
        "n",
        Some(&rec),
        9000,
    );
    assert_eq!(
        other.paired_at,
        p["otherDevice"]["pairedAt"].as_i64().unwrap()
    );
    assert!(rec.matches_peer("uid1", "dev1", &rec.public_key));
    assert!(!rec.matches_peer("uid1", "dev2", &rec.public_key));

    for case in p["parse"].as_array().unwrap() {
        let raw = case["raw"].as_str();
        let expected = case["expected"].as_str();
        let s = PairingStoreState::parse(raw, expected);
        let name = &case["name"];
        assert_eq!(s.record.is_some(), !case["record"].is_null(), "{name}");
        assert_eq!(
            s.auto_reconnect,
            case["autoReconnect"].as_bool().unwrap(),
            "{name}"
        );
        assert_eq!(
            s.can_auto_reconnect(),
            case["canAutoReconnect"].as_bool().unwrap(),
            "{name}"
        );
        if let Some(r) = &s.record {
            // What we read is what the TypeScript read.
            assert_eq!(r.peer_uid, case["record"]["peerUid"].as_str().unwrap());
            assert_eq!(r.paired_at, case["record"]["pairedAt"].as_i64().unwrap());
        }
    }
    // Our own output reads back, and the TypeScript output reads the same.
    let ours = PairingStoreState {
        record: Some(rec.clone()),
        auto_reconnect: false,
    };
    assert_eq!(
        PairingStoreState::parse(Some(&ours.serialize()), None),
        ours
    );
    let theirs = PairingStoreState::parse(p["serialized"].as_str(), None);
    assert_eq!(theirs.record, Some(rec));
    assert!(!theirs.auto_reconnect);

    for s in p["status"].as_array().unwrap() {
        let b = |k: &str| s[k].as_bool().unwrap();
        assert_eq!(
            derive_pairing_status(b("saved"), b("connected"), b("connecting"), b("failed"))
                .as_str(),
            s["status"].as_str().unwrap()
        );
    }
    for s in p["persist"].as_array().unwrap() {
        assert_eq!(
            should_persist_pairing(s["trust"].as_str().unwrap()),
            s["persist"].as_bool().unwrap()
        );
    }
    for d in p["delays"].as_array().unwrap() {
        assert_eq!(
            reconnect_delay_ms(d["attempt"].as_f64().unwrap(), None, None),
            d["ms"].as_f64().unwrap(),
            "attempt {}",
            d["attempt"]
        );
    }
    let attempts = [
        [0.0, 1.0, 2.0, 3.0, 4.0, 8.0].to_vec(),
        vec![0.0, 3.0],
        vec![0.0, 3.0],
    ];
    for (case, attempts) in p["delaysCustom"].as_array().unwrap().iter().zip(attempts) {
        let (base, max) = (
            case["opts"]["baseMs"].as_f64(),
            case["opts"]["maxMs"].as_f64(),
        );
        for (a, want) in attempts.iter().zip(case["ms"].as_array().unwrap()) {
            assert_eq!(reconnect_delay_ms(*a, base, max), want.as_f64().unwrap());
        }
    }
}

fn scope(s: &str) -> KillSwitchScope {
    if s == "application" {
        KillSwitchScope::Application
    } else {
        KillSwitchScope::Conversation
    }
}
fn mode(s: &str) -> KillSwitchMode {
    if s == "local-only" {
        KillSwitchMode::LocalOnly
    } else {
        KillSwitchMode::LocalPlusSessionState
    }
}
fn status(s: &str) -> StepStatus {
    match s {
        "erased" => StepStatus::Erased,
        "skipped" => StepStatus::Skipped,
        _ => StepStatus::Failed,
    }
}

#[test]
fn kill_switch_plans_and_summaries_match_typescript() {
    let v = vectors();
    let k = &v["killswitch"];
    for (rust, ts) in [
        (&APP_STEPS[..], &k["app"]),
        (&CONVERSATION_STEPS[..], &k["conversation"]),
    ] {
        let ts = ts.as_array().unwrap();
        assert_eq!(rust.len(), ts.len());
        for (r, t) in rust.iter().zip(ts) {
            assert_eq!(r.index, t["index"].as_u64().unwrap() as usize);
            assert_eq!(r.id, t["id"].as_str().unwrap());
            assert_eq!(r.label, t["label"].as_str().unwrap());
            assert_eq!(r.detail, t["detail"].as_str().unwrap());
        }
    }
    for case in k["summaries"].as_array().unwrap() {
        let (sc, mo) = (
            scope(case["scope"].as_str().unwrap()),
            mode(case["mode"].as_str().unwrap()),
        );
        let rep = &case["report"];
        let mut report = KillSwitchReport::empty(sc, mo, rep["target"].as_str(), 100);
        for s in rep["steps"].as_array().unwrap() {
            report.record(
                s["stepId"].as_str().unwrap(),
                status(s["status"].as_str().unwrap()),
                s["details"].as_str().map(str::to_owned),
            );
        }
        let got = report.summarize();
        let want = &case["summary"];
        let name = &case["name"];
        assert_eq!(got.complete, want["complete"].as_bool().unwrap(), "{name}");
        assert_eq!(got.partial, want["partial"].as_bool().unwrap(), "{name}");
        let ids = |k: &str| -> Vec<String> {
            want[k]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().to_owned())
                .collect()
        };
        assert_eq!(got.failed_step_ids, ids("failedStepIds"), "{name}");
        assert_eq!(got.skipped_step_ids, ids("skippedStepIds"), "{name}");
    }
    // The planned steps are exactly the claimed ones: Option A has no session erase.
    assert_eq!(
        planned_steps(KillSwitchScope::Conversation, KillSwitchMode::LocalOnly).len(),
        2
    );
    assert_eq!(
        planned_steps(
            KillSwitchScope::Conversation,
            KillSwitchMode::LocalPlusSessionState
        )
        .len(),
        3
    );
}

struct Exec {
    keys_throw: bool,
    calls: Vec<String>,
    saved: usize,
}
impl KillSwitchExecutor for Exec {
    fn plan_steps(&self, _m: KillSwitchMode) -> Vec<PlanStep> {
        APP_STEPS.to_vec()
    }
    fn perform_step(&mut self, id: &str) -> Result<(StepStatus, Option<String>), String> {
        self.calls.push(id.to_owned());
        match id {
            "network.shutdown" => Ok((StepStatus::Skipped, Some("no bluetooth here".into()))),
            "keys.erase" if self.keys_throw => Err(format!("Error: {}", "x".repeat(300))),
            _ => Ok((StepStatus::Erased, None)),
        }
    }
    fn persist_report(&mut self, _r: &KillSwitchReport) {
        self.saved += 1;
    }
}

#[test]
fn a_kill_switch_run_reports_failures_truthfully_and_resumes_without_repeating_finished_steps() {
    let v = vectors();
    let run = &v["killswitch"]["run"];
    let mut clock = 0;
    let mut now = || {
        clock += 1;
        clock
    };
    let mut exec = Exec {
        keys_throw: true,
        calls: vec![],
        saved: 0,
    };
    let first = run_kill_switch(
        &mut exec,
        KillSwitchScope::Application,
        KillSwitchMode::LocalOnly,
        None,
        None,
        &mut now,
    );
    let steps = |r: &KillSwitchReport| -> Vec<(String, String, Option<String>)> {
        r.steps
            .iter()
            .map(|s| {
                (
                    s.step_id.clone(),
                    format!("{:?}", s.status).to_lowercase(),
                    s.details.clone(),
                )
            })
            .collect()
    };
    let ts_steps = |j: &Value| -> Vec<(String, String, Option<String>)> {
        j["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                (
                    s["stepId"].as_str().unwrap().to_owned(),
                    s["status"].as_str().unwrap().to_owned(),
                    s["details"].as_str().map(str::to_owned),
                )
            })
            .collect()
    };
    assert_eq!(steps(&first), ts_steps(&run["first"]));
    assert_eq!(
        exec.calls.len(),
        run["first"]["calls"].as_array().unwrap().len()
    );
    assert!(first.finished_at.is_some() && exec.saved == APP_STEPS.len() + 1);
    assert!(first.summarize().partial);

    exec.calls.clear();
    exec.keys_throw = false;
    let resumed = run_kill_switch(
        &mut exec,
        KillSwitchScope::Application,
        KillSwitchMode::LocalOnly,
        None,
        Some(first),
        &mut now,
    );
    // Erased steps are not repeated; the skipped and the failed one are tried again.
    let want_calls: Vec<String> = run["resumed"]["calls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(exec.calls, want_calls);
    assert_eq!(resumed.steps.len(), APP_STEPS.len());
    assert!(resumed.summarize().complete);
    assert_eq!(resumed.summarize().skipped_step_ids, ["network.shutdown"]);
}

#[test]
fn manual_connection_codes_match_typescript() {
    let v = vectors();
    let m = &v["manual"];
    // Our decode reads the TypeScript code, and our encode reads back the same.
    let sig = ManualSignal::decode(m["encoded"].as_str().unwrap(), "duo").unwrap();
    assert_eq!(sig.from_uid, "uid1");
    assert_eq!(sig.created_at, 1_700_000_000_000);
    assert_eq!(ManualSignal::decode(&sig.encode(), "duo").unwrap(), sig);
    assert_eq!(sig.to_value()["publicKeyJwk"], m["signal"]["publicKeyJwk"]);
    for case in m["decode"].as_array().unwrap() {
        let got = ManualSignal::decode(
            case["code"].as_str().unwrap(),
            case["conv"].as_str().unwrap(),
        );
        let want = &case["result"];
        let name = &case["name"];
        if want["ok"].as_bool().unwrap() {
            assert!(got.is_ok(), "{name}: {got:?}");
        } else {
            assert_eq!(got.unwrap_err(), want["error"].as_str().unwrap(), "{name}");
        }
    }
}

#[test]
fn liveness_scheduling_and_buffers_follow_the_apps_rules() {
    let mut m = LivenessMonitor::new(0);
    assert_eq!(
        m.tick(DEAD_LINK_MS),
        LivenessTick::Ping,
        "exactly at the limit is still alive"
    );
    assert_eq!(m.tick(DEAD_LINK_MS + 1), LivenessTick::Lost);
    m.on_inbound(10_000);
    assert_eq!(
        m.tick(DEAD_LINK_MS + 1),
        LivenessTick::Ping,
        "any frame counts as proof of life"
    );

    assert!(is_initiator("a", "b") && !is_initiator("b", "a") && !is_initiator("a", "a"));
    let link = |uid: &str, ready, connecting, at, attempts| LinkInfo {
        uid: uid.into(),
        ready,
        connecting,
        last_attempt_at: at,
        attempts,
        dialable: true,
    };
    let now = 1_000_000;
    // Backoff: 5 s doubling; the longest-waiting goes first; at most 3 at once.
    let links = vec![
        link("up", true, false, 0, 0),
        link("fresh", false, false, now - 1_000, 0), // tried 1 s ago, needs 5 s: not yet
        link("old1", false, false, now - 50_000, 1), // needs 10 s: due
        link("old2", false, false, now - 90_000, 2), // needs 20 s: due, waited longest
        link("old3", false, false, now - 30_000, 0),
        link("old4", false, false, now - 20_000, 0),
        link("busy", false, true, 0, 0),
    ];
    assert_eq!(
        due_links(&links, now, MAX_CONNECTING, MAX_LINKS),
        ["old2", "old1"],
        "one slot is already connecting"
    );
    assert_eq!(
        due_links(&links, now, 10, MAX_LINKS),
        ["old2", "old1", "old3", "old4"]
    );
    assert_eq!(
        due_links(&links, now, 10, 2),
        Vec::<String>::new(),
        "the link cap leaves no room"
    );
    assert!(accept_incoming(29, MAX_LINKS) && !accept_incoming(30, MAX_LINKS));
    assert_eq!(group_delivery_detail(5, 2), (3, 5));
    assert_eq!(group_delivery_detail(5, 9), (0, 5));

    let mut buf: PendingGroupBuffer<u8> = PendingGroupBuffer::new(1000, 2);
    assert!(buf.hold("g", "u", 1, 0) && buf.hold("g", "v", 2, 0) && !buf.hold("g", "w", 3, 0));
    let got = buf.release(500, |_, from| from == "u");
    assert_eq!(got, [("g".into(), "u".into(), 1)]);
    assert_eq!(
        buf.release(2000, |_, _| true),
        Vec::<(String, String, u8)>::new(),
        "expired entries are dropped"
    );
    assert!(buf.is_empty());

    let mut seen = SeenSet::new(2);
    assert!(
        seen.first_time("a")
            && !seen.first_time("a")
            && seen.first_time("b")
            && seen.first_time("c")
    );
    assert!(seen.first_time("a"), "oldest was forgotten");
}

#[test]
fn signaling_rules_match_the_apps() {
    assert_eq!(
        (0..8).map(socket_backoff_ms).collect::<Vec<_>>(),
        [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]
    );
    use SignalingStatus::{Connecting, Error, Idle, Online};
    assert_eq!(aggregate_status(&[]), Idle);
    assert_eq!(aggregate_status(&[Error, Error]), Error);
    assert_eq!(aggregate_status(&[Error, Connecting]), Connecting);
    assert_eq!(aggregate_status(&[Connecting, Online, Error]), Online);

    assert_eq!(
        relay::sub_frame("mb", 5),
        r#"{"op":"sub","mailbox":"mb","since":5}"#
    );
    assert_eq!(
        relay::put_frame("mb", "id1", "BLOB", 120, "sig"),
        r#"{"op":"put","mailbox":"mb","id":"id1","blob":"BLOB","ttl":120,"kind":"sig"}"#
    );
    assert_eq!(
        relay::del_frame("mb", "id1"),
        r#"{"op":"del","mailbox":"mb","id":"id1"}"#
    );
    use relay::Incoming;
    assert_eq!(
        relay::parse_incoming(r#"{"op":"event","id":"i","blob":"b","ts":7}"#),
        Some(Incoming::Event {
            id: "i".into(),
            blob: "b".into(),
            ts: Some(7)
        })
    );
    assert_eq!(
        relay::parse_incoming(r#"{"op":"ok","id":"i"}"#),
        Some(Incoming::Ok { id: "i".into() })
    );
    assert_eq!(
        relay::parse_incoming(r#"{"op":"err","id":"i","reason":"too big"}"#),
        Some(Incoming::Err {
            id: "i".into(),
            reason: "too big".into()
        })
    );
    assert_eq!(
        relay::parse_incoming(r#"{"op":"err","id":"i"}"#),
        Some(Incoming::Err {
            id: "i".into(),
            reason: "Relay refused the message.".into()
        })
    );
    for bad in [
        "nope",
        r#"{"op":"event","id":"i"}"#,
        r#"{"op":"ok"}"#,
        r#"{"op":"zzz","id":"i"}"#,
        "[]",
    ] {
        assert_eq!(relay::parse_incoming(bad), None, "{bad}");
    }
}
