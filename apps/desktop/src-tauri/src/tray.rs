//! Running in the tray (Windows, macOS, Linux): closing the window hides it and the engine keeps running, a tray icon
//! opens it again or quits, the app can start at login (hidden, in the tray), and a second launch only brings the
//! first window forward.
//!
//! Closing the window really closes it (the web page and its memory go); the engine, its relay sockets and
//! notifications are Rust and keep running. The tray icon builds the window again.

use std::path::PathBuf;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_autostart::ManagerExt;

/// Passed by the login item, so the app starts in the tray instead of opening a window.
pub const HIDDEN_ARG: &str = crate::HIDDEN_ARG;

fn flag<R: Runtime>(app: &AppHandle<R>, name: &str) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(name))
}

fn set_flag<R: Runtime>(app: &AppHandle<R>, name: &str, on: bool) -> Result<(), String> {
    let path = flag(app, name).ok_or("no app data folder")?;
    if on {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, b"1").map_err(|e| e.to_string())
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

fn has_flag<R: Runtime>(app: &AppHandle<R>, name: &str) -> bool {
    flag(app, name).is_some_and(|p| p.exists())
}

/// Closing the window keeps DuoCord running in the tray unless the person turned that off.
pub fn close_to_tray<R: Runtime>(app: &AppHandle<R>) -> bool {
    !has_flag(app, "close-quits")
}

pub fn show_main(app: &AppHandle) {
    if app.get_webview_window("main").is_none() {
        let _ = crate::open_window(app, false);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Builds the tray icon. (Closing the window keeps the app running: see the exit handler in `lib.rs`.)
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open DuoCord", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit DuoCord", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("DuoCord")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSettings {
    close_to_tray: bool,
    start_at_login: bool,
}

#[tauri::command]
pub fn background_settings(app: AppHandle) -> BackgroundSettings {
    BackgroundSettings {
        close_to_tray: close_to_tray(&app),
        start_at_login: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

#[tauri::command]
pub fn set_close_to_tray(app: AppHandle, on: bool) -> Result<(), String> {
    set_flag(&app, "close-quits", !on)
}

#[tauri::command]
pub fn set_start_at_login(app: AppHandle, on: bool) -> Result<(), String> {
    let launch = app.autolaunch();
    if on {
        launch.enable()
    } else {
        launch.disable()
    }
    .map_err(|e| e.to_string())
}
