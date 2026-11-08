//! Tauri wrapper for the Dusk wallet web UI.
//!
//! The UI is built from the repo root into `dist-tauri/`.

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_store::Builder::default().build())
    .plugin(tauri_plugin_fs::init())
    .setup(|app| {
      // Stronghold needs a salt file used for Argon2 hashing.
      // We store it in the app's local data directory.
      let salt_path = app
        .path()
        .app_local_data_dir()
        .expect("failed to resolve app_local_data_dir")
        .join("dusk-wallet-stronghold-salt.txt");

      app
        .handle()
        .plugin(tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build())?;

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
