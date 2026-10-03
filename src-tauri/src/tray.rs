// Notification-area icon: Open, Settings, Pause, Quiet on hover, Quit.

use std::sync::OnceLock;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::island::WINDOW_LABEL;

/// The Pause item, kept so it can be relabelled. `TrayIcon` exposes no way to
/// read a menu back, and a label stuck on "Pause" after you clicked it is the one
/// place the user would look to find out whether the app is still calling out.
static PAUSE_ITEM: OnceLock<MenuItem<Wry>> = OnceLock::new();

/// The quiet-hover item, kept so its tick can follow the hotkey. Same reasoning as
/// `PAUSE_ITEM`: nobody remembers a chord, so the menu is where the state has to
/// be visible.
static QUIET_ITEM: OnceLock<CheckMenuItem<Wry>> = OnceLock::new();

/// "Pause" / "Resume", so the label describes what the next click does.
pub fn set_pause_label(label: &str) {
    if let Some(item) = PAUSE_ITEM.get() {
        let _ = item.set_text(label);
    }
}

pub fn set_quiet_checked(checked: bool) {
    if let Some(item) = QUIET_ITEM.get() {
        let _ = item.set_checked(checked);
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Coucou", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
    let _ = PAUSE_ITEM.set(pause.clone());
    // A check item, not a plain one: the state has to be readable at a glance
    // from the menu, and it starts ticked to match the stored preference so a
    // fresh launch never disagrees with what the island is doing.
    let quiet = CheckMenuItem::with_id(
        app,
        "quiet",
        "Quiet on hover  (Ctrl+Alt+Q)",
        true,
        app.state::<crate::Shared>().settings.lock().unwrap().quiet_hover,
        None::<&str>,
    )?;
    let _ = QUIET_ITEM.set(quiet.clone());
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu =
        Menu::with_items(app, &[&open, &sep1, &settings, &pause, &quiet, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id("coucou")
        .tooltip("Coucou")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            "quiet" => {
                // The same path the hotkey takes, so the tick cannot drift from the
                // real state whichever one was used.
                crate::hotkey::toggle_quiet(app);
            }
            "pause" => {
                // Pause here, not just in the island. Toggling only the webview
                // left the pollers talking to Stripe/GitHub/Vercel whenever the
                // island had not finished booting.
                let next = !crate::integrations::is_paused();
                crate::integrations::set_paused(next);
                set_pause_label(if next { "Resume" } else { "Pause" });
                let _ = app.emit_to(WINDOW_LABEL, "tray", "pause".to_string());
            }
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}
