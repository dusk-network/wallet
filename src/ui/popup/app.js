// Popup/Full/Options UI entry.
import { isPopupView, isFullView } from "./env.js";
import { emptyAddressBook, state, ONBOARD_ROUTES } from "./state.js";
import { switchContext } from "./context.js";
import { refreshOverview, getActiveOrigin } from "./overview.js";
import { h, setChildren } from "../lib/dom.js";
import { siteName } from "../lib/strings.js";
import { createToaster } from "../components/Toast.js";
import { balancesHidden } from "../components/Balance.js";
import { txStatusToast } from "./txToast.js";
import { createNetworkMenuController } from "../components/NetworkMenu.js";
import { createAccountMenuController } from "../components/AccountMenu.js";
import { createHeaderRenderer } from "./header.js";
import { send as rawSend } from "../../wallet/bus.js";
import { WALLET_MESSAGE_EVENT } from "../../shared/constants.js";
import { safeBigInt } from "../../shared/amount.js";
import { makeSozuStDuskToken } from "../../shared/sozuAdapter.js";
import { activityRows, ensureActivity, refreshActivitySoon, selected } from "./activity.js";
import { checkArrivals } from "./arrivals.js";
import { arrivalCheckDelay, awaitingArrival, loadArrivals } from "../../shared/bridgeArrival.js";
import { saveHandedExport } from "./activityExport.js";

import { homeView } from "./views/home.js";
import { receiveView } from "./views/receive.js";
import { sendFormView, sendConfirmView } from "./views/send.js";
import { convertFormView, convertConfirmView } from "./views/convert.js";
import { stakeFormView, stakeConfirmView } from "./views/stake.js";
import { sozuConfirmView } from "./views/sozu.js";
import { noteTxStatus, sentAnnouncement, sentView } from "./views/sent.js";
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
  restoreWalletView,
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
// Toasts live outside #app, which scrolls and is redrawn.
const toaster = createToaster();
const fullNav = document.querySelector(".full-nav");
const ext = getExtensionApi();

function isWalletLockedResponse(value) {
  const err = value?.error ?? value;
  const message = String(err?.message ?? err ?? "");
  return /wallet locked/i.test(message);
}

function applyLockedOverviewPatch() {
  try {
    // Locked here or elsewhere: whatever began unlocked is for nothing now.
    switchContext(state, "lock");
    stopArrivalChecks();
    state.overview = {
      ...(state.overview ?? {}),
      isUnlocked: false,
      accounts: [],
      addresses: [],
      balance: null,
      shieldedBalance: null,
    };
    state.needsRefresh = true;
  } catch {
    // ignore
  }
}

let lockRefreshTimer = null;
function scheduleLockedRefresh() {
  applyLockedOverviewPatch();
  if (lockRefreshTimer) clearTimeout(lockRefreshTimer);
  lockRefreshTimer = setTimeout(() => {
    lockRefreshTimer = null;
    render({ forceRefresh: true }).catch(() => {});
  }, 0);
}

async function send(message) {
  const response = await rawSend(message);
  if (isWalletLockedResponse(response)) {
    scheduleLockedRefresh();
  }
  return response;
}

function stDuskWatchKey(ov, profileIndex, contractId) {
  return [
    String(ov?.nodeUrl ?? ""),
    String(profileIndex ?? 0),
    String(contractId ?? "").toLowerCase(),
  ].join("|");
}

async function maybeAutoWatchDashboardStDusk(ov) {
  try {
    if (!ov?.isUnlocked) return;
    if (state.route !== "home") return;

    const profileIndex = Number(ov?.selectedAccountIndex ?? 0) || 0;
    const st = (state.sozuAutoWatch ??= { key: "", pending: "" });

    const statusResp = await send({ type: "DUSK_UI_GET_SOZU_STATUS", profileIndex });
    if (statusResp?.error) return;

    const status = statusResp?.result ?? statusResp ?? {};
    const contractId = status?.contracts?.["staked-dusk"];
    const balance = safeBigInt(status?.position?.stDuskBalanceLux ?? 0, 0n);
    if (!contractId || balance <= 0n) return;

    const key = stDuskWatchKey(ov, profileIndex, contractId);
    if (st.key === key || st.pending === key) return;

    const assetsResp = await send({ type: "DUSK_UI_ASSETS_GET", profileIndex });
    const assets = assetsResp?.result ?? assetsResp ?? {};
    const tokens = Array.isArray(assets?.tokens) ? assets.tokens : [];
    if (tokens.some((t) => String(t?.contractId ?? "").toLowerCase() === String(contractId).toLowerCase())) {
      st.key = key;
      return;
    }

    st.pending = key;
    const watchResp = await send({
      type: "DUSK_UI_ASSETS_WATCH_TOKEN",
      profileIndex,
      token: makeSozuStDuskToken(contractId),
    });
    if (watchResp?.error) return;

    st.key = key;
    if (state.assets) state.assets.loaded = false;
  } catch {
    // Dashboard asset discovery is best-effort; it must not block wallet use.
  } finally {
    try {
      if (state.sozuAutoWatch?.pending) state.sozuAutoWatch.pending = "";
    } catch {
      // ignore
    }
  }
}

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

