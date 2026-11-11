//! The Rust engine, hosted in the shell (milestone M7). Nothing in the app calls this yet: it is the seam the page will use
//! when `engine.ts` is rewired onto the engine (docs/rust/M7_DESKTOP_PLAN.md).
//!
//! The page keeps owning WebRTC and the relay sockets. It tells the engine what happened (`engine_invoke("link_up", ..)`,
//! `"frame_received"`, `"signal_blob"`) and listens for what the engine wants done, as Tauri events:
//!
//! | event                          | payload                                   | page should                                   |
//! |--------------------------------|-------------------------------------------|-----------------------------------------------|
//! | `privcord://event`             | an engine event (see `privcord-ffi`)      | refresh the snapshot, dial, show a toast, ... |
//! | `privcord://frame`             | `{ peer, frame }`                         | write the frame to that peer's data channel   |
//! | `privcord://close`             | `{ peer }`                                | close that peer's link                        |
//! | `privcord://signal-subscribe`  | `{ mailbox }`                             | listen on that mailbox                        |
//! | `privcord://signal-unsubscribe`| `{ mailbox }`                             | stop listening                                |
//! | `privcord://signal-put`        | `{ mailbox, blob, kind, ttlSec }`         | publish the blob to the relays                |
//! | `privcord://notify`            | `{ conversation, sender, preview }`       | show a notification                           |

use privcord_desktop_host::DesktopHost;
use privcord_ffi::{NotifierCallbacks, SecureStoreCallbacks, SignalKind, TransportCallbacks};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

const SERVICE: &str = "com.duochat.desktop";
const IDENTITY_KEY: &str = "engine-identity-v1";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// The identity's private scalars live in the OS credential store (Windows Credential Manager), never in the database.
struct KeyringSecure;

impl SecureStoreCallbacks for KeyringSecure {
    fn load_identity(&self) -> Option<Vec<u8>> {
        let entry = keyring::Entry::new(SERVICE, IDENTITY_KEY).ok()?;
        unhex(&entry.get_password().ok()?)
    }

    fn save_identity(&self, secrets: Vec<u8>) -> bool {
        keyring::Entry::new(SERVICE, IDENTITY_KEY)
            .and_then(|entry| entry.set_password(&hex(&secrets)))
            .is_ok()
    }

    fn delete_identity(&self) {
        if let Ok(entry) = keyring::Entry::new(SERVICE, IDENTITY_KEY) {
            let _ = entry.delete_credential();
        }
    }
}

/// Everything the engine wants the outside world to do goes to the page as an event.
struct PageTransport(AppHandle);

impl TransportCallbacks for PageTransport {
    fn send(&self, peer: String, frame: String) -> bool {
        self.0
            .emit("privcord://frame", json!({ "peer": peer, "frame": frame }))
            .is_ok()
    }

    // Bluetooth mesh neighbours are not hosted on the desktop (Windows can only scan).
    fn send_raw(&self, _link: String, _frame: String) -> bool {
        false
    }

    fn close(&self, peer: String) {
        let _ = self.0.emit("privcord://close", json!({ "peer": peer }));
    }

    fn signal_available(&self) -> bool {
        true
    }

    fn signal_subscribe(&self, mailbox: String) -> bool {
        self.0
            .emit("privcord://signal-subscribe", json!({ "mailbox": mailbox }))
            .is_ok()
    }

    fn signal_unsubscribe(&self, mailbox: String) {
        let _ = self
            .0
            .emit("privcord://signal-unsubscribe", json!({ "mailbox": mailbox }));
    }

    fn signal_put(&self, mailbox: String, blob: String, kind: SignalKind, ttl_sec: u32) -> bool {
        let kind = match kind {
            SignalKind::Live => "live",
            SignalKind::Stored => "stored",
        };
        self.0
            .emit(
                "privcord://signal-put",
                json!({ "mailbox": mailbox, "blob": blob, "kind": kind, "ttlSec": ttl_sec }),
            )
            .is_ok()
    }
}

struct PageNotifier(AppHandle);

impl NotifierCallbacks for PageNotifier {
    fn message_received(&self, conversation: String, sender: String, preview: String) {
        let _ = self.0.emit(
            "privcord://notify",
            json!({ "conversation": conversation, "sender": sender, "preview": preview }),
        );
    }
}

