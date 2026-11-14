//! The Rust engine, hosted in the shell (milestone M7). Nothing in the app calls this yet: it is the seam the page will use
//! when `engine.ts` is rewired onto the engine (docs/rust/M7_DESKTOP_PLAN.md).
//!
//! The page owns WebRTC. The relay sockets are the shell's own (`privcord_desktop_host::native_signaling`), so messages,
//! sync and notifications go on with the window closed and DuoCord in the tray.
//!
//! (Earlier the page owned the relay sockets too.) It tells the engine what happened (`engine_invoke("link_up", ..)`,
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

use privcord_desktop_host::{native_signaling::NativeSignaling, DesktopHost};
use privcord_domain::signaling::PutKind;
use privcord_ffi::{
    DatabaseKeyRead, NotifierCallbacks, SecureStoreCallbacks, SignalKind, TransportCallbacks,
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

const SERVICE: &str = "com.duochat.desktop";
const IDENTITY_KEY: &str = "engine-identity-v1";
/// The database encryption key (SQLCipher), separate from the identity.
const DATABASE_KEY: &str = "engine-database-key-v1";

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

    /// The database key, in its own Credential Manager entry (deleting the identity does not touch it).
    /// Only "no entry" (or an entry that can never decode) is Missing; any other keyring error (locked, no access,
    /// platform failure) is Unavailable, so a locked store never leads to a new key.
    fn load_database_key(&self) -> DatabaseKeyRead {
        let Ok(entry) = keyring::Entry::new(SERVICE, DATABASE_KEY) else {
            return DatabaseKeyRead::Unavailable;
        };
        match entry.get_password() {
            Ok(text) => unhex(&text).map_or(DatabaseKeyRead::Missing, |key| {
                DatabaseKeyRead::Found { key }
            }),
            Err(keyring::Error::NoEntry | keyring::Error::BadEncoding(_)) => {
                DatabaseKeyRead::Missing
            }
            Err(_) => DatabaseKeyRead::Unavailable,
        }
    }

    fn save_database_key(&self, key: Vec<u8>) -> bool {
        keyring::Entry::new(SERVICE, DATABASE_KEY)
            .and_then(|entry| entry.set_password(&hex(&key)))
            .is_ok()
    }
}

/// The relay sockets, started with the engine.
static NATIVE: std::sync::OnceLock<NativeSignaling> = std::sync::OnceLock::new();
/// Peers the page has an open link with (it reports `link_up` / `link_down`): when the window goes, they are all down.
static LINKED: Mutex<std::collections::BTreeSet<String>> =
    Mutex::new(std::collections::BTreeSet::new());

fn host_of(app: &AppHandle) -> Option<Arc<DesktopHost>> {
    let state = app.state::<EngineState>();
    let guard = state.0.lock().ok()?;
    guard.as_ref().map(|r| r.host.clone())
}

fn native(app: &AppHandle) -> &'static NativeSignaling {
    NATIVE.get_or_init(|| {
        let (blobs, status) = (app.clone(), app.clone());
        NativeSignaling::start(
            Arc::new(move |mailbox, blob| {
                if let Some(host) = host_of(&blobs) {
                    let _ =
                        host.invoke("signal_blob", &json!({ "mailbox": mailbox, "blob": blob }));
                }
            }),
            Arc::new(move |online| {
                SIGNAL_ONLINE.store(online, Ordering::Relaxed);
                let _ = status.emit("privcord://signal-status", json!({ "online": online }));
            }),
        )
    })
}

/// Network settings and notification choices, saved so a start in the tray (no page yet) has them.
fn saved_network_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("network.json"))
}

fn apply_network(app: &AppHandle, saved: &Value) {
    let network = saved.get("network").and_then(Value::as_str).unwrap_or("{}");
    let socks = crate::tor_active().then(|| crate::TOR_PROXY.to_owned());
    native(app).configure(network, socks);
}