// Retain the mounted unlock nodes, not a password copy in application state:
// the unlock form's, or the restore's ("unlock" | "restore").
let activeLockedView = null;
let activeLockedScreen = "";
// The screen last drawn, to start a new one at its top.
let lastScreen = "";

function setApp(children) {
  if (!app) return;

  // Trigger a small transition only when the route changes.
  try {
    const r = state?.route;
    if (r && r !== lastAnimatedRoute) {
      const prev = lastAnimatedRoute;
      // Keep lastAnimatedRoute in sync even if we skip animation.
      lastAnimatedRoute = r;

      // Home and its full Activity list move without the transition.
      const isHomeTab = (x) => x === "home" || x === "activity";
      if (!(isHomeTab(prev) && isHomeTab(r))) {
        pulseViewAnimation();
      }
    }
  } catch {
    // ignore
  }

  // A new screen opens at its top, not where the last one was scrolled to.
  let sameScreen = false;
  try {
    const screen = `${state?.route ?? ""}|${state?.route === "stake" ? state?.staking?.screen ?? "" : ""}`;
    sameScreen = screen === lastScreen;
    if (!sameScreen) {
      lastScreen = screen;
      const scroller = app.closest?.(".panel-content");
      if (scroller) scroller.scrollTop = 0;
      // The full view scrolls the page itself.
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    }
  } catch {
    // ignore
  }

  if (children !== activeLockedView) {
    // Redrawn in place (a watcher event, a refresh), the screen keeps the
    // focus on the same button or field, and a field its caret.
    const focused = sameScreen ? focusedControl() : null;
    const password = app.querySelector("#unlock-password");
    if (password) password.value = "";
    activeLockedView = null;
    app.innerHTML = "";
    const siteBar = activeSiteBar(state.overview);
    if (siteBar) app.appendChild(siteBar);
    for (const child of children) app.appendChild(child);
    if (focused) refocusControl(focused);
  }
}

// The focused control in #app (a button, a disclosure or a field), by its
// words and its place among those with the same words; a field also by its
// name and placeholder, and with its caret, so typing goes on where it was.
const FOCUS_KEPT = "button, summary, input, select, textarea";

function focusedControl() {
  try {
    const el = document.activeElement;
    if (!el || !el.matches?.(FOCUS_KEPT) || !app.contains(el)) return null;
    const key = (b) =>
      [b.tagName, b.textContent, ...["aria-label", "name", "placeholder", "type"].map((a) => b.getAttribute(a) ?? "")].join("\n");
    const same = [...app.querySelectorAll(FOCUS_KEPT)].filter((b) => key(b) === key(el));
    let caret = null;
    try {
      if (typeof el.selectionStart === "number") caret = [el.selectionStart, el.selectionEnd, el.selectionDirection ?? "none"];
    } catch {
      // A field without a caret, such as a checkbox.
    }
    return { key: key(el), index: same.indexOf(el), keyOf: key, caret };
  } catch {
    return null;
  }
}

function refocusControl({ key, index, keyOf, caret }) {
  try {
    const match = [...app.querySelectorAll(FOCUS_KEPT)].filter((b) => keyOf(b) === key)[index];
    match?.focus?.();
    if (caret && typeof match?.setSelectionRange === "function") match.setSelectionRange(...caret);
  } catch {
    // ignore
  }
}

function showError(err) {
  return h("div", { class: "err", text: err?.message ?? String(err) });
}

