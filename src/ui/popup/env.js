// View-mode helpers.
//
// In the extension we have distinct HTML entrypoints (popup.html/full.html).
// In Tauri we typically load / or /index.html, so pathname-based detection
// doesn't work. Prefer body classes and runtime detection.

import { isTauriRuntime } from "../../platform/runtime.js";

const path = location.pathname;
const body = document.body;

const hasClass = (cls) => !!body?.classList?.contains(cls);

export const isPopupView = hasClass("page--popup") && path.endsWith("popup.html");
export const isOptionsPage = path.endsWith("options.html");

// Consider any page with `page--full` (full.html, index.html for Tauri) as full.
// Also treat Tauri as full/app mode even if body classes change later.
export const isFullView = hasClass("page--full") || isOptionsPage || isTauriRuntime();

export let fixedOrigin = null;
try {
  const p = new URLSearchParams(location.search).get("origin");
  if (p) fixedOrigin = new URL(p).origin;
} catch {
  // ignore
}
