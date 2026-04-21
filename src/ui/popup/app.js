// Popup/Full/Options UI entry.
import { isPopupView, isFullView } from "./env.js";
import { state, ONBOARD_ROUTES } from "./state.js";
import { refreshOverview, getActiveOrigin } from "./overview.js";
import { h, setChildren } from "../lib/dom.js";
import { toastView } from "../components/Toast.js";
import { createNetworkMenuController } from "../components/NetworkMenu.js";
import { createAccountMenuController } from "../components/AccountMenu.js";
import { createHeaderRenderer } from "./header.js";
import { send } from "../../wallet/bus.js";

import { homeView } from "./views/home.js";
import { receiveView } from "./views/receive.js";
import { sendFormView, sendConfirmView } from "./views/send.js";
import { convertFormView, convertConfirmView } from "./views/convert.js";
import { stakeFormView, stakeConfirmView } from "./views/stake.js";
import {
  assetAddTokenView,
  assetAddNftView,
  assetTokenView,
  assetTokenConfirmView,
  assetNftView,
} from "./views/assets.js";
import { optionsView } from "./views/options.js";
import { addressBookView } from "./views/addressbook.js";
import { txDetailsView } from "./views/txDetails.js";
import {
  onboardingWelcomeView,
  onboardingCreatePasswordView,
  onboardingCreatePhraseView,
  onboardingCreateConfirmView,
  onboardingImportView,
} from "./views/onboarding.js";
import { lockedView } from "./views/locked.js";
import { getRuntimeKind, isExtensionRuntime } from "../../platform/runtime.js";
import {
  getExtensionApi,
  runtimeGetURL,
  tabsCreate,
} from "../../platform/extensionApi.js";

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
const ext = getExtensionApi();

// Animate route changes only.
let lastAnimatedRoute = null;
let viewAnimTimer = null;
function pulseViewAnimation() {
  try {
    if (!app) return;
    app.classList.remove("view-animate");
    // Force reflow so the animation can replay.
    void app.offsetWidth;
    app.classList.add("view-animate");
    if (viewAnimTimer) clearTimeout(viewAnimTimer);
    viewAnimTimer = setTimeout(() => {
      try {
        app.classList.remove("view-animate");
      } catch {}
    }, 260);
  } catch {
    // ignore
  }
}