function updateFullNav() {
  try {
    if (!fullNav) return;
    const rawRoute = state?.route || "home";
    // A transaction's details stay under the item they were opened from.
    const route =
      rawRoute === "convert_confirm"
        ? "convert"
        : rawRoute === "tx"
        ? state?.txDetailFrom || "home"
        : rawRoute === "sent"
        ? state?.sent?.doneRoute || "home"
        : rawRoute;
    for (const item of fullNav.querySelectorAll("[data-route]")) {
      const itemRoute = item.getAttribute("data-route");
      const active = itemRoute === route;
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
  } catch {
    // ignore
  }
}

if (fullNav) {
  fullNav.addEventListener("click", async (event) => {
    const btn = event.target?.closest?.("[data-route]");
    if (!btn) return;
    const route = btn.getAttribute("data-route");
    if (!route) return;
    netMenu.close();
    acctMenu.close();
    state.route = route;
    // Staking opens on its overview, and Activity on all of it, as See all does.
    if (route === "stake" && state.staking) state.staking.screen = "overview";
    if (route === "activity") state.activityFilter = "all";
    state.needsRefresh = true;
    if (route !== "home") state.highlightTx = null;
    await render({ forceRefresh: true });
  });
}

// --- Toast ---------------------------------------------------------------
// A line of text or a toast spec (see Toast.js). It stays at least a few
// seconds, longer with an action, and while the pointer or focus is on it.
function showToast(spec, ms) {
  toaster.show(spec, ms);
}

function activeSiteInfo(ov) {
  const origin = typeof ov?.activeOrigin === "string" ? ov.activeOrigin : "";
  if (!origin) return null;
  if (!origin.startsWith("https://") && !origin.startsWith("http://")) return null;

  // As its approval named it: "http://127.0.0.1:5354", "app.dusk.network".
  return {
    origin,
    host: siteName(origin),
    connected: Boolean(ov?.activeConnected),
  };
}

function activeSiteBar(ov) {
  if (!ov?.isUnlocked) return null;
  const site = activeSiteInfo(ov);
  if (!site) return null;

  const btn = h("button", {
    class: site.connected ? "btn-outline site-bar-action" : "btn-primary site-bar-action",
    text: site.connected ? "Disconnect" : "Connect",
    onclick: async () => {
      try {
        await send({
          type: site.connected ? "DUSK_UI_DISCONNECT_ORIGIN" : "DUSK_UI_CONNECT_ORIGIN",
          origin: site.origin,
        });
        showToast(site.connected ? "Site disconnected." : "Site connected.");
        state.needsRefresh = true;
        await render({ forceRefresh: true });
      } catch (e) {
        showToast(e?.message ?? String(e), 2500);
      }
    },
  });

  return h("div", { class: "site-bar", title: site.origin }, [
    h("div", { class: "site-bar-main" }, [
      h("div", {
        class: ["conn-dot", site.connected ? "conn-dot--on" : ""].filter(Boolean).join(" "),
      }),
      h("div", { class: "site-bar-copy" }, [
        h("div", { class: "site-bar-status", text: site.connected ? "Connected" : "Not connected" }),
        h("div", { class: "site-bar-origin", text: site.host }),
      ]),
    ]),
    btn,
  ]);
}

// --- Shielded sync UI polling ----------------------------------------------
// Shielded note scanning can take some time, and we don't have a push channel
// for progress yet. While the user is on the dashboard, we lightly
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
    if (!["home", "activity", "sent"].includes(state.route)) return;

    const txs = Array.isArray(ov?.txs) ? ov.txs : [];
    const hasPending = txs.some((tx) => {
      const s = String(tx?.status ?? "submitted").toLowerCase();
      return s === "submitted" || s === "mempool";
    });
    if (!hasPending) return;

    pendingTxPollTimer = setTimeout(() => {
      try {
        if (!["home", "activity", "sent"].includes(state.route)) return;
        render({ forceRefresh: true }).catch(() => {});
      } catch {
        // ignore
      }
    }, 2500);
  } catch {
    // ignore
  }
}

// --- Deposits to DuskEVM on their way ----------------------------------------
// While Home, Activity or a transaction shows a deposit to DuskEVM that hasn't
// arrived there, DuskEVM is asked for it, at once and then less often the
// longer nothing changes (arrivals.js). Nothing is asked otherwise: a lock, or
// a switch of network, profile or wallet (a reset included), ends the looks
// begun before it.
const ARRIVAL_ROUTES = new Set(["home", "activity", "tx"]);
let arrivalTimer = null;
let arrivalLooks = 0;
let arrivalContext = null;

