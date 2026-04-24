use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
struct ExitCoordinator {
  exit_confirmed: AtomicBool,
  exit_request_pending: AtomicBool,
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
      use tauri::menu::{Menu, MenuItem, Submenu, PredefinedMenuItem};

      let new_i        = MenuItem::with_id(app, "new",         "New",              true, Some("CmdOrCtrl+N"))?;
      let open_i       = MenuItem::with_id(app, "open",        "Open\u{2026}",     true, Some("CmdOrCtrl+O"))?;
      let save_i       = MenuItem::with_id(app, "save",        "Save",             true, Some("CmdOrCtrl+S"))?;
      let save_as_i    = MenuItem::with_id(app, "save_as",     "Save As\u{2026}",  true, Some("CmdOrCtrl+Shift+S"))?;
      let export_i     = MenuItem::with_id(app, "export_gcode","Export G-code\u{2026}", true, Some("CmdOrCtrl+E"))?;
      let undo_i       = MenuItem::with_id(app, "undo",        "Undo",             true, Some("CmdOrCtrl+Z"))?;
      let redo_i       = MenuItem::with_id(app, "redo",        "Redo",             true, Some("CmdOrCtrl+Shift+Z"))?;
      let quit_i       = MenuItem::with_id(app, "quit",        "Quit PureCutCNC",  true, Some("CmdOrCtrl+Q"))?;

      // macOS app menu — must be the FIRST submenu; macOS replaces its label
      // with the running app name automatically.
      let app_menu = Submenu::with_id_and_items(app, "app", "PureCutCNC", true, &[
        &PredefinedMenuItem::about(app, None, None)?,
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
      ])?;

      let edit_menu = Submenu::with_id_and_items(app, "edit", "Edit", true, &[
        &undo_i,
        &redo_i,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::copy(app, None)?,
        &PredefinedMenuItem::cut(app, None)?,
        &PredefinedMenuItem::paste(app, None)?,
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
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("menu", event.id().0.as_str().to_string());
      }
    })
    .invoke_handler(tauri::generate_handler![request_app_exit, cancel_app_exit_request])
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
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
