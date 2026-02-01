// Runtime detection helpers.
//
// We want the *same* UI + wallet logic to work in:
// - Chrome extension pages (popup/full/options/offscreen)
// - Tauri desktop/mobile (WebView)
// - plain web (dev harness)
//
// IMPORTANT: never directly reference `window` or `chrome` without guarding.

export function isExtensionRuntime() {
  try {
    const ext =
      typeof globalThis !== "undefined"
        ? globalThis.browser ?? globalThis.chrome ?? null
        : null;

    // In normal webpages, a `chrome` object may exist, but
    // `runtime.id` and `runtime.sendMessage` are extension-only!
    return (
      !!ext?.runtime?.id &&
      typeof ext?.runtime?.sendMessage === "function"
    );
  } catch {
    return false;
  }
}

export function isTauriRuntime() {
  try {
    // Tauri v2 can run with `withGlobalTauri` disabled, in which case
    // `window.__TAURI__` might not be injected, but internals still exist.
    // I keep the check loose to support both modes.
    return (
      typeof window !== "undefined" &&
      (typeof window.__TAURI__ !== "undefined" ||
        typeof window.__TAURI_INTERNALS__ !== "undefined")
    );
  } catch {
    return false;
  }
}

export function getRuntimeKind() {
  if (isExtensionRuntime()) return "extension";
  if (isTauriRuntime()) return "tauri";
  return "web";
}