function stopArrivalChecks() {
  clearTimeout(arrivalTimer);
  arrivalTimer = null;
  arrivalLooks = 0;
}

function scheduleArrivalCheck(ov) {
  if (arrivalTimer && arrivalContext !== state.context) stopArrivalChecks();
  if (arrivalTimer || !ARRIVAL_ROUTES.has(state.route) || !ov?.isUnlocked) return;
  if (!activityRows(ov, state).some((tx) => awaitingArrival(tx, ov?.nodeUrl))) {
    arrivalLooks = 0;
    return;
  }
  const context = (arrivalContext = state.context);
  // Still the wallet, network and profile the look was for, unlocked, on a page that shows Activity.
  const current = () => state.context === context && Boolean(state.overview?.isUnlocked) && ARRIVAL_ROUTES.has(state.route);
  const timer = setTimeout(async () => {
    const now = state.overview;
    const found = current()
      ? await checkArrivals(activityRows(now, state), { account: selected(now).account, archiverUrl: now?.archiverUrl, nodeUrl: now?.nodeUrl }).catch(() => 0)
      : 0;
    if (arrivalTimer !== timer) return;
    arrivalTimer = null;
    if (!current()) return;
    arrivalLooks = found ? 0 : arrivalLooks + 1;
    if (found) render().catch(() => {});
    else scheduleArrivalCheck(state.overview);
  }, arrivalLooks ? arrivalCheckDelay(arrivalLooks) : 0);
  arrivalTimer = timer;
}

// --- Runtime pushes (from background) --------------------------------------
let txStatusListenerInstalled = false;
let lastShieldedStatusKey = "";
let shieldedStatusRefreshTimer = null;

function shieldedStatusKey(status) {
  if (!status || typeof status !== "object") return "";
  try {
    return JSON.stringify({
      state: status.state ?? "",
      progress: Math.round(Number(status.progress ?? 0) * 1000) / 1000,
      notes: Number(status.notes ?? 0) || 0,
      cursorBookmark: String(status.cursorBookmark ?? ""),
      cursorBlock: String(status.cursorBlock ?? ""),
      lastError: String(status.lastError ?? ""),
    });
  } catch {
    return String(status);
  }
}

// The toast for a status the watcher reports: what the transaction did, its
// amount hidden with Hide balances, and View to open it.
function txStatusToastFor(hash, status) {
  const ov = state.overview;
  const tx = hash && Array.isArray(ov?.txs) ? ov.txs.find((t) => String(t?.hash ?? "") === hash) : null;
  const contacts = state.addressBook?.loaded && Array.isArray(state.addressBook.items) ? state.addressBook.items : [];
  const contactName = (addr) => {
    const key = String(addr ?? "").toLowerCase();
    return String(contacts.find((c) => String(c?.address ?? "").toLowerCase() === key)?.name ?? "").trim();
  };
  const onView = hash
    ? () => {
        state.txDetailHash = hash;
        state.txDetailFrom = state.route === "activity" ? "activity" : "home";
        state.route = "tx";
        render().catch(() => {});
      }
    : null;
  return txStatusToast(tx, status, { hidden: balancesHidden(ov), contactName, onView });
}

