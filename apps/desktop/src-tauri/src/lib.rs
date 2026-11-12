#[cfg(desktop)]
mod ble;
#[cfg(desktop)]
mod engine_host;

const SERVICE: &str = "com.duochat.desktop";

/// The engine's own entries (its identity and database key) are kept by the shell; the page never reads or writes
/// them (it may only delete the identity, when the person erases it), so script in the page cannot take or replace
/// the database key.
fn page_entry(key: &str, deleting: bool) -> Result<keyring::Entry, String> {
    if key.starts_with("engine-") && !(deleting && key == "engine-identity-v1") {
        return Err("not available to the page".into());
    }
    keyring::Entry::new(SERVICE, key).map_err(|error| error.to_string())
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    let entry = page_entry(&key, false)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    let entry = page_entry(&key, false)?;
    entry
        .set_password(&value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    let entry = page_entry(&key, true)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}


/// Bluetooth LE bridge (central role only). UNTESTED on hardware; see docs/BLE_TRANSPORT.md.
#[cfg(desktop)]
mod ble_commands {
    use crate::ble::{scan_and_connect, BleEvent, BleLink, Sink};
    use std::sync::Arc;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, State};
    use tokio::sync::Mutex;

    #[derive(Default)]
    pub struct BleState(Mutex<Option<BleLink>>);

    fn unhex(s: &str) -> Result<Vec<u8>, String> {
        if s.len() % 2 != 0 || !s.is_ascii() {
            return Err("not hex".into());
        }
        (0..s.len())
            .step_by(2)
            .map(|i| {
                s.get(i..i + 2)
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
                    .ok_or_else(|| "not hex".to_string())
            })
            .collect()
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[tauri::command]
    pub fn ble_capabilities() -> serde_json::Value {
        serde_json::json!({
            "central": true,
            // btleplug has no GATT-server/advertising API: the desktop can only connect to a phone.
            "peripheral": false,
            "platform": std::env::consts::OS,
        })
    }

    /// Scan for any of `accept_tags_hex` (8-byte tags), connect, and stream events on `duochat://ble`.
    #[tauri::command]
    pub async fn ble_connect(
        app: AppHandle,
        state: State<'_, BleState>,
        accept_tags_hex: Vec<String>,
        timeout_secs: u64,
    ) -> Result<usize, String> {
        let tags = accept_tags_hex.iter().map(|t| unhex(t)).collect::<Result<Vec<_>, _>>()?;
        let sink: Sink = Arc::new(move |event| {
            let payload = match event {
                BleEvent::Open { max_chunk } => serde_json::json!({ "kind": "open", "maxChunk": max_chunk }),
                BleEvent::Chunk(data) => serde_json::json!({ "kind": "chunk", "data": hex(&data) }),
                BleEvent::Close => serde_json::json!({ "kind": "close" }),
                BleEvent::Error(message) => serde_json::json!({ "kind": "error", "message": message }),
            };
            let _ = app.emit("duochat://ble", payload);
        });
        let mut slot = state.0.lock().await;
        if let Some(old) = slot.take() {
            old.disconnect().await;
        }
        let link = scan_and_connect(tags, Duration::from_secs(timeout_secs.clamp(5, 120)), sink).await?;
        let max_chunk = link.max_chunk();
        *slot = Some(link);
        Ok(max_chunk)
    }

    #[tauri::command]
    pub async fn ble_write(state: State<'_, BleState>, chunk_hex: String) -> Result<(), String> {
        let slot = state.0.lock().await;
        let link = slot.as_ref().ok_or("Bluetooth link is not open")?;
        link.write(&unhex(&chunk_hex)?).await
    }

    #[tauri::command]
    pub async fn ble_disconnect(state: State<'_, BleState>) -> Result<(), String> {
        if let Some(link) = state.0.lock().await.take() {
            link.disconnect().await;
        }
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init());
    #[cfg(desktop)]
    let builder = builder
        .manage(ble_commands::BleState::default())
        .manage(engine_host::EngineState::default());
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        secret_get,
        secret_set,
        secret_delete,
        ble_commands::ble_capabilities,
        ble_commands::ble_connect,
        ble_commands::ble_write,
        ble_commands::ble_disconnect,
        engine_host::engine_start,
        engine_host::engine_invoke,
        engine_host::engine_stop,
        engine_host::engine_seed_identity,
        engine_host::engine_erase,
        engine_host::engine_signal_status
    ]);
    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        secret_get,
        secret_set,
        secret_delete
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running DuoChat");
}
