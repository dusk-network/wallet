// Popup/Full/Options UI entry.
import { isPopupView, isFullView } from "./env.js";
import { emptyAddressBook, state, ONBOARD_ROUTES } from "./state.js";
import { switchContext } from "./context.js";
import { refreshOverview, getActiveOrigin } from "./overview.js";
import { h, setChildren } from "../lib/dom.js";
import { siteName } from "../lib/strings.js";
import { MOTION } from "../lib/motion.js";
import { screenShown } from "../lib/clickGuard.js";
import { installSystemBack } from "../lib/systemBack.js";
import { installKeyboardRoom } from "../lib/keyboard.js";
import { isPhone } from "../lib/device.js";
import { createToaster } from "../components/Toast.js";
import { balancesHidden } from "../components/Balance.js";
import { ownProfileName } from "../components/ProfileName.js";
import { contactNameText } from "../lib/contactNames.js";
import { txStatusToast } from "./txToast.js";
import { createNetworkMenuController } from "../components/NetworkMenu.js";
import { createAccountMenuController } from "../components/AccountMenu.js";
import { createHeaderRenderer } from "./header.js";
import { send as rawSend } from "../../wallet/bus.js";
import { WALLET_MESSAGE_EVENT } from "../../shared/constants.js";
import { ERROR_CODES } from "../../shared/errors.js";
import { safeBigInt } from "../../shared/amount.js";
import { makeSozuStDuskToken } from "../../shared/sozuAdapter.js";
import { activityKey, activityRows, ensureActivity, lookForPayments, refreshActivitySoon, selected, sozuFactOfSent } from "./activity.js";
import { LOOK_MS } from "./views/requests.js";
import { checkArrivals } from "./arrivals.js";
import { arrivalCheckDelay, awaitingArrival, loadArrivals, payoutOf } from "../../shared/bridgeArrival.js";
import { saveHandedExport } from "./activityExport.js";
import { siteLastSeen } from "../../shared/siteRecords.js";
import { forgetRequestLink, requestDraftOf } from "../lib/requestLink.js";
import { keepOpenSend, takeOpenSend } from "../lib/sendDraft.js";
import { listenForBack, listenForLinks, moveAppToBack, stepBack, steppedAway } from "../../platform/native.js";
import { openedFromNotice } from "../../platform/notices.js";

import { homeView } from "./views/home.js";
import { receiveView } from "./views/receive.js";
import { sendFormView, sendConfirmView } from "./views/send.js";
import { convertFormView, convertConfirmView } from "./views/convert.js";
import { stakeFormView, stakeConfirmView } from "./views/stake.js";
import { sozuConfirmView } from "./views/sozu.js";
import { noteTxStatus, reviewOf, sentAnnouncement, sentIsFinal, sentStatus, sentView } from "./views/sent.js";
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
import { changePasswordView, recoveryPhraseView, removeWalletView, resetWalletView, sendPasswordView } from "./views/wallets.js";
import { cancelSendPassword } from "../components/SendPasswordDialog.js";
import { getRuntimeKind, isExtensionRuntime, isTauriRuntime } from "../../platform/runtime.js";
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
  // A phone shows the popup as a page of its own (Firefox for Android): it fills it.
  if (isPopupView && isPhone()) {
    document.body.dataset.phone = "true";
  }
} catch {
  // ignore
}

const app = document.getElementById("app");
const headerActionsHost = document.getElementById("header-actions");
// Toasts live outside #app, which scrolls and is redrawn.
const toaster = createToaster();
const fullNav = document.querySelector(".full-nav");
const ext = getExtensionApi();
// On a phone, what's typed in stays above the keyboard (keyboard.js).
const keyboard = installKeyboardRoom();

function isWalletLockedResponse(value) {
  const err = value?.error ?? value;
  const message = String(err?.message ?? err ?? "");
  return /wallet locked/i.test(message);
}

// The screens of a wallet being added, removed, or a new password: unlocked only.
const WALLET_ROUTES = new Set(["wallet_add", "wallet_add_phrase", "wallet_add_confirm", "wallet_add_import", "wallet_remove", "change_password", "send_password", "recovery_phrase"]);

// The screen Settings or Add wallet opens from, for its Back to return to:
// home from Settings' own pages and a setup.
function cameFrom() {
  const route = String(state.route || "home");
  return route === "options" || WALLET_ROUTES.has(route) || ONBOARD_ROUTES.has(route) ? "home" : route;
}

function openSettings() {
  if (state.route !== "options") state.optionsFrom = cameFrom();
  state.route = "options";
}

// Where the unlock after a lock returns to: the screen locked on, but for a
// wallet form, whose words and passwords a lock drops: the screen it was
// opened from, Settings or Add wallet's.
function afterLock(route) {
  if (!WALLET_ROUTES.has(route)) return route;
  return route.startsWith("wallet_add") ? state.onboard?.from || "home" : "options";
}

function applyLockedOverviewPatch() {
  try {
    // Locked here or elsewhere: whatever began unlocked is for nothing now;
    // but where the lock's own unlock returns to (leave), which is this lock's.
    const returning = state.returnTo?.context === state.context;
    switchContext(state, "lock");
    if (returning) state.returnTo.context = state.context;
    acctMenu.close();
    cancelSendPassword();
    stopArrivalChecks();
    // A wallet being added keeps nothing of its new phrase through a lock.
    state.route = afterLock(state.route);
    if (state.onboard?.adding) state.onboard = { mode: null, mnemonic: null, password: "", reveal: false };
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

// Whose stDUSK discovery it is: one wallet's (its first public account), on
// one network, for one profile and pool token.
function stDuskWatchKey(ov, profileIndex, contractId) {
  return [
    String(ov?.accounts?.[0] ?? ""),
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
      walletId: String(ov.accounts?.[0] ?? ""),
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
    }, MOTION.base + 50);
  } catch {
    // ignore
  }
}

