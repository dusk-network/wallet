//! Tauri wrapper for the Dusk wallet web UI.
//!
//! The UI is built from the repo root into `dist-tauri/`.

use tauri::Manager;

#[cfg(target_os = "android")]
mod android;

/// Opens the phone's share sheet with `text` (Receive's address or request link).
#[tauri::command]
async fn share_text(window: tauri::WebviewWindow, text: String, title: String) -> Result<(), String> {
  #[cfg(target_os = "android")]
  return android::share(&window, text, title).await;
  #[cfg(not(target_os = "android"))]
  {
    let _ = (window, text, title);
    Err("There's no share sheet here.".into())
  }
}

/// Saves a file (Activity's export, a QR code) in the phone's Downloads, under
/// `name`. False where it can't.
#[tauri::command]
async fn save_download(window: tauri::WebviewWindow, name: String, mime: String, bytes: Vec<u8>) -> Result<bool, String> {
  #[cfg(target_os = "android")]
  return android::save_download(&window, name, mime, bytes).await;
  #[cfg(not(target_os = "android"))]
  {
    let _ = (window, name, mime, bytes);
    Ok(false)
  }
}

/// Puts the app in the background as it is (Back on its first screen). False
/// where there's no such thing.
#[tauri::command]
async fn move_to_back(window: tauri::WebviewWindow) -> Result<bool, String> {
  #[cfg(target_os = "android")]
  return android::move_to_back(&window).await;
  #[cfg(not(target_os = "android"))]
  {
    let _ = window;
    Ok(false)
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_store::Builder::default().build())
    .plugin(tauri_plugin_fs::init())
    // Links open in the phone's browser, never in the wallet's window.
    .plugin(tauri_plugin_opener::init())
    // dusk: payment links open the app's Send (popup/app.js).
    .plugin(tauri_plugin_deep_link::init())
    .invoke_handler(tauri::generate_handler![share_text, save_download, move_to_back])
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

      // No screenshot or app-switcher picture of the wallet: its recovery
      // words and password screens included.
      #[cfg(target_os = "android")]
      if let Some(window) = app.get_webview_window("main") {
        android::secure(&window);
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
