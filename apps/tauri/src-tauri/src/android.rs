//! What the wallet asks of Android itself, through the activity the app runs
//! in, on Android's main thread: kept out of screenshots, light icons on its
//! dark bars, the share sheet, a file saved to Downloads, and the app put in
//! the background as it is.

use tauri::tao::platform::android::prelude::jni::{
  errors::Error,
  objects::{JObject, JValue},
  JNIEnv,
};
use tauri::{Runtime, WebviewWindow};

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

fn share_sheet(env: &mut JNIEnv, activity: &JObject, text: &str, title: &str) -> Jni<()> {
  let action = env.new_string("android.intent.action.SEND")?;
  let intent = env.new_object("android/content/Intent", "(Ljava/lang/String;)V", &[JValue::Object(action.as_ref())])?;
  let mime = env.new_string("text/plain")?;
  env.call_method(&intent, "setType", "(Ljava/lang/String;)Landroid/content/Intent;", &[JValue::Object(mime.as_ref())])?;
  let key = env.new_string("android.intent.extra.TEXT")?;
  let value = env.new_string(text)?;
  env.call_method(
    &intent,
    "putExtra",
    "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
    &[JValue::Object(key.as_ref()), JValue::Object(value.as_ref())],
  )?;
  let title = env.new_string(title)?;
  let chooser = env
    .call_static_method(
      "android/content/Intent",
      "createChooser",
      "(Landroid/content/Intent;Ljava/lang/CharSequence;)Landroid/content/Intent;",
      &[JValue::Object(&intent), JValue::Object(title.as_ref())],
    )?
    .l()?;
  env.call_method(activity, "startActivity", "(Landroid/content/Intent;)V", &[JValue::Object(&chooser)])?;
  Ok(())
}

/// Opens Android's share sheet with `text`.
pub async fn share<R: Runtime>(window: &WebviewWindow<R>, text: String, title: String) -> Result<(), String> {
  on_activity(window, move |env, activity| share_sheet(env, activity, &text, &title)).await
}

fn put(env: &mut JNIEnv, values: &JObject, key: &str, value: &str) -> Jni<()> {
  let key = env.new_string(key)?;
  let value = env.new_string(value)?;
  env.call_method(values, "put", "(Ljava/lang/String;Ljava/lang/String;)V", &[JValue::Object(key.as_ref()), JValue::Object(value.as_ref())])?;
  Ok(())
}

// Android 10 and later: MediaStore, which asks for no permission.
fn save_in_downloads(env: &mut JNIEnv, activity: &JObject, name: &str, mime: &str, bytes: &[u8]) -> Jni<bool> {
  if sdk(env)? < 29 {
    return Ok(false);
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
    return Ok(false);
  }
  let out = env
    .call_method(&resolver, "openOutputStream", "(Landroid/net/Uri;)Ljava/io/OutputStream;", &[JValue::Object(&uri)])?
    .l()?;
  let data = env.byte_array_from_slice(bytes)?;
  env.call_method(&out, "write", "([B)V", &[JValue::Object(data.as_ref())])?;
  env.call_method(&out, "close", "()V", &[])?;
  Ok(true)
}

/// Saves `bytes` as `name` in the phone's Downloads. False where Android is
/// older than 10, which has no Downloads an app can add to without asking.
pub async fn save_download<R: Runtime>(window: &WebviewWindow<R>, name: String, mime: String, bytes: Vec<u8>) -> Result<bool, String> {
  on_activity(window, move |env, activity| save_in_downloads(env, activity, &name, &mime, &bytes)).await
}

/// Puts the app in the background as it is, as Home does: Back on its first
/// screen would close it, an unlocked wallet with it.
pub async fn move_to_back<R: Runtime>(window: &WebviewWindow<R>) -> Result<bool, String> {
  on_activity(window, |env, activity| env.call_method(activity, "moveTaskToBack", "(Z)Z", &[JValue::Bool(1)])?.z()).await
}