// A view that comes up at once: no rise, not even one the screen before it
// still had under way.
function stopViewAnimation() {
  if (viewAnimTimer) clearTimeout(viewAnimTimer);
  viewAnimTimer = null;
  app?.classList.remove("view-animate");
}

// The Reviews: they, and the steps either side of them, come up at once, as
// Send's do, never half faded in, when a faded Confirm would read as off.
const REVIEW_ROUTES = new Set(["confirm", "convert_confirm", "stake_confirm", "sozu_confirm", "asset_token_confirm"]);

// The screen last shown, locked or not: a new one starts its confirm's click guard.
let lastShown = "";

// Retain the mounted unlock nodes, not a password copy in application state:
// the unlock form's, or the restore's ("unlock" | "restore").
let activeLockedView = null;
let activeLockedScreen = "";
// The screen last drawn, to start a new one at its top.
let lastScreen = "";
// The nodes #app shows: drawn again as the same nodes (the unlock form, a
// kept wallet form), a screen stays as it is.
let mounted = null;

// A wallet form being filled in (Add wallet's words and password, Remove
// wallet, Change password) stays mounted through redraws that aren't about
// it, as the unlock form does: what's typed, and a submit under way, stay.
// Another screen, another wallet or a lock drops it, with what was typed;
// but not while its own submit runs (`busy`), whose doing a wallet change
// may be.
let keptForm = null;

// The fields that hold a secret: a recovery phrase's words, and passwords.
const SECRET_FIELDS = '.mnemonic-input input, input[type="password"]';

// The context the screen shown was drawn in (context.js).
let mountedContext;

// A field being typed in: focused on the screen, typed in moments ago or
// with a phone's keyboard composing in it. Swapped for its twin under the
// typing, as a redraw does, a phone's keyboard loses what it's composing:
// letters go, or come in another order. A redraw of the same screen waits
// till the typing stops (setApp), and is drawn then from what's read.
const TYPING_SETTLES_MS = 700;
let typedAt = 0;
let composing = false;
let redrawTimer = null;
const typingField = (el) =>
  Boolean(el && app?.contains?.(el)) &&
  !el.readOnly &&
  !el.disabled &&
  (el.localName === "textarea" || (el.localName === "input" && /^(text|search|email|url|tel|password|number)$/.test(String(el.getAttribute?.("type") ?? "text"))));
function typingNow() {
  return typingField(document.activeElement) && (composing || Date.now() - typedAt < TYPING_SETTLES_MS);
}
function redrawOnceTyped() {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => {
    redrawTimer = null;
    if (typingNow()) redrawOnceTyped();
    else render({ cached: true }).catch(() => {});
  }, TYPING_SETTLES_MS);
}
try {
  document.addEventListener("input", (e) => {
    if (typingField(e?.target)) typedAt = Date.now();
  }, true);
  document.addEventListener("compositionstart", (e) => {
    if (typingField(e?.target)) composing = true;
  }, true);
  document.addEventListener("compositionend", () => {
    composing = false;
    typedAt = Date.now();
  }, true);
  document.addEventListener("focusout", () => {
    composing = false;
  }, true);
} catch {
  // ignore
}

function wipeForm(form) {
  for (const node of form?.children ?? []) {
    for (const field of node.querySelectorAll?.("input, textarea") ?? []) field.value = "";
  }
}

function keepForm(build) {
  const kept = keptForm;
  if (kept && kept.route === state.route) {
    if (kept.children.busy?.()) kept.context = state.context;
    if (kept.context === state.context) return kept.children;
  }
  wipeForm(kept);
  keptForm = { route: state.route, context: state.context, children: build() };
  return keptForm.children;
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

      // Home and its full Activity list move without the transition, and so
      // does a step to or from a Review.
      const isHomeTab = (x) => x === "home" || x === "activity";
      const isReviewStep = REVIEW_ROUTES.has(prev) || REVIEW_ROUTES.has(r);
      if (!(isHomeTab(prev) && isHomeTab(r)) && !isReviewStep) {
        pulseViewAnimation();
      } else {
        stopViewAnimation();
      }
    }
  } catch {
    // ignore
  }

  // A new screen opens at its top, not where the last one was scrolled to.
  let sameScreen = false;
  try {
    const screen = `${state?.route ?? ""}|${state?.route === "stake" ? state?.staking?.screen ?? "" : ""}`;
    // A Review's Confirm ignores clicks for a moment once it's up, after an
    // unlock too, whose button sits where Confirm does; never on a redraw.
    const shown = `${state?.overview?.isUnlocked === false ? "locked" : ""}|${screen}`;
    // The same screen, for the same wallet, profile and network, drawn again
    // while a field on it is typed in: it's drawn once the typing stops.
    if (children !== mounted && shown === lastShown && state?.context === mountedContext && typingNow()) {
      redrawOnceTyped();
      return;
    }
    if (shown !== lastShown) {
      lastShown = shown;
      screenShown();
    }
    sameScreen = screen === lastScreen;
    if (!sameScreen) {
      lastScreen = screen;
      keyboard.reset();
      const scroller = app.closest?.(".panel-content");
      if (scroller) scroller.scrollTop = 0;
      // The full view scrolls the page itself.
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    }
  } catch {
    // ignore
  }

  if (children !== mounted) {
    // Redrawn in place (a watcher event, a refresh), the screen keeps the
    // focus on the same button or field, and a field its caret.
    const focused = sameScreen ? focusedControl() : null;
    // A recovery word or a password typed on the screen going goes first,
    // before the screen does: nothing of it stays in the page. One the new
    // screen keeps (a kept form) stays as it is.
    for (const field of app.querySelectorAll(SECRET_FIELDS)) {
      if (!children.some((child) => child?.contains?.(field))) field.value = "";
    }
    activeLockedView = null;
    if (keptForm && keptForm.children !== children) {
      wipeForm(keptForm);
      keptForm = null;
    }
    app.innerHTML = "";
    const siteBar = activeSiteBar(state.overview);
    if (siteBar) app.appendChild(siteBar);
    for (const child of children) app.appendChild(child);
    mounted = children;
    mountedContext = state?.context;
    if (focused) refocusControl(focused);
  }
  // Another screen than a request's own: the link the page opened with was
  // left, or paid, and goes from its address; and what a link or a QR code
  // filled in goes with it, not the next Send's.
  if (!onLinksScreens()) {
    forgetRequestLink();
    if (state.draft?.filledIn) state.draft = null;
  }
  systemBack.sync();
}