function setApp(children) {
  if (!app) return;

  // Trigger a small transition only when the route changes.
  try {
    const r = state?.route;
    if (r && r !== lastAnimatedRoute) {
      const prev = lastAnimatedRoute;
      // Keep lastAnimatedRoute in sync even if we skip animation.
      lastAnimatedRoute = r;

      // Assets/Activity are tabs inside the same "home" surface.
      // Switching between them should feel like a segmented toggle, not a
      // full view transition.
      const isHomeTab = (x) => x === "home" || x === "activity";
      if (!(isHomeTab(prev) && isHomeTab(r))) {
        pulseViewAnimation();
      }
    }
  } catch {
    // ignore
  }

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

// --- Pending tx polling (local runtimes) -----------------------------------
// The extension receives push events from background/offscreen when txs execute.
// In local runtimes we don't have a background messaging channel, so we
// opportunistically poll overview while there are pending txs.
let pendingTxPollTimer = null;
function schedulePendingTxPoll(ov) {
  try {
    if (pendingTxPollTimer) {
      clearTimeout(pendingTxPollTimer);
      pendingTxPollTimer = null;
    }

    if (isExtensionRuntime()) return;
    if (!ov?.isUnlocked) return;
    if (state.route !== "home" && state.route !== "activity") return;

    const txs = Array.isArray(ov?.txs) ? ov.txs : [];
    const hasPending = txs.some((tx) => {
      const s = String(tx?.status ?? "submitted").toLowerCase();
      return s !== "executed" && s !== "failed";
    });
    if (!hasPending) return;

    pendingTxPollTimer = setTimeout(() => {
      try {
        if (state.route !== "home" && state.route !== "activity") return;
        render({ forceRefresh: true }).catch(() => {});
      } catch {
        // ignore
      }
    }, 2500);
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
    if (!ext?.runtime?.onMessage) return;

    ext.runtime.onMessage.addListener((msg) => {
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

// --- Auto-lock activity heartbeat ------------------------------------------
// Send activity pings to background while the popup is visible/focused.
// This prevents auto-lock from triggering while the user is actively using
// the wallet UI.
let activityHeartbeatTimer = null;

function startActivityHeartbeat() {
  if (activityHeartbeatTimer) return;
  // Immediately ping once, then every 30s.
  send({ type: "DUSK_UI_ACTIVITY" }).catch(() => {});
  activityHeartbeatTimer = setInterval(() => {
    send({ type: "DUSK_UI_ACTIVITY" }).catch(() => {});
  }, 30_000);
}

function stopActivityHeartbeat() {
  if (activityHeartbeatTimer) {
    clearInterval(activityHeartbeatTimer);
    activityHeartbeatTimer = null;
  }
}

// Start heartbeat immediately when popup opens.
startActivityHeartbeat();

// Pause when tab/window is hidden, resume when visible.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopActivityHeartbeat();
  } else {
    startActivityHeartbeat();
  }
});

// Also ping on any user interaction to be extra safe.
document.addEventListener("click", () => {
  send({ type: "DUSK_UI_ACTIVITY" }).catch(() => {});
}, { passive: true });

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

// --- Account menu --------------------------------------------------------
const acctMenu = createAccountMenuController({
  onSelectAccountIndex: async (index) => {
    try {
      acctMenu.close();
      const resp = await send({ type: "DUSK_UI_SET_ACCOUNT_INDEX", index });
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to switch profile");
      if (!resp?.ok) throw new Error("Failed to switch profile");

      showToast("Profile selected.");
      state.needsRefresh = true;
      await render({ forceRefresh: true });
    } catch (e) {
      showToast(e?.message ?? String(e));
    }
  },
  onOpenOptions: async () => {
    acctMenu.close();
    netMenu.close();
    state.route = "options";
    await render();
  },
});

// --- Header actions -------------------------------------------------------
async function onRefresh() {
  netMenu.close();
  acctMenu.close();
  state.needsRefresh = true;
  await render({ forceRefresh: true });
}

async function onOpenOptions() {
  netMenu.close();
  acctMenu.close();
  state.route = "options";
  await render();
}

async function onExpand() {
  try {
    netMenu.close();
    acctMenu.close();
    const origin = await getActiveOrigin();
    const qs = new URLSearchParams();
    if (origin) qs.set("origin", origin);

    // Preserve the current in-app route when expanding popup -> full view.
    // This keeps Settings/Activity/etc. consistent and avoids surprising jumps.
    try {
      const r = String(state?.route ?? "");
      if (r) qs.set("route", r);

      // Preserve tx details if we're currently looking at a tx.
      if (r === "tx" && state?.txDetailHash) {
        qs.set("hash", String(state.txDetailHash));
      }

      // Preserve Activity highlight (used when opened from a notification).
      if (r === "activity" && state?.highlightTx) {
        qs.set("tx", String(state.highlightTx));
      }
    } catch {
      // ignore
    }

    const suffix = qs.toString();
    const url = runtimeGetURL(`full.html${suffix ? `?${suffix}` : ""}`);
    await tabsCreate({ url });
    if (isPopupView) window.close();
  } catch (e) {
    showToast(e?.message ?? String(e));
  }
}

const renderHeader = createHeaderRenderer({
  headerActionsHost,
  netMenu,
  acctMenu,
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
  schedulePendingTxPoll(ov);

  const actions = { send, render, showToast };

  // Settings should be accessible even when the wallet is locked or not yet imported.
  // TODO: Reconsider?
  if (state.route === "options") {
    setApp(optionsView(ov, { state, actions }));
    return;
  }

  // Contacts are also safe to show without unlocking.
  if (state.route === "contacts") {
    setApp(addressBookView(ov, { state, actions }));
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
  if (state.route === "stake") {
    setApp(stakeFormView(ov, { state, actions }));
    return;
  }
  if (state.route === "stake_confirm") {
    setApp(stakeConfirmView(ov, { state, actions }));
    return;
  }
  if (state.route === "asset_add_token") {
    setApp(assetAddTokenView(ov, { state, actions }));
    return;
  }
  if (state.route === "asset_add_nft") {
    setApp(assetAddNftView(ov, { state, actions }));
    return;
  }
  if (state.route === "asset_token") {
    setApp(assetTokenView(ov, { state, actions }));
    return;
  }
  if (state.route === "asset_token_confirm") {
    setApp(assetTokenConfirmView(ov, { state, actions }));
    return;
  }
  if (state.route === "asset_nft") {
    setApp(assetNftView(ov, { state, actions }));
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
