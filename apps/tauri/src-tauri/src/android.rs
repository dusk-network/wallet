//! What the wallet asks of Android itself, through the activity the app runs
//! in, on Android's main thread: kept out of screenshots, light icons on its
//! dark bars, the share sheet (android/SharePlugin.kt), a file saved to Downloads under the name
//! Android gave it, the app put in the background as it is, fingerprint
//! unlock (android/KeystorePlugin.kt), and arrival notices
//! (android/NoticesPlugin.kt), looked for in the background too
//! (android/ArrivalJob.kt).

use tauri::tao::platform::android::prelude::jni::{
  errors::Error,
  objects::{JObject, JValue},
  JNIEnv,
};
use serde_json::{json, Value};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

// WindowManager.LayoutParams.FLAG_SECURE: no screenshots, screen recordings or
// app-switcher thumbnail of any screen, recovery words and passwords among them.
const FLAG_SECURE: i32 = 0x2000;
// WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | APPEARANCE_LIGHT_NAVIGATION_BARS,
// which dark icons need: taken off, the icons are light on the wallet's dark page.
const LIGHT_BARS: i32 = 0x8 | 0x10;

type Jni<T> = Result<T, Error>;

/// Runs `f` with the activity on Android's main thread, and gives back what it
/// returned; a Java exception is cleared and said in words.
async fn on_activity<R, T, F>(window: &WebviewWindow<R>, f: F) -> Result<T, String>
where
  R: Runtime,
  T: Send + 'static,
  F: FnOnce(&mut JNIEnv, &JObject) -> Jni<T> + Send + 'static,
{
  let (tx, mut rx) = tauri::async_runtime::channel(1);
  window
    .with_webview(move |webview| {
      webview.jni_handle().exec(move |env, activity, _| {
        let result = f(env, activity).map_err(|error| {
          if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
          }
          error.to_string()
        });
        let _ = tx.blocking_send(result);
      })
    })
    .map_err(|e| e.to_string())?;
  rx.recv().await.ok_or_else(|| "Android didn't answer".to_string())?
}

fn sdk(env: &mut JNIEnv) -> Jni<i32> {
  env.get_static_field("android/os/Build$VERSION", "SDK_INT", "I")?.i()
}

fn secure_window(env: &mut JNIEnv, activity: &JObject) -> Jni<()> {
  let window = env.call_method(activity, "getWindow", "()Landroid/view/Window;", &[])?.l()?;
  env.call_method(&window, "addFlags", "(I)V", &[JValue::Int(FLAG_SECURE)])?;
  if sdk(env)? >= 30 {
    let bars = env
      .call_method(&window, "getInsetsController", "()Landroid/view/WindowInsetsController;", &[])?
      .l()?;
    if !bars.is_null() {
      env.call_method(&bars, "setSystemBarsAppearance", "(II)V", &[JValue::Int(0), JValue::Int(LIGHT_BARS)])?;
    }
  }
  Ok(())
}

/// The app's window, kept out of screenshots and the app switcher, with light
/// icons on its dark status and navigation bars. Set once, as the app starts.
pub fn secure<R: Runtime>(window: &WebviewWindow<R>) {
  let _ = window.with_webview(|webview| {
    webview.jni_handle().exec(|env, activity, _| {
      if secure_window(env, activity).is_err() && env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
      }
    })
  });
}

fn put(env: &mut JNIEnv, values: &JObject, key: &str, value: &str) -> Jni<()> {
  let key = env.new_string(key)?;
  let value = env.new_string(value)?;
  env.call_method(values, "put", "(Ljava/lang/String;Ljava/lang/String;)V", &[JValue::Object(key.as_ref()), JValue::Object(value.as_ref())])?;
  Ok(())
}

// The name a file was given in the store at `uri`: Android adds " (1)" and so
// on to one that would take another's.
fn display_name(env: &mut JNIEnv, resolver: &JObject, uri: &JObject) -> Jni<Option<String>> {
  let column = env.new_string("_display_name")?;
  let columns = env.new_object_array(1, "java/lang/String", JObject::null())?;
  env.set_object_array_element(&columns, 0, &column)?;
  let cursor = env
    .call_method(
      resolver,
      "query",
      "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
      &[JValue::Object(uri), JValue::Object(&columns), JValue::Object(&JObject::null()), JValue::Object(&JObject::null()), JValue::Object(&JObject::null())],
    )?
    .l()?;
  if cursor.is_null() {
    return Ok(None);
  }
  let mut name = None;
  if env.call_method(&cursor, "moveToFirst", "()Z", &[])?.z()? {
    let value = env.call_method(&cursor, "getString", "(I)Ljava/lang/String;", &[JValue::Int(0)])?.l()?;
    if !value.is_null() {
      name = Some(env.get_string(&value.into())?.into());
    }
  }
  env.call_method(&cursor, "close", "()V", &[])?;
  Ok(name)
}

// Android 10 and later: MediaStore, which asks for no permission. The name it
// was saved as, which Android may have changed, or None where it couldn't.
fn save_in_downloads(env: &mut JNIEnv, activity: &JObject, name: &str, mime: &str, bytes: &[u8]) -> Jni<Option<String>> {
  if sdk(env)? < 29 {
    return Ok(None);
  }
  let values = env.new_object("android/content/ContentValues", "()V", &[])?;
  put(env, &values, "_display_name", name)?;
  put(env, &values, "mime_type", mime)?;
  put(env, &values, "relative_path", "Download")?;
  let resolver = env.call_method(activity, "getContentResolver", "()Landroid/content/ContentResolver;", &[])?.l()?;
  let downloads = env
    .get_static_field("android/provider/MediaStore$Downloads", "EXTERNAL_CONTENT_URI", "Landroid/net/Uri;")?
    .l()?;
  let uri = env
    .call_method(
      &resolver,
      "insert",
      "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
      &[JValue::Object(&downloads), JValue::Object(&values)],
    )?
    .l()?;
  if uri.is_null() {
    return Ok(None);
  }
  let out = env
    .call_method(&resolver, "openOutputStream", "(Landroid/net/Uri;)Ljava/io/OutputStream;", &[JValue::Object(&uri)])?
    .l()?;
  let data = env.byte_array_from_slice(bytes)?;
  env.call_method(&out, "write", "([B)V", &[JValue::Object(data.as_ref())])?;
  env.call_method(&out, "close", "()V", &[])?;
  Ok(Some(display_name(env, &resolver, &uri)?.unwrap_or_else(|| name.to_string())))
}

