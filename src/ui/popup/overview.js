import { fixedOrigin } from "./env.js";
import { state } from "./state.js";

export async function getActiveOrigin() {
  if (fixedOrigin) return fixedOrigin;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tabs?.[0]?.url;
    if (!url) return null;
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export async function refreshOverview(send, { force = false } = {}) {
  const origin = await getActiveOrigin();
  const originChanged = origin !== state.lastOrigin;

  if (!force && state.overview && !state.needsRefresh && !originChanged) {
    return;
  }

  state.overview = await send({ type: "DUSK_UI_OVERVIEW", origin });
  state.lastOrigin = origin;
  state.needsRefresh = false;
}