struct Running {
    host: Arc<DesktopHost>,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct EngineState(Mutex<Option<Running>>);

fn running(state: &State<'_, EngineState>) -> Result<Arc<DesktopHost>, String> {
    state
        .0
        .lock()
        .map_err(|_| "engine state is poisoned".to_owned())?
        .as_ref()
        .map(|r| r.host.clone())
        .ok_or_else(|| "the engine is not started".to_owned())
}

/// Start the engine (once; calling it again is harmless). Its database is `engine.db` in the app's data folder.
#[tauri::command]
pub async fn engine_start(app: AppHandle, state: State<'_, EngineState>) -> Result<(), String> {
    if state
        .0
        .lock()
        .map_err(|_| "engine state is poisoned".to_owned())?
        .is_some()
    {
        return Ok(());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // The old TypeScript engine's database (removed with that engine): its chats are not carried over, so do not leave
    // them on disk.
    for old in ["duochat.db", "duochat.db-wal", "duochat.db-shm"] {
        let _ = std::fs::remove_file(dir.join(old));
    }
    let db = dir.join("engine.db");
    let (a, b) = (app.clone(), app.clone());
    let host = tauri::async_runtime::spawn_blocking(move || {
        DesktopHost::start(
            &db.to_string_lossy(),
            "duo",
            Arc::new(KeyringSecure),
            Arc::new(PageTransport(a)),
            Arc::new(PageNotifier(b)),
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    let host = Arc::new(host);
    let stop = Arc::new(AtomicBool::new(false));
    // Engine events are forwarded to the page until the engine is stopped.
    let (pump_host, pump_stop, pump_app) = (host.clone(), stop.clone(), app);
    std::thread::spawn(move || {
        while !pump_stop.load(Ordering::Relaxed) {
            if let Some(event) = pump_host.next_event(500) {
                let _ = pump_app.emit("privcord://event", event);
            }
        }
    });
    *state
        .0
        .lock()
        .map_err(|_| "engine state is poisoned".to_owned())? = Some(Running { host, stop });
    Ok(())
}

/// Run one engine command with JSON arguments (see `privcord-desktop-host`). The call can wait on the engine, so it runs
/// off the UI thread.
#[tauri::command]
pub async fn engine_invoke(
    state: State<'_, EngineState>,
    command: String,
    args: Value,
) -> Result<Value, String> {
    let host = running(&state)?;
    tauri::async_runtime::spawn_blocking(move || host.invoke(&command, &args))
        .await
        .map_err(|e| e.to_string())?
}

/// Stop the engine. The page can start it again.
#[tauri::command]
pub async fn engine_stop(state: State<'_, EngineState>) -> Result<(), String> {
    let taken = state
        .0
        .lock()
        .map_err(|_| "engine state is poisoned".to_owned())?
        .take();
    if let Some(running) = taken {
        running.stop.store(true, Ordering::Relaxed);
        tauri::async_runtime::spawn_blocking(move || running.host.shutdown())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Carry the existing desktop identity over to the engine, once. `secrets_hex` is the signing scalar then the agreement
/// scalar (32 bytes each) of the identity the page already holds, so nobody has to re-enter their recovery phrase. Does
/// nothing (and says `false`) if the engine already has an identity, or if the engine is running.
#[tauri::command]
pub async fn engine_seed_identity(
    state: State<'_, EngineState>,
    secrets_hex: String,
) -> Result<bool, String> {
    if state
        .0
        .lock()
        .map_err(|_| "engine state is poisoned".to_owned())?
        .is_some()
    {
        return Ok(false);
    }
    let bytes = unhex(&secrets_hex).ok_or_else(|| "the identity is not valid hex".to_owned())?;
    if bytes.len() != 64 {
        return Err("the identity must be 64 bytes".to_owned());
    }
    let secure = KeyringSecure;
    if secure.load_identity().is_some() {
        return Ok(false);
    }
    if secure.save_identity(bytes) {
        Ok(true)
    } else {
        Err("could not save the identity to the system credential store".to_owned())
    }
}
