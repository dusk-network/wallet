// What the app (apps/tauri) does natively that a page can't: open a link in
// the phone's browser, the share sheet, a file saved to Downloads, and
// payment links opened from elsewhere. Each is the app's alone: elsewhere it
// does nothing and says so, and the caller does what a page does.

import { isTauriRuntime } from "./runtime.js";

/**
 * Opens `url` in the phone's browser (the opener plugin), never in the
 * wallet's own window. False outside the app, or where it couldn't.
 * @param {string} url
 */
export async function openInBrowser(url) {
  if (!isTauriRuntime()) return false;
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Android's share sheet with `text`. False outside the app, or where there's none.
 * @param {string} text
 * @param {string} [title]
 */
export async function shareText(text, title = "") {
  if (!isTauriRuntime()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("share_text", { text: String(text), title: String(title) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves a file in the phone's Downloads, as `name`. False outside the app, or
 * where it couldn't; the caller saves it as a page does.
 * @param {string} name
 * @param {string} mime
 * @param {Uint8Array | string} contents - text is saved as UTF-8
 */
export async function saveToDownloads(name, mime, contents) {
  if (!isTauriRuntime()) return false;
  try {
    const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke("save_download", { name: String(name), mime: String(mime), bytes: Array.from(bytes) })) === true;
  } catch {
    return false;
  }
}

/**
 * Hears the `dusk:` payment links the app is opened with: the one that
 * started it, then each one after. Nothing outside the app.
 * @param {(url: string) => void} onLink
 */
export async function listenForLinks(onLink) {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
    const take = (urls) => {
      const url = Array.isArray(urls) ? urls.at(-1) : urls;
      if (url) onLink(String(url));
    };
    await onOpenUrl(take);
    take(await getCurrent());
  } catch {
    // No links in this app build.
  }
}

/**
 * Puts the app in the background as it is, as Home does, rather than closing
 * it as Back on its first screen would. False outside the app, or where it couldn't.
 */
export async function moveAppToBack() {
  if (!isTauriRuntime()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke("move_to_back")) === true;
  } catch {
    return false;
  }
}