/// The page hands over its network settings (the same JSON it keeps) and notification choices.
#[tauri::command]
pub fn engine_network(
    app: AppHandle,
    network: String,
    notify: bool,
    previews: bool,
) -> Result<(), String> {
    let saved = json!({ "network": network, "notify": notify, "previews": previews });
    if let Some(path) = saved_network_path(&app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&path, saved.to_string()).map_err(|e| e.to_string())?;
    }
    apply_network(&app, &saved);
    // Started at sign-in: the page was only needed to start the engine. Now that the relays are set up, its window
    // goes, and DuoCord sits in the tray with only Rust running.
    if std::env::args().any(|a| a == crate::HIDDEN_ARG)
        && !HIDDEN_START_DONE.swap(true, Ordering::Relaxed)
    {
        if let Some(w) = app
            .get_webview_window("main")
            .filter(|w| !w.is_visible().unwrap_or(true))
        {
            let _ = w.destroy();
        }
    }
    Ok(())
}

static HIDDEN_START_DONE: AtomicBool = AtomicBool::new(false);

fn saved_network(app: &AppHandle) -> Option<Value> {
    let text = std::fs::read_to_string(saved_network_path(app)?).ok()?;
    serde_json::from_str(&text).ok()
}

/// The window is gone (DuoCord stays in the tray): its WebRTC links went with it.
pub fn page_closed(app: &AppHandle) {
    let peers: Vec<String> = LINKED
        .lock()
        .map(|mut l| std::mem::take(&mut *l).into_iter().collect())
        .unwrap_or_default();
    if let Some(host) = host_of(app) {
        for peer in peers {
            let _ = host.invoke("link_down", &json!({ "peer": peer }));
        }
    }
}

fn has_page(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some()
}

/// Everything the engine wants the outside world to do: links go to the page, relay traffic to the shell's sockets.
struct PageTransport(AppHandle);

