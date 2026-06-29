use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, WindowEvent,
};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

/// Default system-wide hotkey for the spotlight quick-add bar.
const QUICK_ADD_SHORTCUT: &str = "CmdOrCtrl+Shift+A";

/// Bring the (hidden, pre-created) `quick` window to the foreground and tell the
/// frontend to focus its input and refresh its autocomplete snapshot.
fn show_quick_add<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("quick") {
        let _ = win.show();
        let _ = win.center();
        let _ = win.set_focus();
        let _ = win.emit("quick:show", ());
    }
}

/// Show + focus the main app window (used by the tray "Open" entry).
fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // Fire once on key-down, not again on release.
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        show_quick_add(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Register the global quick-add hotkey. On a pure Wayland session the
            // compositor may refuse the global grab; X11/macOS/Windows are fine.
            if let Err(e) = app.global_shortcut().register(QUICK_ADD_SHORTCUT) {
                eprintln!("failed to register quick-add shortcut: {e}");
            }

            // System tray: left-click opens the quick-add bar; the menu offers
            // Open / Quick Add / Quit.
            let open_i = MenuItem::with_id(app, "open", "Open Carbon", true, None::<&str>)?;
            let quick_i = MenuItem::with_id(app, "quick", "Quick Add", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &quick_i, &quit_i])?;

            let mut tray_builder = TrayIconBuilder::new()
                .tooltip("Carbon")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quick" => show_quick_add(app),
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
                        show_quick_add(tray.app_handle());
                    }
                });
            // Use the bundled window icon when present; don't unwrap() — a missing icon
            // would otherwise panic and crash launch. The tray still works without one.
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            let _tray = tray_builder.build(app)?;

            // Closing the main window hides it to the tray instead of quitting, so
            // it stays alive to receive forwarded quick-add tasks. Only the tray's
            // Quit (app.exit) actually terminates.
            if let Some(main) = app.get_webview_window("main") {
                let main_handle = main.clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = main_handle.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