function installTxStatusListener() {
  if (txStatusListenerInstalled) return;
  txStatusListenerInstalled = true;

  try {
    const onWalletMessage = (msg) => {
      try {
        if (msg?.type === "DUSK_UI_LOCK_STATE") {
          if (msg.isUnlocked === false) {
            scheduleLockedRefresh();
            return;
          }

          state.needsRefresh = true;
          render({ forceRefresh: true }).catch(() => {});
          return;
        }

        // The node's chain ID, read after the popup drew: its network's names,
        // explorer and bridge, from a fresh overview.
        if (msg?.type === "DUSK_UI_NETWORK_CHANGED") {
          state.needsRefresh = true;
          render({ forceRefresh: true }).catch(() => {});
          return;
        }

        if (msg?.type === "DUSK_UI_SHIELDED_STATUS") {
          const nextKey = shieldedStatusKey(msg.status);
          if (nextKey && nextKey === lastShieldedStatusKey) return;
          lastShieldedStatusKey = nextKey;

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

          if (shieldedStatusRefreshTimer) clearTimeout(shieldedStatusRefreshTimer);
          shieldedStatusRefreshTimer = setTimeout(() => {
            shieldedStatusRefreshTimer = null;
            refreshOverview(send, { force: true })
              .then(() => render())
              .catch(() => {});
          }, 500);

          return;
        }

        if (msg?.type !== "DUSK_UI_TX_STATUS") return;

        const hash = String(msg.hash ?? "");
        const status = String(
          msg.status ?? (msg.ok === false ? "failed" : msg.ok === true ? "executed" : "unknown")
        ).toLowerCase();

        // The Sent screen shows its own transaction's steps; a toast would
        // repeat them. It reads what the watcher reports from state.sent.
        const forSent = noteTxStatus(state.sent, { ...msg, hash, status });
        if (forSent && state.route === "sent") {
          toaster.announce(sentAnnouncement(state.sent, state.overview));
          render().catch(() => {});
        } else if (["executed", "failed", "removed", "mempool", "unknown"].includes(status)) {
          showToast(txStatusToastFor(hash, status));
        }

        // Best-effort immediate UI update so the Activity row can transition
        // without waiting for the next overview refresh.
        try {
          const ov = state.overview;
          if (ov && Array.isArray(ov.txs)) {
            const item = ov.txs.find((t) => String(t?.hash ?? "") === hash);
            if (item) {
              item.status = status;
              if (status === "failed" && msg?.error) item.error = String(msg.error);
            }
          }
        } catch {
          // ignore
        }

        // Pulse the activity row for a short time.
        state.txPulse = {
          hash,
          kind: status === "failed" ? "bad" : status === "executed" ? "ok" : "pending",
          at: Date.now(),
        };
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
        // The archive has it once its block is final: ask once, a little later.
        if (status === "executed" || status === "failed") refreshActivitySoon({ state, render });
      } catch {
        // ignore
      }
    };
    // The desktop app's wallet runs in this page and tells it with events.
    window.addEventListener(WALLET_MESSAGE_EVENT, (event) => onWalletMessage(event?.detail));
    ext?.runtime?.onMessage?.addListener(onWalletMessage);
  } catch {
    // ignore
  }
}

installTxStatusListener();

// --- Auto-lock activity ------------------------------------------------------
// The wallet is in use while someone uses it: the popup opening, then a
// press or a key in it, at most one ping every 30 seconds. An open popup
// nobody touches locks after the timeout, as a closed one does.
const ACTIVITY_PING_MS = 30_000;
let lastActivityPing = 0;

function pingActivity() {
  const now = Date.now();
  if (now - lastActivityPing < ACTIVITY_PING_MS) return;
  lastActivityPing = now;
  send({ type: "DUSK_UI_ACTIVITY" }).catch(() => {});
}

pingActivity();
for (const type of ["pointerdown", "keydown"]) {
  document.addEventListener(type, pingActivity, { passive: true, capture: true });
}

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

      // From now on, before the wallet answers or the overview is read again.
      switchContext(state);
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
      // Still on its network: the menu names it on the pill again.
      return false;
    }
  },
});

