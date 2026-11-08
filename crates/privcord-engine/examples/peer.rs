//! A live Rust engine for the interop harness (`apps/desktop/e2e/rust-peer.mjs`). It speaks JSON lines on stdin/stdout and
//! stands in for the other phone: the harness carries Bluetooth chunks between a real desktop page and this process.
//!
//! In:  {"id":1,"cmd":"init"|"add"|"link_up"|"link_down"|"chunk"|"send"|"snapshot", ...}
//! Out: {"id":1,"ok":...} | {"id":1,"err":"..."} | {"ev":"chunk","data":"<hex>"} (a chunk to put on the air)
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use privcord_crypto::rng::OsEntropy;
use privcord_domain::{
    ble::{encode_json_frame, Reassembler},
    privacy::ContactTrust,
    state::{ConnectionPath, ConnectionState},
    UserId,
};
use privcord_engine::{EngineHandle, LinkSecurity, Ports};
use privcord_ports::{
    testing::{MemorySecureStore, MemoryStorage, RecordingNotifier},
    Clock, Transport, TransportError,
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_CHUNK: usize = 185;

fn emit(value: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

struct SystemClock;
impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap()
    }
}

/// The radio: every frame the engine sends is cut into Bluetooth chunks and handed to the harness.
struct Radio;
impl Transport for Radio {
    fn send(&self, _peer: &UserId, frame: &str) -> Result<(), TransportError> {
        let value: Value = serde_json::from_str(frame).map_err(|_| TransportError::Refused)?;
        for chunk in encode_json_frame(&value, MAX_CHUNK).map_err(|_| TransportError::Refused)? {
            let hex: String = chunk.iter().map(|b| format!("{b:02x}")).collect();
            emit(&json!({ "ev": "chunk", "data": hex }));
        }
        Ok(())
    }
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .filter_map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

fn user(v: &Value) -> Result<UserId, String> {
    UserId::new(v.as_str().unwrap_or_default()).map_err(|e| e.to_string())
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let (engine, mut events) = EngineHandle::start(Ports {
        storage: MemoryStorage::new(),
        secure: MemorySecureStore::new(),
        transport: std::sync::Arc::new(Radio),
        clock: std::sync::Arc::new(SystemClock),
        notifier: RecordingNotifier::new(),
        entropy: Box::new(OsEntropy),
    })
    .expect("engine starts");
    // Engine events go to stderr so a failed handshake can be diagnosed.
    std::thread::spawn(move || {
        while let Ok((_, e)) = events.recv() {
            if std::env::var_os("PEER_TRACE").is_some() {
                eprintln!("[rust event] {e:?}");
            }
        }
    });
    let reassembler = Mutex::new(Reassembler::new());
    let stdin = std::io::stdin();
    // Stdin is read on this thread; commands run to completion one at a time.
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(cmd) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = cmd["id"].clone();
        let result: Result<Value, String> = async {
            match cmd["cmd"].as_str().unwrap_or_default() {
                "init" => {
                    engine.create_identity().await.map_err(|e| format!("{e:?}"))?;
                    let name = cmd["name"].as_str().unwrap_or("Rusty");
                    let card = engine.own_card(Some(name)).await.map_err(|e| format!("{e:?}"))?;
                    Ok(json!({ "card": card }))
                }
                "add" => {
                    let uid = engine
                        .add_contact(cmd["card"].as_str().unwrap_or_default(), ContactTrust::Verified)
                        .await
                        .map_err(|e| format!("{e:?}"))?;
                    Ok(json!({ "uid": uid.to_string() }))
                }
                "link_up" => {
                    reassembler.lock().unwrap().reset();
                    engine
                        .link_up_with(
                            &user(&cmd["peer"])?,
                            ConnectionPath::Bluetooth,
                            LinkSecurity::Layered,
                        )
                        .await
                        .map_err(|e| format!("{e:?}"))?;
                    Ok(Value::Null)
                }
                "link_down" => {
                    engine.link_down(&user(&cmd["peer"])?).map_err(|e| format!("{e:?}"))?;
                    Ok(Value::Null)
                }
                "chunk" => {
                    let frame = reassembler
                        .lock()
                        .unwrap()
                        .push(&unhex(cmd["data"].as_str().unwrap_or_default()))
                        .map_err(|e| e.to_string())?;
                    if let Some(bytes) = frame {
                        engine
                            .frame_received(
                                &user(&cmd["peer"])?,
                                String::from_utf8_lossy(&bytes).into_owned(),
                            )
                            .map_err(|e| format!("{e:?}"))?;
                    }
                    Ok(Value::Null)
                }
                "send" => {
                    let text = cmd["text"].as_str().unwrap_or_default();
                    let mid = engine
                        .send_message(&user(&cmd["peer"])?, text, None)
                        .await
                        .map_err(|e| format!("{e:?}"))?;
                    Ok(json!({ "message_id": mid.to_string() }))
                }
                "snapshot" => {
                    let s = engine.snapshot().await.map_err(|e| format!("{e:?}"))?;
                    let contacts: Vec<Value> = s
                        .contacts
                        .iter()
                        .map(|c| {
                            json!({
                                "uid": c.uid.to_string(),
                                "connected": matches!(c.connection, ConnectionState::Connected { .. }),
                                "state": format!("{:?}", c.connection),
                            })
                        })
                        .collect();
                    let messages: Vec<Value> = s
                        .messages
                        .iter()
                        .flat_map(|(_, ms)| ms.iter())
                        .map(|m| {
                            json!({
                                "text": m.text,
                                "from": m.sender_id.to_string(),
                                "delivery": format!("{:?}", m.delivery_state),
                            })
                        })
                        .collect();
                    Ok(json!({ "own": s.own_uid.map(|u| u.to_string()), "contacts": contacts, "messages": messages }))
                }
                other => Err(format!("unknown command {other}")),
            }
        }
        .await;
        match result {
            Ok(ok) => emit(&json!({ "id": id, "ok": ok })),
            Err(err) => emit(&json!({ "id": id, "err": err })),
        }
    }
    let _ = engine.shutdown().await;
}
