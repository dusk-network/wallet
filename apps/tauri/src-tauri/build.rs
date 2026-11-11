use std::{
  env, fs,
  path::{Path, PathBuf},
};

// What the wallet asks of Android beyond Tauri's own manifest: to hear the
// network come and go (without it the WebView never tells the page it went
// offline, so the wallet can't say so), to ask for a fingerprint, for
// fingerprint unlock (android/KeystorePlugin.kt), to show arrival notices
// (android/NoticesPlugin.kt), which Android 13 and later ask about, only when
// the person taps Tell me when it arrives, and the camera, for Scan QR, which
// Android asks about as a scan opens (the WebView asks for it as the page
// does). The others are normal permissions: Android asks nothing.
const PERMISSIONS: [&str; 4] = [
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.USE_BIOMETRIC",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.CAMERA",
];

// The camera is the wallet's to use where there is one: a phone without one
// still gets the app (the permission alone would say it needs one).
const OPTIONAL_FEATURES: [&str; 1] = ["android.hardware.camera"];

// The Android project `cargo tauri android init` makes, which isn't kept in
// git: its manifest gets the permissions as the app is built.
fn ask_for_permissions() {
  println!("cargo:rerun-if-env-changed=TAURI_ANDROID_PROJECT_PATH");
  let Some(project) = env::var_os("TAURI_ANDROID_PROJECT_PATH").map(PathBuf::from) else {
    return;
  };
  let path = project.join("app/src/main/AndroidManifest.xml");
  println!("cargo:rerun-if-changed={}", path.display());
  let Ok(mut manifest) = fs::read_to_string(&path) else {
    return;
  };
  let before = manifest.clone();
  let permissions = PERMISSIONS.map(|name| (name, format!("<uses-permission android:name=\"{name}\" />")));
  let features = OPTIONAL_FEATURES.map(|name| (name, format!("<uses-feature android:name=\"{name}\" android:required=\"false\" />")));
  for (name, line) in permissions.into_iter().chain(features) {
    if manifest.contains(&format!("\"{name}\"")) {
      continue;
    }
    // Right after the manifest's opening tag, beside its other permissions.
    let Some(open) = manifest.find("<manifest") else {
      return;
    };
    let Some(end) = manifest[open..].find('>').map(|at| open + at + 1) else {
      return;
    };
    manifest = format!("{}\n    {line}{}", &manifest[..end], &manifest[end..]);
  }
  if manifest != before {
    fs::write(&path, manifest).expect("failed to add the wallet's permissions to AndroidManifest.xml");
  }
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

// The wallet's own Android code, Kotlin beside src/android.rs, into the Android
// project's sources, where Gradle builds it with the app.
fn dusk_kotlin() {
  println!("cargo:rerun-if-changed=android");
  let Some(project) = env::var_os("TAURI_ANDROID_PROJECT_PATH").map(PathBuf::from) else {
    return;
  };
  let from = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap_or_default()).join("android");
  let to = project.join("app/src/main/java/network/dusk/wallet");
  let Ok(entries) = fs::read_dir(&from) else {
    return;
  };
  for entry in entries.flatten() {
    let path = entry.path();
    if path.extension().and_then(|ext| ext.to_str()) != Some("kt") {
      continue;
    }
    let Ok(bytes) = fs::read(&path) else {
      continue;
    };
    let target = to.join(entry.file_name());
    if fs::read(&target).ok().as_deref() == Some(bytes.as_slice()) {
      continue;
    }
    fs::create_dir_all(&to).expect("failed to make the Android sources' folder");
    fs::write(&target, bytes).expect("failed to put the wallet's Kotlin in the Android project");
  }
}

// The job that looks a send up with the app in the background
// (android/ArrivalJob.kt), as JobScheduler runs it: a service only Android
// may start, in the manifest's application.
const SERVICES: [&str; 1] = ["ArrivalJob"];

fn declare_services() {
  let Some(project) = env::var_os("TAURI_ANDROID_PROJECT_PATH").map(PathBuf::from) else {
    return;
  };
  let path = project.join("app/src/main/AndroidManifest.xml");
  let Ok(mut manifest) = fs::read_to_string(&path) else {
    return;
  };
  let before = manifest.clone();
  for service in SERVICES {
    if manifest.contains(&format!("\".{service}\"")) {
      continue;
    }
    let Some(end) = manifest.rfind("</application>") else {
      return;
    };
    let line = format!(
      "    <service android:name=\".{service}\" android:permission=\"android.permission.BIND_JOB_SERVICE\" android:exported=\"false\" />\n    "
    );
    manifest.insert_str(end, &line);
  }
  if manifest != before {
    fs::write(&path, manifest).expect("failed to declare the wallet's services in AndroidManifest.xml");
  }
}

fn main() {
  ask_for_permissions();
  declare_services();
  dusk_icon();
  dusk_kotlin();
  tauri_build::build()
}
