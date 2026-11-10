use std::{
  env, fs,
  path::{Path, PathBuf},
};

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

// Every file under `from`, by its path under it.
fn files_under(from: &Path, at: &Path, out: &mut Vec<PathBuf>) {
  let Ok(entries) = fs::read_dir(from.join(at)) else {
    return;
  };
  for entry in entries.flatten() {
    let path = at.join(entry.file_name());
    if entry.path().is_dir() {
      files_under(from, &path, out);
    } else {
      out.push(path);
    }
  }
}

// The app's icon on Android, its launcher's and its splash's: Dusk's mark,
// made from icons/app-icon.json with `cargo tauri icon`, into the Android
// project's resources in place of Tauri's own.
fn dusk_icon() {
  println!("cargo:rerun-if-changed=icons/android");
  let Some(project) = env::var_os("TAURI_ANDROID_PROJECT_PATH").map(PathBuf::from) else {
    return;
  };
  let icons = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap_or_default()).join("icons/android");
  let res = project.join("app/src/main/res");
  let mut files = Vec::new();
  files_under(&icons, Path::new(""), &mut files);
  for file in files {
    let (from, to) = (icons.join(&file), res.join(&file));
    let Ok(bytes) = fs::read(&from) else {
      continue;
    };
    if fs::read(&to).ok().as_deref() == Some(bytes.as_slice()) {
      continue;
    }
    if let Some(dir) = to.parent() {
      fs::create_dir_all(dir).expect("failed to make the Android icon's folder");
    }
    fs::write(&to, bytes).expect("failed to put Dusk's icon in the Android project");
  }
}

fn main() {
  ask_for_network_state();
  dusk_icon();
  tauri_build::build()
}
