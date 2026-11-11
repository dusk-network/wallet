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

/// Saves a file (Activity's export, a QR code) in the phone's Downloads, as
/// `name` or the name Android gave it instead (" (1)" for one taken), which it
/// returns. None where it can't.
#[tauri::command]
async fn save_download(window: tauri::WebviewWindow, name: String, mime: String, bytes: Vec<u8>) -> Result<Option<String>, String> {
  #[cfg(target_os = "android")]
  return android::save_download(&window, name, mime, bytes).await;
  #[cfg(not(target_os = "android"))]
  {
    let _ = (window, name, mime, bytes);
    Ok(None)
  }
}

/// Fingerprint unlock, on Android: `action` status, enable (with the password
/// as `secret`), unlock (the password back) or disable, each after a
/// fingerprint where it takes one. `{ ok: false, reason: "unavailable" }` elsewhere.
#[tauri::command]
async fn fingerprint(app: tauri::AppHandle, action: String, args: serde_json::Value) -> Result<serde_json::Value, String> {
  #[cfg(target_os = "android")]
  return android::fingerprint(&app, &action, args).await;
  #[cfg(not(target_os = "android"))]
  {
    let _ = (app, action, args);
    Ok(serde_json::json!({ "ok": false, "reason": "unavailable" }))
  }
}

/// Arrival notices, on Android: `action` status, ask (Android's question for
/// leave to show them, asked only when the person taps Tell me when it arrives),
/// notify (`args` title, body and the transaction's hash), watch (a send to
/// look for once the app leaves the screen), settled or opened (the
/// transaction a notice's tap opened the app on). `{ allowed: false }` elsewhere.
#[tauri::command]
async fn notices(app: tauri::AppHandle, action: String, args: serde_json::Value) -> Result<serde_json::Value, String> {
  #[cfg(target_os = "android")]
  return android::notice(&app, &action, args).await;
  #[cfg(not(target_os = "android"))]
  {
    let _ = (app, action, args);
    Ok(serde_json::json!({ "allowed": false }))
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
  let builder = tauri::Builder::default();
  // Fingerprint unlock's Kotlin (android/KeystorePlugin.kt).
  #[cfg(target_os = "android")]
  let builder = builder.plugin(android::keystore()).plugin(android::notices());
  builder
    .plugin(tauri_plugin_store::Builder::default().build())
    .plugin(tauri_plugin_fs::init())
    // Links open in the phone's browser, never in the wallet's window.
    .plugin(tauri_plugin_opener::init())
    // dusk: payment links open the app's Send (popup/app.js).
    .plugin(tauri_plugin_deep_link::init())
    .invoke_handler(tauri::generate_handler![share_text, save_download, move_to_back, fingerprint, notices])
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
