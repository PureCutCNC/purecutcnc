use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
struct ExitCoordinator {
  exit_confirmed: AtomicBool,
  exit_request_pending: AtomicBool,
}

/// Handles to the two "Update Channel" check items so their checked state can be
/// driven as a radio group. The channel preference itself is persisted by the
/// frontend (localStorage); Rust only mirrors it onto the native menu.
struct ChannelMenuItems {
  stable: tauri::menu::CheckMenuItem<tauri::Wry>,
  snapshot: tauri::menu::CheckMenuItem<tauri::Wry>,
}

impl ChannelMenuItems {
  fn apply(&self, channel: &str) {
    let _ = self.stable.set_checked(channel == "stable");
    let _ = self.snapshot.set_checked(channel == "snapshot");
  }
}

/// Mirror the frontend's persisted update channel onto the native menu.
/// Called once on startup so the checkmark reflects a previously saved choice.
#[tauri::command]
fn set_update_channel(channel: String, items: tauri::State<ChannelMenuItems>) {
  items.apply(&channel);
}

#[tauri::command]
fn request_app_exit(app: tauri::AppHandle, exit_coordinator: tauri::State<ExitCoordinator>) {
  exit_coordinator.exit_request_pending.store(false, Ordering::SeqCst);
  exit_coordinator.exit_confirmed.store(true, Ordering::SeqCst);
  app.exit(0);
}

#[tauri::command]
fn cancel_app_exit_request(exit_coordinator: tauri::State<ExitCoordinator>) {
  exit_coordinator.exit_request_pending.store(false, Ordering::SeqCst);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .manage(ExitCoordinator::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // -----------------------------------------------------------------------
      // Native menu
      // -----------------------------------------------------------------------
      use tauri::Manager;
      use tauri::menu::{CheckMenuItem, Menu, MenuItem, Submenu, PredefinedMenuItem};

      let new_i        = MenuItem::with_id(app, "new",         "New",              true, Some("CmdOrCtrl+N"))?;
      let open_i       = MenuItem::with_id(app, "open",        "Open\u{2026}",     true, Some("CmdOrCtrl+O"))?;
      let save_i       = MenuItem::with_id(app, "save",        "Save",             true, Some("CmdOrCtrl+S"))?;
      let save_as_i    = MenuItem::with_id(app, "save_as",     "Save As\u{2026}",  true, Some("CmdOrCtrl+Shift+S"))?;
      let export_i     = MenuItem::with_id(app, "export_gcode","Export G-code\u{2026}", true, Some("CmdOrCtrl+E"))?;
      let print_i      = MenuItem::with_id(app, "print_design","Print Design\u{2026}", true, Some("CmdOrCtrl+P"))?;
      let undo_i       = MenuItem::with_id(app, "undo",        "Undo",             true, Some("CmdOrCtrl+Z"))?;
      let redo_i       = MenuItem::with_id(app, "redo",        "Redo",             true, Some("CmdOrCtrl+Shift+Z"))?;
      let copy_i       = MenuItem::with_id(app, "copy",        "Copy",             true, Some("CmdOrCtrl+C"))?;
      let cut_i        = MenuItem::with_id(app, "cut",         "Cut",              true, Some("CmdOrCtrl+X"))?;
      let paste_i      = MenuItem::with_id(app, "paste",       "Paste",            true, Some("CmdOrCtrl+V"))?;
      let quit_i       = MenuItem::with_id(app, "quit",        "Quit PureCutCNC",  true, Some("CmdOrCtrl+Q"))?;

      // App menu "About" opens the in-app dialog via a "menu" event (not the OS
      // about panel) so it can show the same rich content as the web build:
      // description, links, license, and a support section.
      let about_i = MenuItem::with_id(app, "about", "About PureCutCNC", true, None::<&str>)?;

      // Update items. "Check for Updates…" is a separate, user-initiated action
      // handled by the frontend.
      // The channel check state defaults to "snapshot" (the only published
      // desktop channel today); the frontend re-syncs both checkmarks on mount
      // from the persisted preference.
      let check_updates_i = MenuItem::with_id(app, "check_updates", "Check for Updates\u{2026}", true, None::<&str>)?;
      let channel_stable_i   = CheckMenuItem::with_id(app, "channel_stable",   "Stable",   true, false, None::<&str>)?;
      let channel_snapshot_i = CheckMenuItem::with_id(app, "channel_snapshot", "Snapshot", true, true,  None::<&str>)?;
      let channel_menu = Submenu::with_id_and_items(app, "update_channel", "Update Channel", true, &[
        &channel_stable_i,
        &channel_snapshot_i,
      ])?;

      app.manage(ChannelMenuItems {
        stable: channel_stable_i.clone(),
        snapshot: channel_snapshot_i.clone(),
      });

      // macOS app menu — must be the FIRST submenu; macOS replaces its label
      // with the running app name automatically.
      let app_menu = Submenu::with_id_and_items(app, "app", "PureCutCNC", true, &[
        &about_i,
        &check_updates_i,
        &channel_menu,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::services(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, None)?,
        &PredefinedMenuItem::hide_others(app, None)?,
        &PredefinedMenuItem::show_all(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &quit_i,
      ])?;

      let file_menu = Submenu::with_id_and_items(app, "file", "File", true, &[
        &new_i,
        &open_i,
        &PredefinedMenuItem::separator(app)?,
        &save_i,
        &save_as_i,
        &PredefinedMenuItem::separator(app)?,
        &export_i,
        &PredefinedMenuItem::separator(app)?,
        &print_i,
      ])?;

      let edit_menu = Submenu::with_id_and_items(app, "edit", "Edit", true, &[
        &undo_i,
        &redo_i,
        &PredefinedMenuItem::separator(app)?,
        &copy_i,
        &cut_i,
        &paste_i,
        // Custom item — no accelerator so Cmd+A is handled by the webview
        // (which checks whether a text field is focused before selecting features)
        &MenuItem::with_id(app, "select_all", "Select All", true, None::<&str>)?,
      ])?;

      let menu = Menu::with_id_and_items(app, "main_menu", &[&app_menu, &file_menu, &edit_menu])?;
      app.set_menu(menu)?;

      Ok(())
    })
    .on_menu_event(|app, event| {
      // Forward menu item ID to the frontend as a "menu" event.
      use tauri::{Emitter, Manager};
      let id = event.id().0.as_str();

      // Update Channel acts as a radio group; mirror the choice onto the native
      // menu immediately. The frontend persists it (and uses it for the check).
      if id == "channel_stable" || id == "channel_snapshot" {
        app.state::<ChannelMenuItems>().apply(id.trim_start_matches("channel_"));
      }

      if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("menu", id.to_string());
      }
    })
    .invoke_handler(tauri::generate_handler![request_app_exit, cancel_app_exit_request, set_update_channel])
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_opener::init())
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| {
    if let tauri::RunEvent::ExitRequested { api, .. } = event {
      use tauri::{Emitter, Manager};

      let exit_coordinator = app_handle.state::<ExitCoordinator>();
      if exit_coordinator.exit_confirmed.swap(false, Ordering::SeqCst) {
        exit_coordinator.exit_request_pending.store(false, Ordering::SeqCst);
        return;
      }

      let Some(window) = app_handle.get_webview_window("main") else {
        exit_coordinator.exit_request_pending.store(false, Ordering::SeqCst);
        return;
      };

      api.prevent_exit();

      if exit_coordinator.exit_request_pending.swap(true, Ordering::SeqCst) {
        return;
      }

      let _ = window.emit("app-exit-requested", ());
    }
  });
}