impl TransportCallbacks for PageTransport {
    fn send(&self, peer: String, frame: String) -> bool {
        // No window, no links: say so, so nothing counts as sent over a link that is gone.
        has_page(&self.0)
            && self
                .0
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

    /// Whether the relay sockets are online. When they are down the engine hands connection setup and receipts to
    /// mutual contacts instead of a relay put that can only wait and fail.
    fn signal_available(&self) -> bool {
        native(&self.0).online()
    }

    fn signal_subscribe(&self, mailbox: String) -> bool {
        native(&self.0).subscribe(&mailbox)
    }

    fn signal_unsubscribe(&self, mailbox: String) {
        native(&self.0).unsubscribe(&mailbox);
    }

    fn signal_put(&self, mailbox: String, blob: String, kind: SignalKind, ttl_sec: u32) -> bool {
        let kind = match kind {
            SignalKind::Live => PutKind::Sig,
            SignalKind::Stored => PutKind::Msg,
        };
        native(&self.0).put(&mailbox, &blob, kind, ttl_sec)
    }
}

struct PageNotifier(AppHandle);

impl NotifierCallbacks for PageNotifier {
    fn message_received(&self, conversation: String, sender: String, preview: String) {
        if has_page(&self.0) {
            // The page knows names and whether that chat is on screen.
            let _ = self.0.emit(
                "privcord://notify",
                json!({ "conversation": conversation, "sender": sender, "preview": preview }),
            );
            return;
        }
        // In the tray: a notification from the shell, with the person's choices.
        let saved = saved_network(&self.0).unwrap_or(Value::Null);
        if saved.get("notify").and_then(Value::as_bool) == Some(false) {
            return;
        }
        let body = if saved.get("previews").and_then(Value::as_bool) == Some(false) {
            "Open DuoCord to read it.".to_owned()
        } else {
            preview
        };
        use tauri_plugin_notification::NotificationExt;
        let _ = self
            .0
            .notification()
            .builder()
            .title("New message")
            .body(body)
            .show();
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
/// Whether the page's relay sockets are online (`engine_signal_status`). False until the page says otherwise.
static SIGNAL_ONLINE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Kept for older pages: the relay sockets are the shell's now, and their status comes from them.
#[tauri::command]
pub fn engine_signal_status(online: bool) {
    let _ = online;
}

/// Whether the relay sockets are online now (a page that opens late asks instead of waiting for a change).
#[tauri::command]
pub fn engine_signal_online(app: AppHandle) -> bool {
    native(&app).online()
}

/// Starts run one at a time: two calls racing (a remount, a reload) must not both open engine.db and both run an engine.
static START: std::sync::OnceLock<tauri::async_runtime::Mutex<()>> = std::sync::OnceLock::new();

#[tauri::command]
pub async fn engine_start(app: AppHandle, state: State<'_, EngineState>) -> Result<(), String> {
    let _one_at_a_time = START
        .get_or_init(|| tauri::async_runtime::Mutex::new(()))
        .lock()
        .await;
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
    let (a, b, app_for_network) = (app.clone(), app.clone(), app.clone());
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
    // Started in the tray with no page yet: the relays from last time.
    if let Some(saved) = saved_network(&app_for_network) {
        apply_network(&app_for_network, &saved);
    }
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
    if let (Some(peer), Ok(mut linked)) = (args.get("peer").and_then(Value::as_str), LINKED.lock())
    {
        match command.as_str() {
            "link_up" => {
                linked.insert(peer.to_owned());
            }
            "link_down" => {
                linked.remove(peer);
            }
            _ => {}
        }
    }
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

/// Delete the engine's database files. Missing files are fine; anything else is an error, so a wipe never claims success it
/// did not have.
/// Every `engine.db*` file goes: the database and its journals, but also the pre-migration copies (`engine.db.bak-v<n>`,
/// encrypted with the database key, which stays in the credential store), set-aside files and an interrupted encryption.
fn erase_engine_files(dir: &std::path::Path) -> Result<(), String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("could not list the data folder: {e}")),
    };
    for entry in entries {
        let name = entry.map_err(|e| e.to_string())?.file_name();
        let Some(name) = name.to_str().filter(|n| n.starts_with("engine.db")) else {
            continue;
        };
        match std::fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("could not delete {name}: {e}")),
        }
    }
    Ok(())
}

/// Emergency wipe of everything the engine keeps, whether or not it is running: stop it, delete its database and its
/// identity in the credential store. (The wipe stops networking, and so the engine, before it erases data.)
#[tauri::command]
pub async fn engine_erase(app: AppHandle, state: State<'_, EngineState>) -> Result<(), String> {
    engine_stop(state).await?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    erase_engine_files(&dir)?;
    KeyringSecure.delete_identity();
    if KeyringSecure.load_identity().is_some() {
        return Err("the identity is still in the system credential store".to_owned());
    }
    Ok(())
}

/// Give the engine the identity the page holds. `secrets_hex` is the signing scalar then the agreement scalar (32 bytes
/// each), so nobody has to re-enter their recovery phrase. Says `false` when the engine already has exactly this identity.
/// A *different* identity (the person restored another phrase) replaces the old one, and the old identity's chats, friends
/// and groups are erased with it: they belong to someone else and must not mix with the new identity.
#[tauri::command]
pub async fn engine_seed_identity(
    app: AppHandle,
    state: State<'_, EngineState>,
    secrets_hex: String,
) -> Result<bool, String> {
    let bytes = unhex(&secrets_hex).ok_or_else(|| "the identity is not valid hex".to_owned())?;
    if bytes.len() != 64 {
        return Err("the identity must be 64 bytes".to_owned());
    }
    let secure = KeyringSecure;
    match secure.load_identity() {
        Some(existing) if existing == bytes => return Ok(false),
        Some(_) => {
            engine_stop(state).await?;
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            erase_engine_files(&dir)?;
            secure.delete_identity();
        }
        None => {}
    }
    if secure.save_identity(bytes) {
        Ok(true)
    } else {
        Err("could not save the identity to the system credential store".to_owned())
    }
}
