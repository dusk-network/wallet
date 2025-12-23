// Popup/Full/Options UI entry.
import { isPopupView, isFullView } from "./env.js";
import { state, ONBOARD_ROUTES } from "./state.js";
import { refreshOverview, getActiveOrigin } from "./overview.js";
import { h, setChildren } from "../lib/dom.js";
import { toastView } from "../components/Toast.js";
import { createNetworkMenuController } from "../components/NetworkMenu.js";
import { createHeaderRenderer } from "./header.js";
import { send } from "../../wallet/bus.js";

import { homeView } from "./views/home.js";
import { receiveView } from "./views/receive.js";
import { sendFormView, sendConfirmView } from "./views/send.js";
import { optionsView } from "./views/options.js";
import {
  onboardingWelcomeView,
  onboardingCreatePasswordView,
  onboardingCreatePhraseView,
  onboardingCreateConfirmView,
  onboardingImportView,
} from "./views/onboarding.js";
import { lockedView } from "./views/locked.js";
import { getRuntimeKind } from "../../platform/runtime.js";

// Keep everything in dark mode for now.
document.documentElement.classList.add("dark");

// Useful for CSS tweaks per platform (extension vs tauri vs web).
try {
  document.body.dataset.runtime = getRuntimeKind();
  document.body.dataset.view = isPopupView ? "popup" : isFullView ? "full" : "app";
} catch {
  // ignore
}

const app = document.getElementById("app");
const headerActionsHost = document.getElementById("header-actions");

function setApp(children) {
  if (!app) return;
  app.innerHTML = "";
  const toast = toastView(state.toast);
  if (toast) app.appendChild(toast);
  for (const child of children) app.appendChild(child);
}

function showError(err) {
  return h("div", { class: "err", text: err?.message ?? String(err) });
}

// --- Toast ---------------------------------------------------------------
let toastTimer = null;
function showToast(text, ms = 1200) {
  state.toast = String(text || "");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    toastTimer = null;
    render().catch(() => {});
  }, ms);
  render().catch(() => {});
}

// --- Network menu --------------------------------------------------------
const netMenu = createNetworkMenuController({
  onSelectPreset: async (preset) => {
    try {
      netMenu.close();

      if (preset.id === "custom") {
        // Keep navigation consistent: open the in-app Settings screen.
        state.route = "options";
        state.banner = null;
        await render();
        return;
      }

      const resp = await send({
        type: "DUSK_UI_SET_NODE_URL",
        nodeUrl: preset.nodeUrl,
      });

      if (resp?.error) throw new Error(resp.error.message ?? "Failed to switch network");

      showToast(`Switched to ${preset.label}`);
      state.needsRefresh = true;
      await render({ forceRefresh: true });
    } catch (e) {
      showToast(e?.message ?? String(e));
    }
  },
});

// --- Header actions -------------------------------------------------------
async function onRefresh() {
  netMenu.close();
  state.banner = null;
  state.needsRefresh = true;
  await render({ forceRefresh: true });
}

async function onOpenOptions() {
  netMenu.close();
  state.route = "options";
  state.banner = null;
  await render();
}

async function onExpand() {
  try {
    netMenu.close();
    const origin = await getActiveOrigin();
    const url = chrome.runtime.getURL(
      `full.html${origin ? `?origin=${encodeURIComponent(origin)}` : ""}`
    );
    await chrome.tabs.create({ url });
    if (isPopupView) window.close();
  } catch (e) {
    showToast(e?.message ?? String(e));
  }
}

const renderHeader = createHeaderRenderer({
  headerActionsHost,
  netMenu,
  onRefresh,
  onOpenOptions,
  onExpand,
  showToast,
});

// --- Main render ----------------------------------------------------------
export async function render({ forceRefresh = false } = {}) {
  await refreshOverview(send, { force: forceRefresh });
  const ov = state.overview;

  // Always render header actions based on latest overview
  renderHeader(ov);

  const actions = { send, render, showToast };

  // Settings should be accessible even when the wallet is locked or not yet imported.
  // TODO: Reconsider?
  if (state.route === "options") {
    setApp(optionsView(ov, { state, actions }));
    return;
  }

  if (!ov?.hasVault) {
    if (!ONBOARD_ROUTES.has(state.route)) {
      state.route = "onboard_welcome";
    }

    if (state.route === "onboard_welcome") {
      setApp(onboardingWelcomeView({ state, actions }));
      return;
    }
    if (state.route === "onboard_create_password") {
      setApp(onboardingCreatePasswordView({ state, actions }));
      return;
    }
    if (state.route === "onboard_create_phrase") {
      setApp(onboardingCreatePhraseView({ state, actions }));
      return;
    }
    if (state.route === "onboard_create_confirm") {
      setApp(onboardingCreateConfirmView({ state, actions }));
      return;
    }
    if (state.route === "onboard_import") {
      setApp(onboardingImportView({ state, actions }));
      return;
    }

    // Fallback
    state.route = "onboard_welcome";
    setApp(onboardingWelcomeView({ state, actions }));
    return;
  }

  if (!ov.isUnlocked) {
    setApp(lockedView({ state, actions }));
    return;
  }

  // Unlocked routes
  if (state.route === "send") {
    setApp(sendFormView(ov, { state, actions }));
    return;
  }
  if (state.route === "confirm") {
    setApp(sendConfirmView(ov, { state, actions }));
    return;
  }
  if (state.route === "receive") {
    setApp(receiveView(ov, { state, actions }));
    return;
  }

  // default: home
  setApp(homeView(ov, { state, actions }));
}

export function mountPopup() {
  render().catch((e) => {
    setApp([showError(e)]);
  });
}

(function setupViewportInsets() {
  try {
    if (document.body?.dataset?.runtime !== "tauri") return;
    if (!window.visualViewport) return;

    const root = document.documentElement;
    const vv = window.visualViewport;

    const update = () => {
      const top = Math.max(0, vv.offsetTop || 0);
      const layoutH = document.documentElement?.clientHeight || window.innerHeight;
      const bottom = Math.max(0, layoutH - vv.height - top);

      root.style.setProperty("--dusk-vv-top", `${top}px`);
      root.style.setProperty("--dusk-vv-bottom", `${bottom}px`);
    };

    let raf = 0;
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };

    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", () => setTimeout(schedule, 50));

    schedule();
  } catch {}
})();
