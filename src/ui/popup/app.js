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
import { convertFormView, convertConfirmView } from "./views/convert.js";
import { optionsView } from "./views/options.js";
import { txDetailsView } from "./views/txDetails.js";
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

// --- Shielded sync UI polling ----------------------------------------------
// Shielded note scanning can take some time, and we don't have a push channel
// for progress yet. While the user is on the Home/Activity tabs, we lightly
// poll overview so the Shielded row can show "Syncing 12%" style feedback.
let shieldedPollTimer = null;
function scheduleShieldedPoll(ov) {
  try {
    if (shieldedPollTimer) {
      clearTimeout(shieldedPollTimer);
      shieldedPollTimer = null;
    }

    if (!ov?.isUnlocked) return;
    if (state.route !== "home" && state.route !== "activity") return;

    const st = ov?.shieldedSync?.state;
    if (st !== "syncing") return;

    shieldedPollTimer = setTimeout(() => {
      try {
        if (state.route !== "home" && state.route !== "activity") return;
        // Force refresh so we see latest cursor/progress.
        render({ forceRefresh: true }).catch(() => {});
      } catch {
        // ignore
      }
    }, 1200);
  } catch {
    // ignore
  }
}

// --- Tx status push (from background) --------------------------------------
let txStatusListenerInstalled = false;
function installTxStatusListener() {
  if (txStatusListenerInstalled) return;
  txStatusListenerInstalled = true;

  try {
    if (!chrome?.runtime?.onMessage) return;

    chrome.runtime.onMessage.addListener((msg) => {
      try {
        if (msg?.type === "DUSK_UI_SHIELDED_STATUS") {
          // Shielded sync finished (or status changed) in offscreen.
          // Trigger an overview refresh so the UI updates without requiring
          // manual reload.
          state.needsRefresh = true;

          // Best-effort local patch to avoid showing stale state.
          try {
            if (state.overview && msg.status) {
              state.overview.shieldedSync = msg.status;
            }
          } catch {
            // ignore
          }

          setTimeout(() => {
            refreshOverview(send, { force: true })
              .then(() => render())
              .catch(() => {});
          }, 150);

          return;
        }

        if (msg?.type !== "DUSK_UI_TX_STATUS") return;

        const hash = String(msg.hash ?? "");
        const ok = msg.ok !== false;
        const sh =
          hash && hash.length > 18
            ? `${hash.slice(0, 10)}…${hash.slice(-8)}`
            : hash;

        if (ok) {
          showToast(sh ? `Transaction executed: ${sh}` : "Transaction executed", 2500);
        } else {
          showToast(sh ? `Transaction failed: ${sh}` : "Transaction failed", 3000);
        }

        // Best-effort immediate UI update so the Activity row can transition
        // without waiting for the next overview refresh.
        try {
          const ov = state.overview;
          if (ov && Array.isArray(ov.txs)) {
            const item = ov.txs.find((t) => String(t?.hash ?? "") === hash);
            if (item) {
              item.status = ok ? "executed" : "failed";
              if (!ok && msg?.error) item.error = String(msg.error);
            }
          }
        } catch {
          // ignore
        }

        // Pulse the activity row (pending -> executed/failed) for a short time.
        state.txPulse = { hash, kind: ok ? "ok" : "bad", at: Date.now() };
        setTimeout(() => {
          try {
            if (state.txPulse && state.txPulse.hash === hash) {
              state.txPulse = null;
              render().catch(() => {});
            }
          } catch {
            // ignore
          }
        }, 2200);

        // Trigger a refresh so balances/state update soon after execution.
        state.needsRefresh = true;
        setTimeout(() => {
          refreshOverview(send, { force: true })
            .then(() => render())
            .catch(() => {});
        }, 500);
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
}

installTxStatusListener();

// --- Network menu --------------------------------------------------------
const netMenu = createNetworkMenuController({
  onSelectPreset: async (preset) => {
    try {
      netMenu.close();

      if (preset.id === "custom") {
        // Keep navigation consistent: open the in-app Settings screen.
        state.route = "options";
        await render();
        return;
      }

      const resp = await send({
        type: "DUSK_UI_SET_NODE_URL",
        nodeUrl: preset.nodeUrl,
        proverUrl: preset.proverUrl,
        archiverUrl: preset.archiverUrl,
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
  state.needsRefresh = true;
  await render({ forceRefresh: true });
}

async function onOpenOptions() {
  netMenu.close();
  state.route = "options";
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

  // Keep shielded sync progress visible while on home/activity.
  scheduleShieldedPoll(ov);

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
  if (state.route === "convert") {
    setApp(convertFormView(ov, { state, actions }));
    return;
  }
  if (state.route === "convert_confirm") {
    setApp(convertConfirmView(ov, { state, actions }));
    return;
  }
  if (state.route === "receive") {
    setApp(receiveView(ov, { state, actions }));
    return;
  }
  if (state.route === "tx") {
    setApp(txDetailsView(ov, { state, actions }));
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
