use std::{env, fs, path::PathBuf};

// What the wallet asks of Android beyond Tauri's own manifest: to hear the
// network come and go. Without it the WebView never tells the page it went
// offline, so the wallet can't say so. A normal permission: Android asks nothing.
const NETWORK_STATE: &str = r#"<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />"#;

// The Android project `cargo tauri android init` makes, which isn't kept in
// git: its manifest gets the permission as the app is built.
fn ask_for_network_state() {
  println!("cargo:rerun-if-env-changed=TAURI_ANDROID_PROJECT_PATH");
  let Some(project) = env::var_os("TAURI_ANDROID_PROJECT_PATH").map(PathBuf::from) else {
    return;
  };
  let path = project.join("app/src/main/AndroidManifest.xml");
  println!("cargo:rerun-if-changed={}", path.display());
  let Ok(manifest) = fs::read_to_string(&path) else {
    return;
  };
  if manifest.contains("android.permission.ACCESS_NETWORK_STATE") {
    return;
  }
  // Right after the manifest's opening tag, beside its other permissions.
  let Some(open) = manifest.find("<manifest") else {
    return;
  };
  let Some(end) = manifest[open..].find('>').map(|at| open + at + 1) else {
    return;
  };
  let rewritten = format!("{}\n    {NETWORK_STATE}{}", &manifest[..end], &manifest[end..]);
  fs::write(&path, rewritten).expect("failed to add ACCESS_NETWORK_STATE to AndroidManifest.xml");
}

fn main() {
  ask_for_network_state();
  tauri_build::build()
}