// --- Account menu --------------------------------------------------------
const acctMenu = createAccountMenuController({
  onSelectAccountIndex: async (index) => {
    try {
      acctMenu.close();
      switchContext(state);
      const resp = await send({ type: "DUSK_UI_SET_ACCOUNT_INDEX", index });
      if (isWalletLockedResponse(resp)) {
        applyLockedOverviewPatch();
        await render({ forceRefresh: true });
        return;
      }
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to switch profile");
      if (!resp?.ok) throw new Error("Failed to switch profile");

      showToast("Profile selected.");
      state.needsRefresh = true;
      await render({ forceRefresh: true });
    } catch (e) {
      if (isWalletLockedResponse(e)) {
        applyLockedOverviewPatch();
        await render({ forceRefresh: true });
        return;
      }
      showToast(e?.message ?? String(e));
    }
  },
  onOpenOptions: async () => {
    acctMenu.close();
    netMenu.close();
    state.route = "options";
    await render();
  },
  onCopy: showToast,
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
    // This keeps Settings/etc. consistent and avoids surprising jumps.
    try {
      const r = String(state?.route ?? "");
      if (r) qs.set("route", r);

      // Preserve tx details if we're currently looking at a tx, with the
      // page it was opened from: the sidebar marks it, and Back goes there.
      if (r === "tx" && state?.txDetailHash) {
        qs.set("hash", String(state.txDetailHash));
        if (state?.txDetailFrom) qs.set("from", String(state.txDetailFrom));
      }

      // Preserve transaction highlight (used when opened from a notification).
      if ((r === "home" || r === "activity") && state?.highlightTx) {
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
  onOpenOptions,
  onExpand,
});

// Contacts belong to one wallet. A reset, or another wallet unlocked here,
// starts their state over, a form being filled in included. A lock drops
// what the page read with their key, which is read again once the same
// wallet is unlocked.
function keepContactsToTheirWallet(ov) {
  const wallet = ov?.isUnlocked ? String(ov?.accounts?.[0] ?? "").trim() : "";
  const otherWallet = Boolean(wallet && state.contactsWallet && wallet !== state.contactsWallet);
  if (ov?.hasVault === false || otherWallet) {
    state.addressBook = emptyAddressBook();
    state.contactsWallet = "";
  } else if (!ov?.isUnlocked && (state.addressBook?.items || state.addressBook?.error)) {
    state.addressBook = { ...state.addressBook, loaded: false, loading: false, error: null, items: null };
  }
  if (wallet) state.contactsWallet = wallet;
}

// --- Main render ----------------------------------------------------------
export async function render({ forceRefresh = false } = {}) {
  // Deposits to DuskEVM seen there before, for Activity's rows.
  await loadArrivals();
  const overviewRefreshed = await refreshOverview(send, { force: forceRefresh });
  if (overviewRefreshed && state.staking) {
    state.staking.loaded = false;
    state.staking.error = null;
  }
  if (overviewRefreshed && state.sozu) {
    state.sozu.loaded = false;
    state.sozu.error = null;
  }
  const ov = state.overview;
  if (overviewRefreshed) {
    await maybeAutoWatchDashboardStDusk(ov);
  }
  keepContactsToTheirWallet(ov);
  try {
    document.body.dataset.walletReady = ov?.hasVault && ov?.isUnlocked ? "true" : "false";
  } catch {
    // ignore
  }

  // Always render header actions based on latest overview
  renderHeader(ov);
  updateFullNav();

  // Keep shielded sync progress visible while on the dashboard.
  scheduleShieldedPoll(ov);
  schedulePendingTxPoll(ov);
  scheduleArrivalCheck(ov);
  // The account's history: kept rows now, one sync per popup and account.
  ensureActivity(ov, { state, render, send });

  // `refresh` is the dashboard's Refresh, next to the balance.
  const actions = {
    send,
    render,
    showToast,
    refresh: onRefresh,
    announce: (text) => toaster.announce(text),
    // The header alone, for a change only it shows, such as a profile's label.
    renderHeader: () => renderHeader(state.overview),
  };

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
    const screen = state.route === "restore" ? "restore" : "unlock";
    const children =
      activeLockedView && activeLockedScreen === screen
        ? activeLockedView
        : screen === "restore"
        ? restoreWalletView({ state, actions })
        : lockedView({ state, actions });
    setApp(children);
    activeLockedView = children;
    activeLockedScreen = screen;
    return;
  }

  // Unlocked routes. A restore that another window's unlock overtook goes home.
  if (state.route === "restore") state.route = "home";
  // After Confirm: the transaction's steps. Without one (a new popup), home.
  if (state.route === "sent") {
    if (state.sent) {
      setApp(sentView(ov, { state, actions }));
      return;
    }
    state.route = "home";
  }
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
  if (state.route === "sozu_confirm") {
    setApp(sozuConfirmView(ov, { state, actions }));
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
  // Contacts open only unlocked: the wallet's key opens them.
  if (state.route === "contacts") {
    setApp(addressBookView(ov, { state, actions }));
    return;
  }

  // default: home
  setApp(homeView(ov, { state, actions }));
}

export function mountPopup() {
  // A tab the popup opened to save its Activity export saves it now.
  if (!isPopupView) {
    saveHandedExport()
      .then((name) => {
        if (name) showToast("CSV saved");
      })
      .catch((e) => showToast(e?.message ?? String(e), 3000));
  }
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
