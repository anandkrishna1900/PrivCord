//! The hosted engine as a separate process, for the page's end-to-end tests (`apps/desktop/src/lib/hosted/e2e.test.ts`).
//! It stands in for the Tauri shell: JSON lines in on stdin, JSON lines out on stdout.
//!
//! In:  {"id":1,"command":"engine_invoke"|"engine_start"|"engine_stop","args":{...}}   (for engine_invoke: args = {command, args})
//! Out: {"id":1,"ok":<json>} | {"id":1,"err":"..."}
//!      {"ev":"event"|"frame"|"close"|"signal-subscribe"|"signal-unsubscribe"|"signal-put"|"notify","payload":<json>}
//!
//! Usage: host_stdio <path of the database file> [identity secrets as 128 hex characters: preloaded into the secret store]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::print_stdout
)]

use privcord_desktop_host::DesktopHost;
use privcord_ffi::{NotifierCallbacks, SecureStoreCallbacks, SignalKind, TransportCallbacks};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

fn emit(value: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn event(name: &str, payload: Value) {
    emit(&json!({ "ev": name, "payload": payload }));
}

#[derive(Default)]
struct Keys(Mutex<Option<Vec<u8>>>);
impl SecureStoreCallbacks for Keys {
    fn load_identity(&self) -> Option<Vec<u8>> {
        self.0.lock().unwrap().clone()
    }
    fn save_identity(&self, secrets: Vec<u8>) -> bool {
        *self.0.lock().unwrap() = Some(secrets);
        true
    }
    fn delete_identity(&self) {
        *self.0.lock().unwrap() = None;
    }
    // A fixed test key: every database in these tests is new, and reopening one must find the same key.
    fn load_database_key(&self) -> Option<Vec<u8>> {
        Some(vec![9u8; 32])
    }
    fn save_database_key(&self, _key: Vec<u8>) -> bool {
        true
    }
}

struct Page;
impl TransportCallbacks for Page {
    fn send(&self, peer: String, frame: String) -> bool {
        event("frame", json!({ "peer": peer, "frame": frame }));
        true
    }
    fn send_raw(&self, _link: String, _frame: String) -> bool {
        false
    }
    fn close(&self, peer: String) {
        event("close", json!({ "peer": peer }));
    }
    fn signal_available(&self) -> bool {
        true
    }
    fn signal_subscribe(&self, mailbox: String) -> bool {
        event("signal-subscribe", json!({ "mailbox": mailbox }));
        true
    }
    fn signal_unsubscribe(&self, mailbox: String) {
        event("signal-unsubscribe", json!({ "mailbox": mailbox }));
    }
    fn signal_put(&self, mailbox: String, blob: String, kind: SignalKind, ttl_sec: u32) -> bool {
        let kind = if kind == SignalKind::Live {
            "live"
        } else {
            "stored"
        };
        event(
            "signal-put",
            json!({ "mailbox": mailbox, "blob": blob, "kind": kind, "ttlSec": ttl_sec }),
        );
        true
    }
}

impl NotifierCallbacks for Page {
    fn message_received(&self, conversation: String, sender: String, preview: String) {
        event(
            "notify",
            json!({ "conversation": conversation, "sender": sender, "preview": preview }),
        );
    }
}

fn main() {
    let db = std::env::args().nth(1).expect("database path");
    let host: Arc<Mutex<Option<Arc<DesktopHost>>>> = Arc::new(Mutex::new(None));
    let secure = Arc::new(Keys::default());
    if let Some(hex) = std::env::args().nth(2) {
        let bytes: Vec<u8> = (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
            .collect();
        *secure.0.lock().unwrap() = Some(bytes);
    }
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(cmd) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = cmd["id"].clone();
        let args = cmd["args"].clone();
        let result: Result<Value, String> = match cmd["command"].as_str().unwrap_or_default() {
            "engine_start" => {
                let mut slot = host.lock().unwrap();
                if slot.is_none() {
                    match DesktopHost::start(
                        &db,
                        "duo",
                        secure.clone(),
                        Arc::new(Page),
                        Arc::new(Page),
                    ) {
                        Ok(h) => {
                            let h = Arc::new(h);
                            let pump = h.clone();
                            std::thread::spawn(move || loop {
                                if let Some(e) = pump.next_event(200) {
                                    event("event", e);
                                }
                            });
                            *slot = Some(h);
                            Ok(Value::Null)
                        }
                        Err(e) => Err(e),
                    }
                } else {
                    Ok(Value::Null)
                }
            }
            "engine_invoke" => {
                let h = host.lock().unwrap().clone();
                match h {
                    Some(h) => {
                        h.invoke(args["command"].as_str().unwrap_or_default(), &args["args"])
                    }
                    None => Err("the engine is not started".into()),
                }
            }
            "engine_stop" => {
                if let Some(h) = host.lock().unwrap().take() {
                    h.shutdown();
                }
                Ok(Value::Null)
            }
            other => Err(format!("unknown host command {other}")),
        };
        match result {
            Ok(ok) => emit(&json!({ "id": id, "ok": ok })),
            Err(err) => emit(&json!({ "id": id, "err": err })),
        }
    }
}