/// Saves `bytes` in the phone's Downloads, as `name` or the name Android gave
/// it instead, which it returns. None where Android is older than 10, which
/// has no Downloads an app can add to without asking.
pub async fn save_download<R: Runtime>(window: &WebviewWindow<R>, name: String, mime: String, bytes: Vec<u8>) -> Result<Option<String>, String> {
  on_activity(window, move |env, activity| save_in_downloads(env, activity, &name, &mime, &bytes)).await
}

/// Puts the app in the background as it is, as Home does: Back on its first
/// screen would close it, an unlocked wallet with it.
pub async fn move_to_back<R: Runtime>(window: &WebviewWindow<R>) -> Result<bool, String> {
  on_activity(window, |env, activity| env.call_method(activity, "moveTaskToBack", "(Z)Z", &[JValue::Bool(1)])?.z()).await
}

/// The wallet's Kotlin for fingerprint unlock, once Android has it.
struct Keystore<R: Runtime>(PluginHandle<R>);

/// Fingerprint unlock's Kotlin (android/KeystorePlugin.kt), as the plugin
/// "dusk-keystore". Where Android can't find it, there's no fingerprint unlock.
pub fn keystore<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("dusk-keystore")
    .setup(|app, api| {
      if let Ok(handle) = api.register_android_plugin("network.dusk.wallet", "KeystorePlugin") {
        app.manage(Keystore(handle));
      }
      Ok(())
    })
    .build()
}

/// Asks fingerprint unlock's Kotlin `action`: status, enable, unlock, disable,
/// or keyboard (for the password field the page focused instead). Each
/// answers `{ ok, reason?, ... }`.
pub async fn fingerprint<R: Runtime>(app: &AppHandle<R>, action: &str, args: Value) -> Result<Value, String> {
  if !matches!(action, "status" | "enable" | "unlock" | "disable" | "keyboard") {
    return Err("There's no such thing to ask.".into());
  }
  let Some(keystore) = app.try_state::<Keystore<R>>() else {
    return Ok(json!({ "ok": false, "reason": "unavailable" }));
  };
  keystore.0.run_mobile_plugin_async::<Value>(action, args).await.map_err(|e| e.to_string())
}

/// The wallet's Kotlin for the share sheet, once Android has it.
struct Share<R: Runtime>(PluginHandle<R>);

/// The share sheet's Kotlin (android/SharePlugin.kt), as the plugin
/// "dusk-share". Where Android can't find it, there's no share sheet.
pub fn share_sheet<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("dusk-share")
    .setup(|app, api| {
      if let Ok(handle) = api.register_android_plugin("network.dusk.wallet", "SharePlugin") {
        app.manage(Share(handle));
      }
      Ok(())
    })
    .build()
}

/// Opens Android's share sheet with `text`, and with `image` (a PNG, base64,
/// shared as `name`) beside it where there's one.
pub async fn share<R: Runtime>(app: &AppHandle<R>, text: String, title: String, image: String, name: String) -> Result<(), String> {
  let Some(share) = app.try_state::<Share<R>>() else {
    return Err("There's no share sheet here.".into());
  };
  let answer = share
    .0
    .run_mobile_plugin_async::<Value>("share", json!({ "text": text, "title": title, "image": image, "name": name }))
    .await
    .map_err(|e| e.to_string())?;
  if answer.get("ok").and_then(Value::as_bool) == Some(true) {
    Ok(())
  } else {
    Err("The share sheet didn't open.".into())
  }
}

/// The wallet's Kotlin for arrival notices, once Android has it.
struct Notices<R: Runtime>(PluginHandle<R>);

/// Arrival notices' Kotlin (android/NoticesPlugin.kt), as the plugin
/// "dusk-notices". Where Android can't find it, there are no notices.
pub fn notices<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("dusk-notices")
    .setup(|app, api| {
      if let Ok(handle) = api.register_android_plugin("network.dusk.wallet", "NoticesPlugin") {
        app.manage(Notices(handle));
      }
      Ok(())
    })
    .build()
}

/// Asks arrival notices' Kotlin `action`: status, ask, notify, watch (a send
/// to look for once the app leaves the screen, android/ArrivalJob.kt),
/// settled (one the page heard of), forget (a wallet's sends, or every
/// wallet's), incoming (the accounts to look at for money coming in) or
/// opened (the transaction a notice's tap opened the app on). Each answers
/// `{ allowed }`, opened its `hash` too.
pub async fn notice<R: Runtime>(app: &AppHandle<R>, action: &str, args: Value) -> Result<Value, String> {
  if !matches!(action, "status" | "ask" | "notify" | "watch" | "settled" | "forget" | "incoming" | "opened") {
    return Err("There's no such thing to ask.".into());
  }
  let Some(notices) = app.try_state::<Notices<R>>() else {
    return Ok(json!({ "allowed": false }));
  };
  notices.0.run_mobile_plugin_async::<Value>(action, args).await.map_err(|e| e.to_string())
}