// A request's screens: its Send, the Review and Sent after it, and Contacts
// picking its recipient. A lock leaves the route as it was; one as the app is
// left (leave) asks the password on Home, to return to the screen left, which
// is still the request's.
function onLinksScreens() {
  const left = state.returnTo?.context === state.context ? state.returnTo.route : null;
  const requests = (route) => ["send", "confirm", "sent"].includes(route) || (route === "contacts" && state.addressBook?.mode === "pick");
  return requests(state.route) || requests(left);
}

// The focused control in #app (a button, a disclosure or a field), by its
// words and its place among those with the same words; a field also by its
// name and placeholder, and with its caret, so typing goes on where it was.
const FOCUS_KEPT = "button, summary, input, select, textarea";

function focusedControl() {
  try {
    const el = document.activeElement;
    if (!el || !el.matches?.(FOCUS_KEPT) || !app.contains(el)) return null;
    // A Copy button saying Copied is still called by its own name (data-label).
    const key = (b) =>
      [b.tagName, b.textContent, b.getAttribute("data-label") ?? b.getAttribute("aria-label") ?? "", ...["name", "placeholder", "type"].map((a) => b.getAttribute(a) ?? "")].join("\n");
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
  // A site that never asked the wallet for anything gets no Connect of its own.
  const record = ov?.siteRecords?.[String(ov?.accounts?.[0] ?? "")]?.[origin];
  if (!ov?.activeConnected && !siteLastSeen(record)) return null;

  // As its approval named it: "http://127.0.0.1:5354", "app.dusk.network".
  return {
    origin,
    host: siteName(origin),
    connected: Boolean(ov?.activeConnected),
  };
}

// Screens that move money, or say what moved: no Connect over them, where a
// stray press on a phone connects whatever site is open.
const NO_SITE_BAR = new Set([...REVIEW_ROUTES, "send", "convert", "stake", "asset_token", "sent", "send_password"]);

function activeSiteBar(ov) {
  if (!ov?.isUnlocked || NO_SITE_BAR.has(state.route)) return null;
  const site = activeSiteInfo(ov);
  if (!site) return null;

  const btn = h("button", {
    class: site.connected ? "btn-outline site-bar-action" : "btn-primary site-bar-action",
    text: site.connected ? "Disconnect" : "Connect",
    onclick: async () => {
      try {
        // For the wallet the bar was drawn for, or for none. Connect asks in
        // the site's approval first, as the site's own request does.
        const answer = send({
          type: site.connected ? "DUSK_UI_DISCONNECT_ORIGIN" : "DUSK_UI_CONNECT_ORIGIN",
          origin: site.origin,
          walletId: String(ov.accounts?.[0] ?? ""),
        });
        // On a phone the approval opens in a tab this page covers: it goes.
        if (!site.connected && document.body?.dataset?.phone === "true") {
          window.close();
          return;
        }
        const res = await answer;
        // Rejected in the approval: nothing to say.
        if (res?.error?.code === ERROR_CODES.USER_REJECTED) return;
        if (res?.error) throw new Error(res.error.message ?? "Couldn't change the site's connection");
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
      ? await checkArrivals(activityRows(now, state), { walletId: now?.accounts?.[0], account: selected(now).account, archiverUrl: now?.archiverUrl, nodeUrl: now?.nodeUrl }).catch(() => 0)
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
    return contactNameText(contacts.find((c) => String(c?.address ?? "").toLowerCase() === key)?.name) || ownProfileName(ov, addr);
  };
  const onView = hash
    ? () => {
        state.txDetailHash = hash;
        state.txDetailFrom = state.route === "activity" ? "activity" : "home";
        state.route = "tx";
        render().catch(() => {});
      }
    : null;
  const row = hash ? activityRows(ov, state).find((r) => String(r?.hash ?? "") === hash) : null;
  const onItsWayTo = payoutOf(row) ? row.route.chain.name : "";
  return txStatusToast(tx, status, { hidden: balancesHidden(ov), contactName, onItsWayTo, onView });
}

// Sends this page heard came to their end, in their block or failed: a later
// word that one's still on its way, from a lookup that couldn't ask the node
// (the app back from away, its network not back yet), isn't news. Nor is the
// word it heard last of a send, said again by its next lookup: its toast
// shows once (`heardTxs`).
const endedTxs = new Set();
const heardTxs = new Map();
const endedStatus = (status) => status === "executed" || status === "failed";

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

        // Another wallet unlocked, here or in another window: whatever began
        // on the one before is for nothing now.
        if (msg?.type === "DUSK_UI_WALLET_CHANGED") {
          switchContext(state);
          // A menu still open shows the wallet before: it goes.
          acctMenu.close();
          cancelSendPassword();
          state.needsRefresh = true;
          render({ forceRefresh: true }).catch(() => {});
          return;
        }

        // A wallet removed or renamed, here or in another window: the list
        // is read again, and a menu showing the old one goes.
        if (msg?.type === "DUSK_UI_WALLETS_CHANGED") {
          acctMenu.close();
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

        // A payment from Send waits for the network, or is tried again as it
        // answers: its Sent screen says so, with Cancel while it waits, and
        // Home lists it.
        if (msg?.type === "DUSK_UI_SEND_WAITING") {
          const sent = state.sent;
          if (sent?.sendId && sent.sendId === msg.sendId && sent.phase === "sending" && sent.waits !== Boolean(msg.waits)) {
            sent.waits = Boolean(msg.waits);
            if (state.route === "sent") {
              toaster.announce(sentAnnouncement(sent, state.overview));
              render({ cached: true }).catch(() => {});
            }
          }
          state.needsRefresh = true;
          if (state.route === "home") render({ forceRefresh: true }).catch(() => {});
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
        const record = hash && Array.isArray(state.overview?.txs) ? state.overview.txs.find((t) => String(t?.hash ?? "") === hash) : null;
        if (!endedStatus(status) && (endedTxs.has(hash) || endedStatus(String(record?.status ?? "")))) return;
        if (hash && endedStatus(status)) endedTxs.add(hash);
        const news = !hash || heardTxs.get(hash) !== status;
        if (hash) heardTxs.set(hash, status);

        // The Sent screen shows its own transaction's steps; a toast would
        // repeat them. It reads what the watcher reports from state.sent.
        const forSent = noteTxStatus(state.sent, { ...msg, hash, status });
        if (forSent && state.route === "sent") {
          toaster.announce(sentAnnouncement(state.sent, state.overview));
          render().catch(() => {});
        } else if (news && ["executed", "failed", "removed", "mempool", "unknown"].includes(status)) {
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
        // Through render, which reads staking again along with the overview.
        state.needsRefresh = true;
        setTimeout(() => {
          render({ forceRefresh: true }).catch(() => {});
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

// --- The connection -------------------------------------------------------
// Offline, as the browser says at once: the header and Home say so, the
// balance read last staying. Back online: read again at once, not at the next
// turn, and the node checked again, for the header not to go on with what a
// check said while offline. A balance the node couldn't give, online, is read
// again 30 seconds on.
const BALANCE_RETRY_MS = 30_000;
let balanceRetryTimer = null;
function scheduleBalanceRetry(ov) {
  clearTimeout(balanceRetryTimer);
  balanceRetryTimer = null;
  if (!ov?.isUnlocked || !ov?.balanceError || globalThis.navigator?.onLine === false) return;
  balanceRetryTimer = setTimeout(() => {
    balanceRetryTimer = null;
    render({ forceRefresh: true }).catch(() => {});
  }, BALANCE_RETRY_MS);
}
// A Review holds its Confirm while offline by itself (offline.js): drawn
// again, it would lose a fee being edited. The header says it all the same.
async function renderForConnection(opts) {
  if (!REVIEW_ROUTES.has(state.route)) return render(opts);
  await refreshOverview(send, { force: Boolean(opts?.forceRefresh) });
  renderHeader(headerOf(state.overview));
}
try {
  window.addEventListener("offline", () => renderForConnection().catch(() => {}));
  window.addEventListener("online", () => {
    renderForConnection({ forceRefresh: true }).catch(() => {});
    send({ type: "DUSK_UI_CHECK_NETWORK" })
      .then(() => renderForConnection({ forceRefresh: true }))
      .catch(() => {});
    resumeWatching();
  });
} catch {
  // ignore
}

// A node can stop answering without an error, and between reads, minutes
// apart, nothing else would find it silent: while an unlocked wallet shows and
// the browser is online, the node is asked whether it answers, at once and
// every 15 seconds. What came of it shows at once, without a read that may
// hang; once it answers again, the balance is read again.
const ASK_NODE_EVERY_MS = 15_000;
let askNodeTimer = null;
let askingNode = false;

async function askNode() {
  const ov = state.overview;
  if (askingNode || !ov?.isUnlocked || !ov?.nodeUrl || document.visibilityState === "hidden" || globalThis.navigator?.onLine === false) return;
  // One ask at a time, over once the node answers or the ask gives up: never held by a read.
  askingNode = true;
  let answer = null;
  try {
    answer = (await send({ type: "DUSK_UI_CHECK_NODE" }).catch(() => null))?.networkStatus;
  } finally {
    askingNode = false;
  }
  const now = state.overview;
  // About the node shown still, and saying otherwise than it shows.
  if (!answer?.nodeStatus || !now || answer.nodeUrl !== now.nodeUrl || answer.nodeStatus === now.networkStatus?.nodeStatus) return;
  const was = now.networkStatus?.nodeStatus;
  now.networkStatus = { ...now.networkStatus, ...answer };
  // The balance shown was read before the node stopped answering: maybe out
  // of date, also once it answers again, till a balance read since takes its
  // place (refreshOverview's overview has its own say).
  if ((was === "offline" || answer.nodeStatus === "offline") && now.balance?.value) now.balanceStale = true;
  // Drawn again from what's read already, as a read under way may never end (a Refresh pressed while the node holds it).
  if (answer.nodeStatus === "online") reconnectingUntil = 0;
  if (REVIEW_ROUTES.has(state.route)) renderHeader(headerOf(now));
  else await render({ cached: true });
  // Back: the balance read again, without waiting for it here.
  if (answer.nodeStatus === "online") renderForConnection({ forceRefresh: true }).catch(() => {});
}

function scheduleNodeAsk(ov) {
  if (!ov?.isUnlocked) {
    clearInterval(askNodeTimer);
    askNodeTimer = null;
    return;
  }
  if (askNodeTimer) return;
  askNodeTimer = setInterval(() => askNode().catch(() => {}), ASK_NODE_EVERY_MS);
  setTimeout(() => askNode().catch(() => {}), 0);
}

// --- Coming back to the wallet ----------------------------------------------
// A phone stops the page, and with it what was following a send, once the
// wallet is left (Home, another app, no signal): the send may have gone into a
// block meanwhile, unheard. Back, each send still on its way is looked up by
// its ID at once, then every 10 seconds while one is, for 3 minutes.
const RESUME_EVERY_MS = 10_000;
const RESUME_FOR_MS = 180_000;
// Sends older than this aren't looked for: Activity has them.
const RESUME_SENT_WITHIN_MS = 60 * 60_000;
let resumeTimer = null;
let resumeUntil = 0;

function sendsOnTheirWay() {
  const ov = state.overview;
  if (!ov?.isUnlocked) return [];
  const hashes = new Set();
  // The Sent screen's, on its way or handed over without a clear answer; or
  // in its block without its fee read, as when the node didn't answer then.
  if (state.route === "sent" && state.sent?.hash && (!sentIsFinal(state.sent, ov) || state.sent.phase === "unconfirmed" || sentFeeUnread(state.sent, ov))) {
    hashes.add(String(state.sent.hash));
  }
  for (const tx of Array.isArray(ov.txs) ? ov.txs : []) {
    const status = String(tx?.status ?? "").toLowerCase();
    // In its block without its fee, as a notice's news has it (DUSK_UI_TX_NOTICED): its fee is looked up.
    const feeUnread = (status === "executed" || status === "failed") && tx?.feePaid == null;
    if ((["submitted", "mempool", "unknown"].includes(status) || feeUnread) && Date.now() - Number(tx?.submittedAt ?? 0) < RESUME_SENT_WITHIN_MS) {
      hashes.add(String(tx?.hash ?? ""));
    }
  }
  return [...hashes].filter(Boolean).slice(0, 5);
}

async function lookUpSends() {
  clearTimeout(resumeTimer);
  resumeTimer = null;
  const hashes = sendsOnTheirWay();
  if (!hashes.length) return;
  const answers = await Promise.all(hashes.map((hash) => send({ type: "DUSK_UI_RECHECK_TX", hash }).catch(() => null)));
  // Looked up: what the node said shows from here on. A node that couldn't
  // be asked yet, as just back from away, said nothing: the Sent screen goes
  // on saying it's being looked up, never that it's taking long.
  const at = state.sent?.hash ? hashes.indexOf(String(state.sent.hash)) : -1;
  const own = at >= 0 ? answers[at] : undefined;
  if (state.sent && (at < 0 || (own && !own.error && !own.result?.error))) state.sent.lookingUp = false;
  state.needsRefresh = true;
  await renderForConnection({ forceRefresh: true }).catch(() => {});
  if (Date.now() < resumeUntil && document.visibilityState !== "hidden" && sendsOnTheirWay().length) {
    resumeTimer = setTimeout(lookUpSends, RESUME_EVERY_MS);
  }
}

function resumeWatching() {
  resumeUntil = Date.now() + RESUME_FOR_MS;
  lookUpSends().catch(() => {});
}

// A completed send on the Sent screen whose fee isn't read yet.
function sentFeeUnread(sent, ov) {
  const { phase, status, feePaid } = sentStatus(sent, ov);
  return phase === "sent" && (status === "executed" || status === "failed") && feePaid == null;
}

// The Sent screen's send is followed by the wallet's watcher, which can go
// quiet when the connection dropped and came back: from 20 seconds after it
// went, it's looked up by its ID too, every 10 seconds for 3 minutes, till
// it's in its block with its fee (lookUpSends).
const SENT_LOOKED_UP_AFTER_MS = 20_000;
let followedSend = "";
function followSent() {
  const sent = state.sent;
  if (state.route !== "sent" || sent?.phase !== "sent" || !sent.hash || followedSend === sent.hash) return;
  followedSend = sent.hash;
  const went = Number(sent.sentAt) || Date.now();
  resumeUntil = Math.max(resumeUntil, went + RESUME_FOR_MS);
  if (resumeTimer) return;
  resumeTimer = setTimeout(() => lookUpSends().catch(() => {}), Math.max(0, went + SENT_LOOKED_UP_AFTER_MS - Date.now()));
}

// Back in front, the balance, the shielded sync and the history are read
// again at once, as Refresh does: a send made meanwhile, money that came in,
// or a sync the phone stopped, shows as it is.
function comeBack() {
  state.needsRefresh = true;
  // A phone cut the page's network while it was away: it reconnects first.
  reconnectingUntil = Date.now() + RECONNECT_MS;
  // Said at once, from what's read: the network being checked, never what
  // was said of it while away; a send on Sent being looked up.
  renderHeader(headerOf(state.overview));
  lookingUpOnLeave();
  setTimeout(() => askNode().catch(() => {}), 0);
  setTimeout(() => renderHeader(headerOf(state.overview)), RECONNECT_MS + 50);
  renderForConnection({ forceRefresh: true })
    .then(() => lookForPayments(state.overview, { state, render }))
    .catch(() => {});
  resumeWatching();
}

// --- Money coming in ----------------------------------------------------------
// While Home or Activity shows an unlocked wallet, its balance and its history
// are read again every 30 seconds, as Receive's requests look for a payment
// (requests.js): money that came in shows by itself, on Home and in Activity
// alike. Once the balance moved, however it was read, the history is read
// again at once, and both every 10 seconds for a minute: the history lists a
// payment once its block is final, a moment after the balance has it. Away
// from the wallet (another app, the phone's Home) nothing is read; back, at
// once (comeBack).
const FOLLOW_ROUTES = new Set(["home", "activity"]);
const CATCH_UP_EVERY_MS = 10_000;
const CATCH_UP_FOR_MS = 60_000;
let followTimer = null;
let following = false;
let catchUpUntil = 0;
// The balances last read, with the profile and node they're of.
let balancesSeen = "";

// What the balances are: one that moved changes it.
const balancesOf = (ov) => [ov?.balance?.value, ov?.shieldedBalance?.value, ov?.staked?.lux].map((value) => String(value ?? "")).join("|");

// A balance read that moved since the last one, for the same profile on the
// same node: the history is read for what moved it, and followed closely a minute.
function noteBalances(ov) {
  const key = ov?.isUnlocked ? activityKey(ov) : "";
  const seen = key ? `${key}\n${balancesOf(ov)}` : "";
  const moved = Boolean(key && balancesSeen.startsWith(`${key}\n`) && seen !== balancesSeen);
  balancesSeen = seen;
  if (!moved) return;
  catchUpUntil = Date.now() + CATCH_UP_FOR_MS;
  // The next read comes sooner: the one set for later goes.
  clearTimeout(followTimer);
  followTimer = null;
  lookForPayments(ov, { state, render });
}

const followable = () =>
  Boolean(state.overview?.isUnlocked) && FOLLOW_ROUTES.has(state.route) && document.visibilityState !== "hidden" && globalThis.navigator?.onLine !== false;

async function follow() {
  followTimer = null;
  if (following || !followable()) return;
  following = true;
  try {
    state.needsRefresh = true;
    await render({ forceRefresh: true });
    lookForPayments(state.overview, { state, render });
  } finally {
    following = false;
  }
  scheduleFollow(state.overview);
}

// One read at a time, the next once it's over: a node that holds a read
// never piles them up.
function scheduleFollow(ov) {
  if (followTimer || following || !ov?.isUnlocked || !FOLLOW_ROUTES.has(state.route)) return;
  followTimer = setTimeout(() => follow().catch(() => {}), Date.now() < catchUpUntil ? CATCH_UP_EVERY_MS : LOOK_MS);
}

// Back in front after a phone cut the page's network, the wallet reconnects:
// till the node answers, 10 seconds at most, the header says it's checking,
// never that the network can't be reached, from what was read while away.
const RECONNECT_MS = 10_000;
let reconnectingUntil = 0;
function headerOf(ov) {
  if (Date.now() >= reconnectingUntil || ov?.networkStatus?.nodeStatus !== "offline" || globalThis.navigator?.onLine === false) return ov;
  return { ...ov, networkStatus: { ...ov.networkStatus, nodeStatus: "checking" } };
}

// A send on its way when the wallet is left: the Sent screen says it's looked
// up again, drawn at once from what it has, so that coming back never first
// shows the wait for a block that may have come meanwhile. The lookup's answer
// takes its place (lookUpSends).
let drawn = null;
function lookingUpOnLeave() {
  const sent = state.sent;
  if (state.route !== "sent" || !sent?.hash || !drawn || sentIsFinal(sent, state.overview)) return;
  sent.lookingUp = true;
  try {
    setApp(sentView(state.overview, { state, actions: drawn }));
  } catch {
    // The next draw says it.
  }
}

// The app on a phone, with Lock when I leave the app on: locked as the person
// leaves it, unless the wallet itself sent them elsewhere for a moment. Back,
// they're asked the password, as after Lock wallet, and return to the screen
// they left, with what they typed on it.
function leave() {
  const ov = state.overview;
  if (!appBack || !ov?.isUnlocked || ov?.lockOnLeave !== true || steppedAway()) return;
  switchContext(state, "lock");
  // The unlock first, wherever they were: Settings would show locked.
  state.returnTo = { route: afterLock(state.route), context: state.context };
  state.route = "home";
  send({ type: "DUSK_UI_LOCK" }).catch(() => {});
}

// Unlocked again after leaving: back where they were, unless something
// switched since (another wallet, a restore). Sends left on their way are
// looked up again, as they couldn't be while it was locked.
let wasUnlocked = null;
function returnAfterUnlock(ov) {
  const unlocked = Boolean(ov?.isUnlocked);
  const unlockedNow = unlocked && wasUnlocked === false;
  wasUnlocked = unlocked;
  const back = state.returnTo;
  if (back && unlocked) {
    state.returnTo = null;
    if (back.context === state.context && state.route === "home") state.route = back.route;
  }
  if (unlockedNow) setTimeout(resumeWatching, 0);
}

// The app on the way to the background with Send, or its Review, open: what's
// typed is kept on the phone as Send left open, for Android may end the app
// meanwhile; the app opens on it again, once unlocked (reopenSend). Back in
// front, the app wasn't ended: it's a draft as any other again.
let openSendKept = false;
function keepSendOpen() {
  if (!isTauriRuntime() || !state.overview?.isUnlocked || !["send", "confirm"].includes(state.route)) return;
  keepOpenSend(state.draft, state.overview);
  openSendKept = true;
}
let sendReopened = false;
function reopenSend(ov) {
  if (!isTauriRuntime() || !ov?.isUnlocked) return;
  if (!sendReopened) {
    sendReopened = true;
    const values = takeOpenSend(ov);
    if (values && state.route === "home") Object.assign(state, { route: "send", draft: values });
    return;
  }
  if (openSendKept && document.visibilityState !== "hidden") {
    openSendKept = false;
    takeOpenSend(ov);
  }
}

try {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      keepSendOpen();
      lookingUpOnLeave();
      leave();
      return;
    }
    stepBack();
    comeBack();
  });
  window.addEventListener("pageshow", (event) => {
    if (event?.persisted) resumeWatching();
  });
} catch {
  // ignore
}

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
        openSettings();
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
  // Without the wallets (none listed), a profile of the wallet the menu showed.
  onSelectAccountIndex: async (index, { ov } = {}) => {
    try {
      acctMenu.close();
      switchContext(state);
      const walletId = ov?.isUnlocked ? String(ov.accounts?.[0] ?? "") : "";
      const resp = await send({ type: "DUSK_UI_SET_ACCOUNT_INDEX", index, ...(walletId ? { walletId } : {}) });
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
  // A profile by its wallet's key, as the menu showed it: another wallet's
  // opens that wallet, without the password; the open one's is selected in
  // it, whichever wallet another window opened meanwhile.
  onSelectWalletProfile: async (walletKey, index, { ov } = {}) => {
    try {
      acctMenu.close();
      switchContext(state);
      const resp = await send({ type: "DUSK_UI_SWITCH_WALLET", walletKey, index });
      if (isWalletLockedResponse(resp)) {
        applyLockedOverviewPatch();
        await render({ forceRefresh: true });
        return;
      }
      if (resp?.error) throw new Error(resp.error.message ?? "Couldn't switch wallet");
      showToast(walletKey === ov?.walletKey ? "Profile selected." : "Wallet switched.");
      state.needsRefresh = true;
      await render({ forceRefresh: true });
    } catch (e) {
      showToast(e?.message ?? String(e));
    }
  },
  onAddWallet: async () => {
    acctMenu.close();
    netMenu.close();
    state.onboard = { mode: null, mnemonic: null, password: "", reveal: false, adding: true, from: cameFrom() };
    state.route = "wallet_add";
    await render();
  },
  onOpenOptions: async () => {
    acctMenu.close();
    netMenu.close();
    openSettings();
    await render();
  },
  onCopy: showToast,
});

// --- The phone's Back button ---------------------------------------------------
// One step back inside the wallet: an open menu closes, then a dialog (its
// [data-back]: Cancel or Close), else the screen's own Back.
const overlays = () => Array.from(document.querySelectorAll(".qrscan-overlay"));
function backStep() {
  if (netMenu.isOpen) return () => netMenu.close();
  if (acctMenu.isOpen) return () => acctMenu.close();
  const overlay = overlays().at(-1);
  const control = overlay ? overlay.querySelector("[data-back]") : app?.querySelector(".subnav-back, [data-back]");
  return control && !control.disabled ? () => control.click() : null;
}
// The app on a phone: Android hands the wallet its Back (native.js), and a
// first screen goes to the background, as other apps do, rather than closing
// and asking for the password again. In a browser, through the page's
// history (systemBack.js).
const appBack = isTauriRuntime() && isPhone();
if (appBack) listenForBack(() => (backStep() ?? moveAppToBack)());
const systemBack = appBack
  ? { sync() {} }
  : installSystemBack({
      // Which screen, by its route and its title, and how many dialogs and menus are open.
      screenKey: () =>
        [state.route, app?.querySelector(".subnav-title")?.textContent ?? "", overlays().length, netMenu?.isOpen, acctMenu?.isOpen].join("|"),
      backStep,
      // Import with words typed: its Back asks first.
      asks: () => !overlays().length && !netMenu.isOpen && !acctMenu.isOpen && Boolean(app?.querySelector(".subnav-back[data-back-asks]")),
    });

// --- Header actions -------------------------------------------------------
async function onRefresh() {
  netMenu.close();
  acctMenu.close();
  state.needsRefresh = true;
  await render({ forceRefresh: true });
  // The history too, for Activity to have what the balance has; and a send
  // on its way is looked up again.
  lookForPayments(state.overview, { state, render });
  resumeWatching();
}

async function onOpenOptions() {
  netMenu.close();
  acctMenu.close();
  openSettings();
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
export async function render({ forceRefresh = false, cached = false } = {}) {
  // `cached`: drawn from the overview read already, asking for none.
  const overviewRefreshed = cached ? false : await refreshOverview(send, { force: forceRefresh });
  // Deposits to DuskEVM seen there before, for Activity's rows: the wallet's own.
  await loadArrivals(state.overview?.isUnlocked ? state.overview?.accounts?.[0] : "");
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
  returnAfterUnlock(ov);
  reopenSend(ov);
  try {
    document.body.dataset.walletReady = ov?.hasVault && ov?.isUnlocked ? "true" : "false";
  } catch {
    // ignore
  }

  // Always render header actions based on latest overview
  renderHeader(headerOf(ov));
  updateFullNav();

  // Keep shielded sync progress visible while on the dashboard.
  scheduleShieldedPoll(ov);
  schedulePendingTxPoll(ov);
  scheduleBalanceRetry(ov);
  scheduleNodeAsk(ov);
  scheduleArrivalCheck(ov);
  // The account's history: kept rows now, one sync per popup and account.
  ensureActivity(ov, { state, render, send });
  // A balance that moved has the history read for it.
  if (overviewRefreshed) noteBalances(ov);
  scheduleFollow(ov);

  // What the screen drawn now is for (reviewOf): its wallet, profile and
  // network, and the context. Its handlers act for that wallet alone, however
  // late they run: every message they send names it (`walletId`), and the
  // wallet refuses a change to another wallet's data, or a send from it.
  const review = reviewOf(ov, state);
  const forScreen = (message) =>
    review.walletId && message && typeof message === "object" && !("walletId" in message) ? { ...message, walletId: review.walletId } : message;
  // `refresh` is the dashboard's Refresh, next to the balance.
  const actions = {
    send: (message) => send(forScreen(message)),
    review,
    render,
    showToast,
    refresh: onRefresh,
    announce: (text) => toaster.announce(text),
    // The header alone, for a change only it shows, such as a profile's label.
    renderHeader: () => renderHeader(headerOf(state.overview)),
  };
  drawn = actions;

  // Settings should be accessible even when the wallet is locked or not yet imported.
  // TODO: Reconsider?
  if (state.route === "options") {
    setApp(optionsView(ov, { state, actions }));
    return;
  }
  // Reset, from Settings, locked or not: with no wallet here, Settings.
  if (state.route === "wallet_reset") {
    if (!ov?.hasVault) state.route = "options";
    setApp(ov?.hasVault ? keepForm(() => resetWalletView(ov, { state, actions })) : optionsView(ov, { state, actions }));
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
    // What's typed in stays through redraws that aren't about it (a network
    // check, the phone coming back to the wallet), as an unlocked wallet's forms do.
    if (state.route === "onboard_create_password") {
      setApp(keepForm(() => onboardingCreatePasswordView({ state, actions })));
      return;
    }
    if (state.route === "onboard_create_phrase") {
      setApp(onboardingCreatePhraseView({ state, actions }));
      return;
    }
    if (state.route === "onboard_create_confirm") {
      setApp(keepForm(() => onboardingCreateConfirmView({ state, actions })));
      return;
    }
    if (state.route === "onboard_import") {
      setApp(keepForm(() => onboardingImportView({ state, actions })));
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
  // Another wallet: added with the same screens as the first, and the password.
  if (state.route === "wallet_add") {
    setApp(onboardingWelcomeView({ state, actions, adding: true }));
    return;
  }
  if (state.route === "wallet_add_phrase") {
    setApp(onboardingCreatePhraseView({ state, actions, adding: true, ov }));
    return;
  }
  if (state.route === "wallet_add_confirm") {
    setApp(keepForm(() => onboardingCreateConfirmView({ state, actions, adding: true })));
    return;
  }
  if (state.route === "wallet_add_import") {
    const view = keepForm(() => onboardingImportView({ state, actions, adding: true, ov }));
    // Kept, it says which wallet the phrase becomes by the wallets here now.
    view.landing?.(ov);
    setApp(view);
    return;
  }
  if (state.route === "wallet_remove") {
    // A wallet that went meanwhile, here or in another window, or the only one: Settings.
    const wallets = Array.isArray(ov.wallets) ? ov.wallets : [];
    const there = wallets.length > 1 && wallets.some((w) => w.key === state.walletRemove);
    const view = there ? keepForm(() => removeWalletView(ov, { state, actions })) : [];
    if (!view.length) Object.assign(state, { route: "options", walletRemove: null });
    setApp(view.length ? view : optionsView(ov, { state, actions }));
    return;
  }
  if (state.route === "change_password") {
    setApp(keepForm(() => changePasswordView(ov, { state, actions })));
    return;
  }
  if (state.route === "send_password") {
    setApp(keepForm(() => sendPasswordView(ov, { state, actions })));
    return;
  }
  if (state.route === "recovery_phrase") {
    setApp(keepForm(() => recoveryPhraseView(ov, { state, actions })));
    return;
  }
  // After Confirm: the transaction's steps. Without one (a new popup), home.
  if (state.route === "sent") {
    if (state.sent) {
      followSent();
      // A stake or an unstake with Sozu, completed: what it got or gave back, once its pool's event is read.
      const sozu = state.sent.sozu && state.sent.hash ? sozuFactOfSent(ov, state, state.sent, { render, refresh: () => refreshActivitySoon({ state, render }, 0) }) : undefined;
      setApp(sentView(ov, { state, actions, sozu }));
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

// --- Payment links opened in the app ---------------------------------------------
// A dusk: link from another app, a chat or a QR reader: Send, filled in from it
// as a link pasted into Send fills it, and refused there for another network;
// after the unlock, when the wallet is locked. Send shows at once, from what
// the wallet last read: a phone just woken can take a minute to answer, and
// the balance follows when it does.
listenForLinks((url) => {
  const draft = requestDraftOf(`?link=${encodeURIComponent(url)}`);
  if (!draft) return;
  netMenu.close();
  acctMenu.close();
  Object.assign(state, { draft, route: "send" });
  render()
    .then(() => {
      state.needsRefresh = true;
      return render({ forceRefresh: true });
    })
    .catch(() => {});
});

// --- A notice tapped in the app ----------------------------------------------
// Its send's details, as Activity opens them: after the unlock, when the
// wallet is locked. Asked as the app starts, and each time it's back in front.
// Any app can open the wallet as a notice's tap would: only a tap with the
// token the wallet gave its send's notice opens anything (DUSK_UI_TX_NOTICED).
async function openNoticed() {
  const noticed = isTauriRuntime() && isPhone() ? await openedFromNotice().catch(() => null) : null;
  const hash = noticed?.hash ?? "";
  if (!hash || !noticed.token) return;
  // What the notice knew of it, in its block, on its record before it shows:
  // never "Not confirmed" while the app reconnects. Its fee comes with the lookup.
  const known = await send({ type: "DUSK_UI_TX_NOTICED", hash, token: noticed.token, ...(noticed.status ? { status: noticed.status, blockHeight: noticed.blockHeight } : {}) }).catch(() => null);
  if (!known?.result) return;
  netMenu.close();
  acctMenu.close();
  Object.assign(state, { txDetailHash: hash, txDetailFrom: "home", route: "tx" });
  // At once, from what's read, with the notice's news on it (DUSK_UI_TX_STATUS):
  // a read now could wait seconds on a network still coming back.
  await render({ cached: true });
  state.needsRefresh = true;
  await render({ forceRefresh: true });
}
try {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") openNoticed().catch(() => {});
  });
} catch {
  // ignore
}

export function mountPopup() {
  openNoticed().catch(() => {});
  render()
    // Sends left on their way while the wallet was closed are looked up now.
    .then(() => resumeWatching())
    // A tab the popup opened to make its Activity export makes it now.
    .then(() => (isPopupView ? null : saveHandedExport({ state, render, showToast }).catch((e) => showToast(e?.message ?? String(e), 3000))))
    .catch((e) => {
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
