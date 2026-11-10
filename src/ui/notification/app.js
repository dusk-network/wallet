// The window a site's request opens: the site that asks and what it asks for
// first, then the facts that matter, with Reject and the approve button fixed
// at the bottom where they always show. Chain, node and raw bytes sit under
// Details. A locked wallet shows what is asked, with Unlock and Reject.

import { UI_DISPLAY_DECIMALS, amountLocale, formatDuskExact, formatFee, groupThousands, safeBigInt } from "../../shared/amount.js";
import { bridgeServiceLine, bridgeServiceTransfer, bridgeServiceWarnings, callsBridge } from "../../shared/bridgeCalls.js";
import { bytesToHex, sha256Hex, toBytes } from "../../shared/bytes.js";
import { TX_KIND } from "../../shared/constants.js";
import { getMinimumGas } from "../../shared/txDefaults.js";
import { classifyDuskIdentifier } from "../../shared/duskIdentifiers.js";
import { networkNameFromNodeUrl } from "../../shared/network.js";
import { networkFor } from "@dusk-network/networks";
import { chainIdForNode, chainWords, networkTextOf, noteChainId } from "../../shared/nodeNetwork.js";
import { BLOCKED_TITLE, blockedRecipient } from "../../shared/recipientBlocklist.js";
import { safeText, textChecks, textNeedsReview } from "../../shared/safeText.js";
import { flattenTypedMessage, prepareTypedDataDisclosure, sanitizeStringForDisplay } from "../../shared/typedDataDisplay.js";
import { duskNamesNetwork } from "../../shared/verifiedNames.js";
import { nameCheckNoteEl } from "../components/NameCheckNote.js";
import { contractLabel } from "../../shared/knownCalls.js";
import { DRC20_CALL_NAMES } from "../../shared/drc20Calls.js";
import { syncTestnetStrip } from "../components/TestnetStrip.js";
import { dateText as fullDateText } from "../lib/time.js";
import { h, setChildren } from "../lib/dom.js";
import { guarded, screenShown } from "../lib/clickGuard.js";
import { isPhone } from "../lib/device.js";
import { holdWhileOffline } from "../lib/offline.js";
import { contractIdText, shortAddress, shortEvmAddress } from "../lib/strings.js";
import { fieldError, fieldLabel, passwordInput, submitOnGasEnter, textInput } from "../components/FormControls.js";
import { shortAddressEl } from "../components/ShortAddress.js";
import { contractValueEl } from "../components/ContractValue.js";
import { payGuard } from "../components/NetworkGas.js";
import { numbersText, safeTextEl } from "../components/SafeText.js";
import { sendPasswordRefusal, sendPasswordWhy } from "../components/SendPasswordDialog.js";
import "../components/GasEditor.js";
import {
  amountParts,
  details,
  facts,
  group,
  headTag,
  kv,
  mono,
  note,
  requestHead,
  sectionTitle,
  shortMono,
  siteChip,
  siteDetails,
  warning,
} from "./parts.js";
import { bridgeCallOf, callArgs, requestSummary, withdrawalAmount, withdrawalCost } from "./summary.js";
import { runtimeGetURL, runtimeSendMessage, tabsCreate } from "../../platform/extensionApi.js";

const app = document.getElementById("app");
const MAX_U64 = 18446744073709551615n;
const TEXT_REVIEW_TITLE = "Text needs review";

/**
 * What a site's text asks a person to check before they act, in words: its
 * hidden characters, and numbers that may not read as their digits say.
 * @param {{ hidden?: boolean, mixedDigits?: boolean, rtlDigits?: boolean, lookalikeDigits?: boolean }} checks - safeText's
 * @param {string} what - "message", "statement"
 * @param {string} act - "sign it", "sign in"
 */
const reviewWords = (checks, what, act) =>
  [
    checks?.hidden ? `This ${what} has hidden characters that can change how it reads. They show here as � or \\u codes.` : "",
    numbersText(checks),
    `Only ${act} if you trust this site.`,
  ].filter(Boolean).join(" ");

async function send(msg) {
  return runtimeSendMessage(msg, { allowLastError: true });
}

function getRid() {
  const url = new URL(window.location.href);
  return url.searchParams.get("rid") || "";
}

const rid = getRid();

// Reject and the approve button live in a bar under the page that scrolls,
// so they show whatever the request's length. A page without the bar (a test
// harness) gets one after its #app.
function actionsHost() {
  let bar = document.getElementById("approval-actions");
  if (!bar) {
    bar = h("div", { id: "approval-actions", class: "ap-actions" });
    (app?.closest?.(".panel") ?? document.body).appendChild(bar);
  }
  return bar;
}

// Each screen the window shows starts its approve button's click guard: a
// click that opened the window, or unlocked it, can't land on Approve.
function show(body, actions = []) {
  screenShown();
  setChildren(app, body.filter(Boolean));
  const bar = actionsHost();
  const kept = actions.filter(Boolean);
  setChildren(bar, kept);
  bar.hidden = kept.length === 0;
  tellShown();
}

// The wallet hears what a request waiting here leads with, for its site's
// record, and in a tab puts up the entry the phone's first Back takes away.
function tellShown() {
  if (!approvalLive || !rid) return;
  const asked = app.querySelector(".ap-title")?.textContent ?? "";
  send({ type: "DUSK_APPROVAL_SHOWN", rid, asked }).catch(() => {});
}

function renderError(text) {
  show([h("div", { class: "err", role: "alert", text })]);
}

/**
 * Under a box of a site's text that scrolls, a line that says it goes on, for
 * as long as there's more of it below the box's edge: blank lines can push
 * the rest of a message out of sight.
 * @param {HTMLElement} box - the box, once it's on the page
 * @param {string} what - "message", "statement"
 */
function goesOnNote(box, what) {
  const line = h("p", { class: "ap-sub ap-goes-on", role: "note", hidden: true, text: `The ${what} goes on below. Scroll it to read all of it.` });
  const check = () => {
    if (!box.isConnected) {
      window.removeEventListener?.("resize", check);
      return;
    }
    line.hidden = !(box.scrollHeight - box.scrollTop - box.clientHeight > 1);
  };
  box.addEventListener("scroll", check);
  window.addEventListener?.("resize", check);
  requestAnimationFrame(check);
  return line;
}

// The network the request is on, in the header beside the wallet's name, and
// at the top the strip that says a test network's DUSK has no value, or which
// node a custom one is.
function showNetwork(name, node) {
  syncTestnetStrip(app?.closest?.(".panel") ?? document.body, name, node);
  const chip = document.getElementById("approval-network");
  if (!chip) return;
  chip.textContent = name || "";
  chip.hidden = !name;
}

async function sendResult(message) {
  const res = await send(message);
  if (!res) throw new Error("No response");
  const err = res?.error;
  if (err) {
    if (typeof err === "string") throw new Error(err);
    throw new Error(err?.message ?? "Request failed");
  }
  if (res?.ok === false) {
    if (typeof res?.error === "string") throw new Error(res.error);
    throw new Error(res?.error?.message ?? "Request failed");
  }
  return Object.prototype.hasOwnProperty.call(res, "result") ? res.result : res;
}

function accountEnumToString(a) {
  if (!a) return "";
  if (typeof a === "string") return a;
  if (typeof a === "object") {
    if (typeof a.External === "string") return a.External;
    if (typeof a.Contract === "string") return a.Contract;
  }
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function formatTokenUnits(units, decimals, { maxFrac = 6 } = {}) {
  const u = safeBigInt(units, 0n);
  let d = Number(decimals ?? 0);
  if (!Number.isFinite(d) || d < 0) d = 0;
  d = Math.min(64, Math.floor(d));

  const s = u.toString();
  if (d === 0) return s;

  const pad = s.length <= d ? "0".repeat(d - s.length + 1) + s : s;
  const intPart = pad.slice(0, -d) || "0";
  let frac = pad.slice(-d);

  frac = frac.replace(/0+$/, "");
  if (typeof maxFrac === "number" && maxFrac >= 0 && frac.length > maxFrac) {
    frac = frac.slice(0, maxFrac).replace(/0+$/, "");
  }

  return frac ? `${intPart}.${frac}` : intPart;
}

// A time as the popup writes it: "26 Oct 2026, 14:10 CET". One that isn't a
// time shows as it came.
function dateText(value) {
  const d = new Date(String(value ?? ""));
  if (!Number.isFinite(d.getTime())) return String(value ?? "");
  return fullDateText(d.getTime());
}

// The network of a known chain ID, by its file's label: "dusk:2" is Testnet.
function chainName(chainId) {
  const id = String(chainId ?? "").trim();
  return id === "dusk:0" ? "Local" : /^dusk:\d+$/.test(id) ? networkFor(id)?.label ?? "" : "";
}

// "40 bytes · sha256=2f64b19f5ac0…731c7c2a": a call's arguments as the
// bridge's review page prints them, so the two can be matched.
function argsLine(bytes, hash) {
  return hash ? `${bytes.length} bytes · sha256=${hash.slice(0, 12)}…${hash.slice(-8)}` : `${bytes.length} bytes`;
}

// Keep a live approval window active while the user is reviewing it.
let activityHeartbeatTimer = null;
let approvalLive = false;

async function sendActivity() {
  const response = await send({ type: "DUSK_UI_ACTIVITY", rid }).catch(() => null);
  if (response?.ok === false) stopActivityHeartbeat();
}

function startActivityHeartbeat() {
  if (activityHeartbeatTimer || !approvalLive) return;
  sendActivity();
  activityHeartbeatTimer = setInterval(sendActivity, 30_000);
}

function stopActivityHeartbeat() {
  if (!activityHeartbeatTimer) return;
  clearInterval(activityHeartbeatTimer);
  activityHeartbeatTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopActivityHeartbeat();
    // A tab that said its request ended goes once it's left: no dead tabs to pile up.
    if (endedSaid && isPhone()) window.close();
    return;
  }
  startActivityHeartbeat();
  // Back from a call or another app: still waiting, or it says it isn't.
  if (approvalLive && rid) {
    untilTakenUp(() => send({ type: "DUSK_GET_PENDING", rid }), (p) => p?.waking)
      .then((pending) => {
        if (approvalLive && pending?.waking) giveUp();
        else if (approvalLive && !pending) ended();
      })
      .catch(() => {});
  }
});

// The phone's Back rejects the request, as closing its tab does. In a tab,
// the wallet puts an entry under it as it's drawn (pending.js, "#back"), which
// Firefox for Android's first Back takes away; one the page put up itself, it
// skips before a press. Elsewhere, one is put up once a press counts (a click,
// a key let go).
if (isPhone()) {
  let backGuard = false;
  const backEntry = () => globalThis.location?.hash === "#back";
  const guardBack = () => {
    if (backGuard || !approvalLive || backEntry()) return;
    backGuard = true;
    window.history?.pushState?.({ duskApproval: true }, "");
  };
  document.addEventListener("click", guardBack, true);
  document.addEventListener("keyup", guardBack, true);
  window.addEventListener("popstate", () => {
    // Come to the wallet's entry, not gone back from it.
    if (backEntry()) return;
    if (approvalLive) decide("reject").catch(() => ended());
  });
}

document.addEventListener(
  "click",
  () => {
    if (approvalLive) sendActivity();
  },
  { passive: true }
);

// A request this window no longer answers: the wallet stopped meanwhile (Firefox
// for Android stops it in the background) and nothing took it up, or it was
// handled elsewhere, maybe approved and sent. Said, with nothing to press:
// never a dead Approve.
export const ENDED_TEXT = "This request isn't waiting any more, and this window can't tell whether it went through. Check Activity before you ask the site again.";

/** The same, for a request that sends nothing: a connection, a signature. */
export const ENDED_ASK_TEXT = "This request isn't waiting any more. Ask the site again if you still want to.";

// The kind of request this window shows, and whether it said it ended.
let shownKind = "";
let endedSaid = false;

function ended(text = shownKind === "send_tx" ? ENDED_TEXT : ENDED_ASK_TEXT) {
  approvalLive = false;
  endedSaid = true;
  stopActivityHeartbeat();
  renderError(text);
}

// Its site never asked again: the wallet ends it for good, and the site hears
// so if it asks later, rather than taking up a window that answers nothing.
function giveUp() {
  send({ type: "DUSK_PENDING_DECISION", rid, decision: "abandon" }).catch(() => {});
  ended();
}

// A request kept through a stop of the wallet's background waits for its
// site to ask again, a few seconds at most: `ask` again until it's taken up.
const WAKING_TRIES = 15;
async function untilTakenUp(ask, waking) {
  let answer = await ask();
  for (let i = 0; waking(answer) && i < WAKING_TRIES; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    answer = await ask();
  }
  return answer;
}

// The answer, and the window goes, unless the wallet refused what came with it:
// then it says why, and the request goes on waiting. One that isn't waiting
// any more says so.
async function decide(decision, approvedParams, withAnswer = {}) {
  const res = await untilTakenUp(
    () => send({ type: "DUSK_PENDING_DECISION", rid, decision, ...(decision === "approve" ? { approvedParams, ...withAnswer } : {}) }),
    (answer) => answer?.error?.code === "waking"
  );
  if (res?.error?.code === "waking") {
    giveUp();
    return;
  }
  // Over: gone meanwhile, or the wallet couldn't note the approval (pending.js).
  if (res?.ok === false && (res.error === "Unknown request" || res.error?.code === "ended")) {
    ended(res.error?.message);
    return;
  }
  if (res?.error?.message) throw Object.assign(new Error(res.error.message), { refused: true, data: res.error.data });
  window.close();
}

// The password again, in the bar with Approve, for a send above the amount chosen
// in Settings: the wallet checks it as the window answers. Hidden until it's asked.
function sendPasswordField(onEnter) {
  const input = passwordInput({ id: "approval-send-password", autocomplete: "current-password", onEnter });
  const why = h("p", { class: "ap-sub" });
  const error = fieldError(input);
  input.addEventListener("input", () => error.show(""));
  const el = h("div", { class: "ap-actions__error ap-send-password", hidden: true }, [fieldLabel(input, "Password you unlock with"), why, input, error.el]);
  return {
    el,
    input,
    error,
    show(terms) {
      why.textContent = sendPasswordWhy(terms);
      el.hidden = false;
    },
    hide: () => {
      el.hidden = true;
      input.value = "";
      error.show("");
    },
    asked: () => !el.hidden,
  };
}

// What a window says when its answer didn't reach the wallet.
function answerFailedText(e) {
  const reason = String(e?.message ?? e ?? "").trim();
  return reason ? `Couldn't send your answer to the wallet: ${reason}` : "Couldn't send your answer to the wallet. Try again.";
}

/**
 * Reject and the approve button, side by side. Input that won't do (a gas
 * edit, a missing MAX) says so above them; nothing is sent. An answer that
 * doesn't reach the wallet (Firefox's runtime rejects when the background is
 * gone) says so there too, and the window stays open to try again.
 */
function decisionBar({ approveText = "Approve", approveDisabled = false, approveTitle = "", getApprovedParams, sends = false } = {}) {
  const error = h("div", { class: "field-error ap-actions__error", role: "alert", hidden: true });
  const answer = async (decision, approvedParams, withAnswer) => {
    try {
      await decide(decision, approvedParams, withAnswer);
    } catch (e) {
      // What the password's refusal says, under its field.
      if (e?.refused && e.data?.sendPassword) {
        sendPassword.show(e.data.sendPassword);
        sendPassword.error.show("Enter your password.");
        sendPassword.input.focus();
      } else if (e?.refused) {
        sendPassword.input.value = "";
        sendPassword.error.show(sendPasswordRefusal(e.message));
        sendPassword.input.focus();
      } else {
        error.textContent = answerFailedText(e);
        error.hidden = false;
      }
    }
  };
  const sendPassword = sendPasswordField(() => approveBtn.click());
  const rejectBtn = h("button", {
    class: "btn-outline",
    type: "button",
    text: "Reject",
    onclick: () => answer("reject"),
  });
  const approveBtn = h("button", {
    class: "btn-primary",
    type: "button",
    text: approveText,
    disabled: Boolean(approveDisabled),
    title: approveTitle || undefined,
    // It ignores a click for a moment once the window shows (clickGuard.js).
    onclick: guarded(async () => {
      let approvedParams = null;
      try {
        approvedParams = typeof getApprovedParams === "function" ? getApprovedParams() : null;
      } catch (e) {
        error.textContent = e?.message ?? String(e);
        error.hidden = false;
        return;
      }
      error.hidden = true;
      if (!sendPassword.asked()) {
        await answer("approve", approvedParams);
        return;
      }
      if (!sendPassword.input.value) {
        sendPassword.error.show("Enter your password.");
        sendPassword.input.focus();
        return;
      }
      // A moment, as an unlock: the wallet derives its key from the password.
      const wasOff = approveBtn.disabled;
      approveBtn.disabled = true;
      approveBtn.textContent = "Checking…";
      await answer("approve", approvedParams, { sendPassword: sendPassword.input.value });
      approveBtn.disabled = wasOff;
      approveBtn.textContent = approveText;
    }),
  });
  // A transaction waits for the connection: offline, nothing would go out.
  const offline = sends ? holdWhileOffline(approveBtn, { text: "You're offline. Approve once you're back online.", className: "ap-actions__error" }) : null;
  return { nodes: [error, offline, sendPassword.el, rejectBtn, approveBtn].filter(Boolean), approveBtn, rejectBtn, error, sendPassword };
}

export async function renderNotification() {
  if (!rid) {
    renderError("Missing request id.");
    return;
  }

  // One kept through a stop of the wallet's background waits for its site to ask again.
  const pending = await untilTakenUp(() => send({ type: "DUSK_GET_PENDING", rid }), (p) => p?.waking);
  if (pending?.waking) {
    giveUp();
    return;
  }
  // The node's network, by the chain ID it gave, for what the window knows only by the node.
  noteChainId(pending?.nodeUrl, pending?.chainId);
  if (!pending) {
    approvalLive = false;
    stopActivityHeartbeat();
    renderError("This request is no longer waiting: it was handled or it expired. You can close this window.");
    return;
  }

  approvalLive = true;
  startActivityHeartbeat();

  const {
    kind,
    origin,
    params,
    hasVault,
    isUnlocked,
    accounts,
    accountCount,
    selectedAccountIndex,
    addresses,
    accountNames,
    duskNames,
    contacts,
    permissionAccountIndex,
  } = pending;
  // Normalize request kind defensively. In some environments the value might
  // include whitespace or differ in casing (e.g. service worker restarts,
  // serialization quirks). The UI should still render the correct screen.
  const kindNorm = String(kind ?? "")
    .trim()
    .toLowerCase();
  shownKind = kindNorm;

  // The network: a transaction's own, which it was approved for, a
  // signature's chain, or the wallet's.
  const nodeUrl = String(params?.nodeUrl ?? pending.nodeUrl ?? "");
  const chainRefused = String(pending.chainRefusal ?? "");
  // The wallet's prover and archiver, which go with its own node.
  const endpoints = nodeUrl === String(pending.nodeUrl ?? "") ? { proverUrl: String(pending.proverUrl ?? ""), archiverUrl: String(pending.archiverUrl ?? "") } : {};
  showNetwork(
    String(params?.networkName ?? "") || chainName(params?.chainId) || String(pending.networkName ?? "") || (nodeUrl ? networkNameFromNodeUrl(nodeUrl) : ""),
    { nodeUrl, chainId: pending.chainId ?? null, ...endpoints }
  );

  const accountsArr = Array.isArray(accounts) ? accounts : [];
  const permIdxRaw =
    permissionAccountIndex === null || permissionAccountIndex === undefined
      ? null
      : Number(permissionAccountIndex);
  const permIdx = permIdxRaw !== null && Number.isFinite(permIdxRaw) && permIdxRaw >= 0 ? Math.floor(permIdxRaw) : null;
  const selIdxRaw = Number(selectedAccountIndex ?? 0);
  const selIdx = Number.isFinite(selIdxRaw) && selIdxRaw >= 0 ? Math.floor(selIdxRaw) : 0;
  const idxForOrigin = permIdx ?? selIdx;
  const activeAccount = accountsArr[idxForOrigin] ?? accountsArr[0] ?? "";
  // The checked .dusk names of the wallet's own profiles. A recipient's name
  // is the engine's to look up (recipientName).
  const nameOf = (account) => {
    const name = duskNames && typeof duskNames === "object" ? duskNames[account] : "";
    return typeof name === "string" ? name : "";
  };
  const nameMap = accountNames && typeof accountNames === "object" ? accountNames : {};
  // A profile's label: the one the user gave it, or its number.
  const profileLabel = (i) => String(nameMap?.[String(i)] ?? "").trim() || `Profile ${i + 1}`;
  // With more than one wallet, the name of the one the request is bound to,
  // first wherever a profile signs or pays: "Wallet 2 · alice.dusk".
  const walletName = String(pending.walletName ?? "").trim();
  const inWallet = (el) => (walletName ? h("span", { class: "ap-wallet" }, [`${walletName} · `, el]) : el);

  // The profile that signs or pays: its verified .dusk name over its short
  // account, or the account in full without one; the wallet's name before
  // the name, or over the account.
  const profileValue = (account = activeAccount) => {
    const name = nameOf(account);
    if (!account || !name) {
      return h("span", { class: "named-address" }, [walletName ? h("span", { text: walletName }) : null, h("code", { text: account || "(none)" })]);
    }
    return h("span", { class: "named-address" }, [inWallet(h("span", { class: "dusk-name", text: name, title: name })), shortAddressEl(account)]);
  };
  // The paying profile in one line: "alice.dusk · Public".
  const payerLine = (rail) => {
    const name = nameOf(activeAccount);
    return h("span", {}, [
      inWallet(name ? h("span", { text: name, title: activeAccount }) : shortMono(activeAccount)),
      h("span", { class: "kv-muted", text: ` · ${rail}` }),
    ]);
  };

  // Who the wallet knows an account or address as: one of its profiles, by
  // its public account or shielded address, or a saved contact. A site picks
  // the address, so it must be the saved one exactly: base58 tells cases
  // apart.
  const ownAddresses = Array.isArray(addresses) ? addresses : [];
  // The accounts and addresses a bridge call may name as its `to`: the wallet's own.
  const own = [...accountsArr, ...ownAddresses].filter(Boolean);
  const savedContacts = Array.isArray(contacts) ? contacts : [];
  const knownAs = (to) => {
    const own = [accountsArr.indexOf(to), ownAddresses.indexOf(to)].find((i) => i >= 0);
    if (own !== undefined) return { label: profileLabel(own), source: "your profile", own: accountsArr[own] === to };
    const contact = savedContacts.find((c) => String(c?.address ?? "").trim() === to);
    const label = String(contact?.name ?? "").trim();
    return label ? { label, source: "saved contact", own: false } : null;
  };

  /**
   * A Dusk recipient: the .dusk name the recipient set for its public
   * account, which the engine checks points back to it, leads; your own label
   * for it (a profile, a saved contact) follows as a tag, so a label never
   * hides what the chain says. Until the name comes, and without one, the
   * short address leads. The name is asked for once the window shows; it
   * replaces the short address in its line, so nothing moves and Approve
   * never waits for it.
   */
  const recipient = (address) => {
    const to = String(address ?? "").trim();
    const known = to ? knownAs(to) : null;
    const lead = h("span", { class: "ap-recipient__lead mono", text: shortAddress(to) || "(missing)", title: to });
    // Shown with a name a node the wallet doesn't know gave.
    const note = nameCheckNoteEl(nodeUrl, { className: "ap-recipient__note", hidden: true });
    const showName = (name) => {
      lead.textContent = name;
      lead.title = `${name} · ${to}`;
      lead.classList.remove("mono");
    };
    const ownName = known?.own ? nameOf(to) : "";
    if (ownName) {
      showName(ownName);
    } else if (!known?.own && classifyDuskIdentifier(to) === "account" && duskNamesNetwork(nodeUrl)) {
      send({ type: "DUSK_UI_RECIPIENT_NAME", rid, recipient: to })
        .then((res) => {
          const name = res?.ok ? res.result : null;
          if (typeof name !== "string" || !name) return;
          showName(name);
          if (note) note.hidden = false;
        })
        .catch(() => {});
    }
    const tag = known
      ? h("span", { class: "ap-recipient__tag", title: known.label }, [
          h("span", { class: "ap-recipient__label", text: known.label }),
          h("span", { class: "ap-recipient__source", text: ` · ${known.source}` }),
        ])
      : null;
    return { lead, tag, known, note };
  };

  // "to wallet-both.dusk", and under it your label for it, for a head's
  // `to` line; `prefix` in place of "to ".
  const toLine = (address, { network = "", prefix = "to " } = {}) => {
    const r = recipient(address);
    return h("span", { class: "ap-recipient" }, [
      h("span", { class: "ap-recipient__line" }, [
        h("span", { class: "ap-recipient__to", text: prefix }),
        r.lead,
        network ? h("span", { class: "ap-recipient__to", text: ` ${network}` }) : null,
      ]),
      r.tag,
      r.note,
    ]);
  };
  // An address without a name, as every Dusk app shortens it: "to
  // 0x96BA…893e on DuskEVM", or a Dusk contract's ID 6…6.
  const plainTo = (value, network, { evm = true, prefix = "to " } = {}) =>
    h("span", { class: "ap-recipient" }, [
      h("span", { class: "ap-recipient__line" }, [
        h("span", { class: "ap-recipient__to", text: prefix }),
        shortMono(value, evm ? shortEvmAddress(value) : undefined),
        network ? h("span", { class: "ap-recipient__to", text: ` ${network}` }) : null,
      ]),
    ]);
  // A summary's `to` (summary.js) as its head's line: a Dusk account by its
  // name, any other address as it is.
  const headTo = (to) => {
    if (!to?.address) return null;
    if (to.network === "dusk") return toLine(to.address, { network: to.on ?? "", prefix: to.prefix });
    return plainTo(to.address, to.on, { evm: to.network !== "contract", prefix: to.prefix });
  };

  const site = siteChip(origin);

  if (!hasVault) {
    show(
      [
        site,
        requestHead({ title: "Set up Dusk Wallet first", sub: "Create or import a recovery phrase, then try again on the site." }),
      ],
      [
        h("button", { class: "btn-outline", type: "button", text: "Reject", onclick: () => decide("reject").catch((e) => renderError(answerFailedText(e))) }),
        h("button", {
          class: "btn-primary",
          type: "button",
          text: "Set up wallet",
          onclick: async () => {
            try {
              await tabsCreate({ url: runtimeGetURL("full.html") });
            } catch {
              // ignore
            }
            window.close();
          },
        }),
      ]
    );
    return;
  }

  if (!isUnlocked) {
    renderLocked();
    return;
  }

  if (chainRefused) {
    renderChainRefused();
    return;
  }

  switch (kindNorm) {
    case "connect":
      return renderConnect();
    case "switch_network":
      return renderSwitchNetwork();
    case "sign_message":
      return renderSignMessage();
    case "sign_auth":
      return renderSignAuth();
    case "sign_typed_data":
      return renderSignTypedData();
    case "watch_asset":
      return renderWatchAsset();
    case "send_tx":
      return renderSendTx();
    default:
      renderError(`Unknown kind: ${kindNorm || String(kind)}`);
  }

  // ---- A node that contradicts its chain ----------------------------------

  // What the site asks, why nothing is signed on this node, and Reject.
  function renderChainRefused() {
    const summary = requestSummary(kindNorm, params, { own });
    show(
      [
        site,
        requestHead({ title: summary.title, amount: summary.amount, to: headTo(summary.to) }),
        warning("This can't be signed on this node", chainRefused),
      ],
      decisionBar({ approveDisabled: true }).nodes
    );
  }

  // ---- Locked --------------------------------------------------------------

  // What the site asks, then the password, with Reject beside Unlock: no
  // need to unlock to say no.
  function renderLocked() {
    const summary = requestSummary(kindNorm, params, { own });
    const pwd = passwordInput({
      id: "approval-password",
      autocomplete: "current-password",
      placeholder: "Password",
      onEnter: () => unlock(),
    });
    const errLine = h("div", { id: "approval-unlock-error", class: "field-error", role: "alert", hidden: true });
    const showError = (text) => {
      errLine.textContent = text || "";
      errLine.hidden = !text;
      if (text) {
        pwd.setAttribute("aria-invalid", "true");
        pwd.setAttribute("aria-describedby", "approval-unlock-error");
      } else {
        pwd.removeAttribute("aria-invalid");
        pwd.removeAttribute("aria-describedby");
      }
    };
    pwd.addEventListener("input", () => showError(""));
    const busyNote = h("p", { class: "ap-sub", text: "This can take a moment.", hidden: true });

    const unlockBtn = h("button", { class: "btn-primary", type: "button", text: "Unlock" });
    let busy = false;
    const unlock = async () => {
      if (busy) return;
      let focusPassword = false;
      busy = true;
      unlockBtn.disabled = true;
      pwd.disabled = true;
      unlockBtn.textContent = "Unlocking…";
      busyNote.hidden = false;
      showError("");

      try {
        const res = await send({ type: "DUSK_UI_UNLOCK", password: pwd.value });
        if (res?.error) {
          showError(res.error.message || "Unlock failed");
          focusPassword = true;
          return;
        }
        pwd.value = "";
        await renderNotification();
      } catch (error) {
        showError(error?.message || "Unlock failed");
        focusPassword = true;
      } finally {
        pwd.value = "";
        busy = false;
        unlockBtn.disabled = false;
        pwd.disabled = false;
        unlockBtn.textContent = "Unlock";
        busyNote.hidden = true;
        if (focusPassword) pwd.focus();
      }
    };
    unlockBtn.addEventListener("click", unlock);

    show(
      [
        site,
        requestHead({ title: summary.title, amount: summary.amount, node: summary.node, to: headTo(summary.to), sub: summary.sub }),
        h("div", { class: "ap-unlock" }, [
          h("label", { for: "approval-password", text: "Unlock to review and approve it" }),
          pwd,
          errLine,
          busyNote,
        ]),
      ],
      [h("button", { class: "btn-outline", type: "button", text: "Reject", onclick: () => decide("reject").catch((e) => showError(answerFailedText(e))) }), unlockBtn]
    );
  }

  // ---- Connect -------------------------------------------------------------

  // A card per profile: its label, its .dusk name when the wallet checked it
  // lately, and its short account, muted. With more than one profile the
  // cards are native radios, so arrow keys pick one and screen readers read
  // each card, the full account included. Then what the site will see and
  // what it can't do, worded for this request: a site that asks for the
  // shielded address says so in the title.
  function renderConnect() {
    const requestedShielded = Boolean(params?.shieldedReceiveAddress);
    // How long it stays connected: as it's set, and connected already, until when.
    const endsAt = Number(params?.endsAt ?? 0);
    const lastsDays = params?.stays ? 0 : Math.round(Number(params?.lastsMs ?? 0) / 86_400_000);
    const lastsText = endsAt > 0 ? `until ${fullDateText(endsAt)}, or until you disconnect it` : lastsDays > 0 ? `for ${lastsDays === 1 ? "a day" : `${lastsDays} days`}, or until you disconnect it` : "until you disconnect it";
    const currentAccountIndexRaw = Number(params?.currentAccountIndex);
    const currentAccountIndex =
      params?.currentAccountIndex != null && Number.isFinite(currentAccountIndexRaw) && currentAccountIndexRaw >= 0
        ? Math.floor(currentAccountIndexRaw)
        : null;
    const currentShieldedGrant = Boolean(params?.currentGrants?.shieldedReceiveAddress);
    const count = Math.max(1, Number(accountCount ?? (accountsArr.length || 1)) || 1);
    const displayAccounts = accountsArr.length ? accountsArr : Array.from({ length: count }, () => "");

    const choosing = displayAccounts.length > 1;
    let selected = Math.max(0, Math.min(idxForOrigin, displayAccounts.length - 1));
    const options = displayAccounts.map((acct, i) => {
      const account = String(acct ?? "");
      const name = nameOf(account);
      const radio = choosing
        ? h("input", { class: "sr-only", type: "radio", name: "connect-profile", value: String(i) })
        : null;
      radio?.addEventListener("change", () => {
        if (radio.checked) pick(i);
      });
      const card = h(choosing ? "label" : "div", { class: "name-option profile-option" }, [
        radio,
        h("span", { class: "name-option__main" }, [
          h("span", { class: "name-option__dot", "aria-hidden": "true" }),
          h("span", { class: "name-option__label", text: profileLabel(i) }),
          name ? h("span", { class: "dusk-name", text: name, title: name }) : null,
          account ? shortAddressEl(account, { className: "name-option__addr" }) : null,
        ]),
      ]);
      return { card, radio };
    });

    // The site keeps a shielded address it has for the profile picked.
    const sharesShielded = () =>
      requestedShielded || (currentAccountIndex !== null && selected === currentAccountIndex && currentShieldedGrant);
    const factsHost = h("div", { class: "ap-facts-host" });
    const drawFacts = () => {
      const account = String(displayAccounts[selected] ?? "");
      const name = nameOf(account);
      const who = [name, account ? shortAddress(account) : ""].filter(Boolean).join(" · ");
      const connected = currentAccountIndex !== null && currentAccountIndex === selected;
      setChildren(factsHost, [
        sectionTitle("What the site gets", "ap-connect-facts"),
        facts(
          [
            requestedShielded && connected
              ? null
              : {
                  icon: "eye",
                  title: "Sees your public address, .dusk name and balance",
                  sub: `${who ? `${who}, ` : ""}${lastsText}`,
                },
            sharesShielded()
              ? { icon: "shield", title: "Gets your shielded address", sub: "It can send you shielded payments. It can't see your shielded balance." }
              : null,
            { icon: "lock", title: "Can't move funds without your approval", sub: "Every payment and signature asks you here first." },
          ],
          { label: "What the site gets" }
        ),
      ]);
    };
    const pick = (index) => {
      selected = index;
      options.forEach(({ card, radio }, i) => {
        card.classList.toggle("is-checked", i === index);
        if (radio) radio.checked = i === index;
      });
      drawFacts();
    };
    pick(selected);

    const summary = requestSummary("connect", params);
    const bar = decisionBar({
      approveText: requestedShielded && currentAccountIndex !== null ? "Share" : "Connect",
      getApprovedParams: () => ({ accountIndex: selected, shieldedReceiveAddress: sharesShielded() }),
    });
    show(
      [
        site,
        requestHead({ title: summary.title }),
        h("section", { class: "ap-profiles", "aria-labelledby": "connect-profile-label" }, [
          sectionTitle(`${choosing ? "Choose a profile" : "Profile"}${walletName ? ` in ${walletName}` : ""}`, "connect-profile-label"),
          h(
            "div",
            {
              class: "name-choice",
              ...(choosing && { role: "radiogroup", "aria-labelledby": "connect-profile-label" }),
            },
            options.map((o) => o.card)
          ),
        ]),
        factsHost,
      ],
      bar.nodes
    );
  }

  // ---- Switch network ------------------------------------------------------

  // The host of the node it goes to in large type, what that choice means,
  // and each side by its name, a custom node's with its host; the addresses
  // in full and the chain IDs a site sees sit under Details.
  function renderSwitchNetwork() {
    const from = params?.from ?? {};
    const to = params?.to ?? {};
    const summary = requestSummary("switch_network", params);
    const net = (n) => (n.nodeUrl ? networkTextOf(n.nodeUrl) : String(n.networkName ?? "Unknown"));
    show(
      [
        site,
        requestHead({ title: summary.title, node: summary.node, sub: "The wallet then uses that network, for every site." }),
        summary.sub ? note(summary.sub, "eye", { className: "ap-visible" }) : null,
        group([kv("From", net(from)), kv("To", net(to))]),
        details("Details", [
          group(
            [
              from.nodeUrl ? kv("From node", mono(from.nodeUrl), { stack: true }) : null,
              to.nodeUrl ? kv("To node", mono(to.nodeUrl), { stack: true }) : null,
              to.chainId ? kv("Chain ID sites see", mono(to.chainId)) : null,
            ],
            { className: "group--inset" }
          ),
        ]),
      ],
      decisionBar({ approveText: "Switch" }).nodes
    );
  }

  // ---- Sign a message ------------------------------------------------------

  function renderSignMessage() {
    const chainId = String(params?.chainId ?? "");
    const messageHash = String(params?.messageHash ?? "");
    const messageLen = Number(params?.messageLen ?? 0) || 0;
    const preview = params?.messagePreview && typeof params.messagePreview === "object" ? params.messagePreview : null;
    const hashLine = messageHash
      ? `${messageLen} bytes · sha256=${messageHash.slice(0, 12)}…${messageHash.slice(-8)}`
      : `${messageLen} bytes`;

    let message;
    if (preview?.kind === "text") {
      const box = h("div", {
        class: "ap-message",
        text: String(preview.text ?? ""),
        title: preview.truncated ? "Preview shortened; the hash covers the full message." : undefined,
      });
      message = h("section", { class: "ap-message-wrap", "aria-labelledby": "ap-message-title" }, [
        sectionTitle(preview.truncated ? "Message, shortened" : "Message", "ap-message-title"),
        box,
        goesOnNote(box, "message"),
        preview.truncated ? h("p", { class: "ap-sub", text: "Shortened here. The hash below covers the full message." }) : null,
        preview.needsReview ? warning(TEXT_REVIEW_TITLE, reviewWords(preview.checks ?? { hidden: true }, "message", "sign it")) : null,
      ]);
    } else {
      const reason = String(preview?.reason ?? "");
      const reasonText =
        reason === "too_large"
          ? "It's too large to show."
          : reason === "invalid_utf8"
            ? "It isn't readable text."
            : reason === "control_characters"
              ? "It contains hidden control characters."
              : "It isn't shown.";
      message = h("section", { class: "ap-message-wrap", "aria-labelledby": "ap-message-title" }, [
        sectionTitle("Message", "ap-message-title"),
        h("div", { class: "ap-message ap-message--bytes" }, [
          h("div", { class: "ap-message__title", text: `${messageLen} bytes` }),
          h("div", { class: "ap-sub", text: `${reasonText} Only sign it if you trust this site.` }),
        ]),
      ]);
    }

    show(
      [
        site,
        requestHead({ title: "Sign a message?" }),
        message,
        group([kv("Account", profileValue()), kv("Message hash", mono(hashLine), { stack: true })]),
        note("Signing sends no transaction and moves no funds.", "info"),
        details("Details", [group([kv("Network", nodeUrl ? networkTextOf(nodeUrl) : chainName(chainId) || "Custom"), kv("Chain ID", mono(chainId || "—"))], { className: "group--inset" })]),
      ],
      decisionBar({ approveText: "Sign" }).nodes
    );
  }

  // ---- Sign in -------------------------------------------------------------

  function renderSignAuth() {
    const chainId = String(params?.chainId ?? "");
    const nonce = String(params?.nonce ?? "");
    const statement = safeText(String(params?.statement ?? "").trim(), { keepLines: true });
    const statementBox = statement.text ? h("div", { class: "ap-message", text: statement.text }) : null;
    const nonceShown = safeText(nonce).text;
    const expiresAt = String(params?.expiresAt ?? "").trim();

    show(
      [
        site,
        requestHead({ title: "Sign in to this site?" }),
        statementBox
          ? h("section", { class: "ap-message-wrap", "aria-labelledby": "ap-statement-title" }, [
              sectionTitle("The site's statement", "ap-statement-title"),
              statementBox,
              goesOnNote(statementBox, "statement"),
              statement.flagged ? warning(TEXT_REVIEW_TITLE, reviewWords(statement.checks, "statement", "sign in")) : null,
            ])
          : null,
        group([
          kv("Account", profileValue()),
          kv("Nonce", mono(nonceShown || "—"), { stack: nonceShown.length > 24 }),
          expiresAt ? kv("Expires", dateText(expiresAt)) : null,
        ]),
        note("Only sign in to sites you trust. Signing in moves no funds.", "info"),
        details("Details", [group([kv("Chain ID", mono(chainId || "—"))], { className: "group--inset" })]),
      ],
      decisionBar({ approveText: "Sign in" }).nodes
    );
  }

  // ---- Sign typed data -----------------------------------------------------

  async function renderSignTypedData() {
    const digestHex = String(params?.digestHex ?? "");
    let disclosure;
    try {
      disclosure = prepareTypedDataDisclosure(
        {
          domain: params?.domain,
          types: params?.types,
          primaryType: params?.primaryType,
          message: params?.message,
          origin,
        },
        digestHex
      );
    } catch {
      show(
        [
          site,
          requestHead({ title: "Sign typed data?" }),
          h("div", {
            class: "err",
            role: "alert",
            text: "Cannot safely disclose the full signing request. Signing is disabled. Reject this request and ask the site for a smaller or corrected payload.",
          }),
        ],
        decisionBar({ approveText: "Sign", approveDisabled: true }).nodes
      );
      return;
    }
    // Both views use the same digest-checked snapshot, not a second read of params.
    const { domain, primaryType } = disclosure.input;
    const originPreview = sanitizeStringForDisplay(disclosure.input.origin);
    const domainName = sanitizeStringForDisplay(domain.name);
    const domainVersion = sanitizeStringForDisplay(domain.version);
    const domainChainId = sanitizeStringForDisplay(domain.chainId);
    const verifyingContract = domain.verifyingContract;
    const { rows, truncated } = await flattenTypedMessage(disclosure.input);
    // Text shaping and normalization differences are not necessarily malicious;
    // distinguish their review notice from ordinary preview-size limits.
    const typedRows = [originPreview, domainName, domainVersion, domainChainId, ...rows];
    const hasTextSafetyWarning = typedRows.some((row) => textNeedsReview(row.flags));
    const typedChecks = textChecks(typedRows.flatMap((row) => row.flags));

    // A row's value as the wallet will sign it, its flags in the tooltip, and
    // a notice when the preview cut it.
    const displayRow = (label, row) =>
      kv(
        label,
        [
          h("code", { text: row.display, title: row.flags.length ? row.flags.join(", ") : "" }),
          row.flags.includes("truncated") ? h("span", { class: "ap-kv-note", text: "Text truncated; the full value is signed." }) : null,
        ],
        { stack: true }
      );

    show(
      [
        site,
        requestHead({ title: "Sign typed data?" }),
        group([
          displayRow("Request from", originPreview),
          kv("Account", profileValue()),
          displayRow("Domain name", domainName),
          displayRow("Domain version", domainVersion),
          displayRow("Chain ID", domainChainId),
          displayRow("Verifying contract", { display: verifyingContract || "32 zero bytes (default)", flags: [] }),
          kv("Primary type", h("code", { text: primaryType }), { stack: true }),
        ]),
        h("details", { class: "advanced ap-details" }, [
          h("summary", { text: "Full signing request (escaped JSON)" }),
          h("div", { class: "ap-details__body" }, [
            h("p", {
              class: "ap-sub",
              text: "Complete values and declared schema, including bytes and omitted preview content. Non-ASCII characters use JSON \\uXXXX escapes; originals are not normalized. Unused types and extra metadata do not contribute to the digest.",
            }),
            h("textarea", {
              class: "ap-code",
              readonly: true,
              rows: 12,
              wrap: "off",
              spellcheck: false,
              dir: "ltr",
              "aria-label": "Full signing request (escaped JSON)",
              text: disclosure.json,
            }),
          ]),
        ]),
        sectionTitle("Message fields", "ap-typed-fields"),
        group(rows.map((row) => displayRow(`${row.path} · ${row.type}`, row))),
        truncated
          ? h("p", {
              class: "ap-sub",
              text: [
                truncated.omittedCount > 0 ? `${truncated.omittedCount} more field(s) not shown.` : "",
                truncated.depthLimited ? "Some fields are nested deeper than this screen displays." : "",
                "Open Full signing request (escaped JSON) above to inspect every value.",
                "The digest below covers the whole message.",
              ]
                .filter(Boolean)
                .join(" "),
            })
          : null,
        h("details", { class: "advanced ap-details" }, [
          h("summary", { text: "Digest (verify against the dApp)" }),
          h("div", { class: "ap-details__body" }, [h("code", { class: "ap-digest", text: digestHex || "—" })]),
        ]),
        hasTextSafetyWarning
          ? warning(
              TEXT_REVIEW_TITLE,
              [
                typedChecks.hidden ? "Some origin, domain or message text contains controls, formatting characters, line separators or non-NFC sequences. The preview may use placeholders or escapes. Inspect the originals in Full signing request before signing." : "",
                numbersText(typedChecks),
              ].filter(Boolean).join(" ")
            )
          : null,
        note(
          "Signing authorizes this exact message for the site shown above. It sends no transaction. Check every field: a site can ask for a signature over contracts or values you don't mean to trust.",
          "info"
        ),
      ],
      decisionBar({ approveText: "Sign" }).nodes
    );
  }

  // ---- Add a token or NFT --------------------------------------------------

  async function renderWatchAsset() {
    const type = String(params?.type ?? "").trim().toUpperCase();
    const options = params?.options && typeof params.options === "object" ? params.options : {};
    const contractId = String(options?.contractId ?? "");
    const tokenId = options?.tokenId != null ? String(options.tokenId) : "";

    let meta = null;
    let tokenUri = "";
    let ownedKnown = false;
    let owned = true;

    if (type === "DRC20") {
      meta = await sendResult({ type: "DUSK_UI_DRC20_GET_METADATA", contractId }).catch(() => null);
    } else if (type === "DRC721") {
      meta = await sendResult({ type: "DUSK_UI_DRC721_GET_METADATA", contractId }).catch(() => null);
      if (tokenId) {
        try {
          const ownerStr = accountEnumToString(await sendResult({ type: "DUSK_UI_DRC721_OWNER_OF", contractId, tokenId }));
          ownedKnown = Boolean(ownerStr);
          owned = ownerStr === String(activeAccount ?? "");
        } catch {
          ownedKnown = false;
          owned = true;
        }
        tokenUri = String(await sendResult({ type: "DUSK_UI_DRC721_TOKEN_URI", contractId, tokenId }).catch(() => ""));
      }
    }

    const nft = type === "DRC721";
    const label = [String(meta?.name ?? "").trim(), String(meta?.symbol ?? "").trim()].filter(Boolean).join(" · ");
    const bar = decisionBar({ approveText: nft ? "Import NFT" : "Add token", approveDisabled: nft && ownedKnown && !owned });
    show(
      [
        site,
        requestHead({ title: requestSummary("watch_asset", params).title, sub: label || undefined }),
        group([
          kv("Standard", type || "(missing)"),
          kv("Contract", contractId ? shortMono(contractIdText(contractId)) : "(missing)"),
          nft ? kv("Token ID", mono(tokenId || "(missing)")) : null,
          kv("Account", profileValue()),
        ]),
        nft && ownedKnown && !owned
          ? warning("Not yours", "The connected profile doesn't own this NFT, so it can't be imported.")
          : null,
        note("The wallet checks the contract's standard and its on-chain details before adding it.", "info"),
        details("Details", [
          group(
            [
              contractId ? kv("Contract ID", mono(contractId), { stack: true }) : null,
              meta ? kv("On-chain details", h("code", { text: JSON.stringify(meta, null, 2) }), { stack: true }) : null,
              nft && tokenUri ? kv("Token URI", mono(tokenUri), { stack: true }) : null,
            ],
            { className: "group--inset" }
          ),
        ]),
      ],
      bar.nodes
    );
  }

  // ---- Transactions --------------------------------------------------------

  async function renderSendTx() {
    const txKind = String(params?.kind ?? "").toLowerCase();
    const txChainId = String(params?.chainId ?? "");
    const networkName = nodeUrl ? networkTextOf(nodeUrl) : String(params?.networkName ?? "");
    const privacy = String(params?.privacy ?? (txKind === TX_KIND.CONTRACT_CALL ? "public" : "")).trim().toLowerCase();
    const shielded = privacy === "shielded";
    const rail = shielded ? "Shielded" : "Public";
    const gas = params?.gas ?? null;
    // Who a public transaction shows as: the profile's verified .dusk name,
    // or its account when it has none.
    const myName = nameOf(activeAccount);
    const me = myName ? `your name ${myName}` : "your account";

    // The network's lines, which most people skip: the chain the signature
    // carries, and apart from it the ID sites are told, a custom node's own.
    const signsFor = chainIdForNode(nodeUrl);
    const networkRows = () => [
      kv("Network", networkName || "Unknown"),
      signsFor !== null ? kv("Signs for", chainWords(signsFor)) : null,
      txChainId ? kv("Chain ID sites see", mono(txChainId)) : null,
      nodeUrl ? kv("Node", mono(nodeUrl), { stack: true }) : null,
    ];

    // A fee the site chose, compared with the network's price once that's
    // read: a warning with a way back from twice that, a note otherwise.
    const fromSite = params?.feeFromSite ?? {};
    const siteFee = h("div", { class: "ap-site-fee", hidden: !fromSite.limit && !fromSite.price });
    const showSiteFee = (networkPrice, gasEditor) => {
      const given = safeBigInt(gas?.price, 0n);
      const asked = safeBigInt(networkPrice, 0n);
      if (fromSite.price && asked > 0n && given >= asked * 2n) {
        const times = (Number((given * 10n) / asked) / 10).toLocaleString(amountLocale(), { maximumFractionDigits: 1 });
        const reset = h("button", {
          class: "text-btn text-btn--inline",
          type: "button",
          text: "Use the network's price",
          onclick: () => {
            gasEditor.setGas?.(gasEditor.networkGas);
            siteFee.hidden = true;
          },
        });
        setChildren(siteFee, [warning("This site chose a high fee", `It's ${times} times the network's price.`, [reset])]);
      } else if (fromSite.price) {
        const compared =
          asked <= 0n
            ? "This site chose the fee."
            : given === asked
              ? "This site chose the fee, at the network's price."
              : given > asked
                ? "This site chose the fee, above the network's price."
                : "This site chose the fee, below the network's price. It may take longer to go through.";
        setChildren(siteFee, [note(compared)]);
      } else if (fromSite.limit) {
        const most = gas?.limit != null && gas?.price != null ? ` of up to ${formatFee(safeBigInt(gas.limit, 0n) * safeBigInt(gas.price, 0n), { max: true })} DUSK` : "";
        setChildren(siteFee, [note(`This site chose the gas limit, for a fee${most} at the network's price.`)]);
      }
    };

    // The one fee editor, as on every Review: the fee and the total, then
    // Custom fee. A limit under the transaction's minimum says so while it's
    // typed, and "Use the network's price" puts back the request's limit at
    // the price the node asks now.
    const minimum = getMinimumGas(txKind, { privacy })?.limit ?? null;
    const gasEditorFor = (amountLux, extraLux = []) => {
      const gasEditor = document.createElement("dusk-gas-editor");
      gasEditor.amountLux = amountLux;
      gasEditor.extraLux = extraLux;
      gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;
      gasEditor.helpText = "The fee is at most the gas limit times the gas price.";
      gasEditor.minLimit = minimum;
      gasEditor.networkGas = gas;
      gasEditor.setGas(gas);
      showSiteFee(null, gasEditor);
      // Said of the site's own fee, until it's changed here.
      const chosenLux = safeBigInt(gas?.limit, 0n) * safeBigInt(gas?.price, 0n);
      gasEditor.addEventListener("dusk-gas-fee", (event) => {
        siteFee.hidden = (!fromSite.limit && !fromSite.price) || event?.detail?.feeLux !== chosenLux;
      });
      if (gas?.limit != null) {
        send({ type: "DUSK_UI_GET_CACHED_GAS_PRICE" })
          .then((res) => {
            const stats = res?.result ?? res;
            const price = String(stats?.median ?? stats?.average ?? "").trim();
            if (/^\d+$/.test(price) && price !== "0") {
              gasEditor.networkGas = { limit: String(gas.limit), price };
              showSiteFee(price, gasEditor);
            }
          })
          .catch(() => {});
      }
      return gasEditor;
    };

    // Whether what pays covers what's sent and the fee: in the bar, above the
    // buttons, so what keeps Approve off is in view with it.
    const available = /^\d+$/.test(String(pending.payBalance ?? "")) ? BigInt(pending.payBalance) : null;
    const guardFor = (gasEditor, bar, sendsLux, ready = () => true) => {
      const pay = payGuard({ editor: gasEditor, availableLux: available, sendsLux, shielded, hidden: pending.hideBalances === true, button: bar.approveBtn, ready, gas });
      pay.el.classList.add("ap-actions__error");
      bar.nodes.splice(1, 0, pay.el);
      // Above the amount chosen in Settings, the password, as the fee changes too.
      const terms = pending.sendPassword;
      if (terms) {
        const asksAt = (feeLux) => terms.always || safeBigInt(terms.moves, 0n) + feeLux > safeBigInt(terms.limit, 0n);
        const draw = (feeLux) => (asksAt(feeLux) ? bar.sendPassword.show(terms) : bar.sendPassword.hide());
        draw(safeBigInt(gas?.limit, 0n) * safeBigInt(gas?.price, 0n));
        gasEditor.addEventListener("dusk-gas-fee", (event) => {
          if (event?.detail?.feeLux != null) draw(event.detail.feeLux);
        });
      }
      return pay;
    };

    if (txKind === TX_KIND.TRANSFER) {
      const to = String(params?.to ?? "").trim();
      const amountLux = safeBigInt(params?.amount, 0n).toString();
      const memo = String(params?.memo ?? "");
      const gasEditor = gasEditorFor(amountLux);
      // A recipient the network's file blocks: why, at the top, and no Approve.
      const blocked = blockedRecipient(to, chainIdForNode(nodeUrl));
      const bar = decisionBar({ approveDisabled: Boolean(blocked), getApprovedParams: () => gasEditor.readOverrideGas(gas), sends: true });
      const pay = guardFor(gasEditor, bar, safeBigInt(amountLux, 0n), () => !blocked);
      submitOnGasEnter(gasEditor, bar.approveBtn, { ready: () => !blocked && pay.covered() });
      // To the bridge's account: the memo is the address the bridge pays
      // out to on another chain, and one that isn't an address there is
      // flagged, as are its fee taking the whole amount and a route it
      // doesn't pay out on now.
      const service = bridgeServiceTransfer({ nodeUrl, to, memo, amount: amountLux });
      // A public transfer shows on chain for good: say what, only what
      // applies, and under which name. A shielded one gets no line.
      const visible = service
        ? `Visible to everyone: amount, the recipient on ${service.chain}, and ${me}.`
        : memo
          ? `Visible to everyone: amount, memo, ${me}, and the recipient's account.`
          : `Visible to everyone: amount, ${me}, and the recipient's account.`;
      const amount = { value: formatDuskExact(amountLux), unit: "DUSK" };
      const head = service
        ? requestHead({
            title: `Bridge to ${service.chain}`,
            amount,
            to: service.recipientOk ? plainTo(service.recipient, `on ${service.chain}`) : null,
            // What arrives there, once the bridge takes its fee.
            sub: bridgeServiceLine(service),
            tag: headTag("Known bridge account"),
          })
        : requestHead({ title: "Pay", amount, to: toLine(to) });

      show(
        [
          site,
          head,
          blocked ? warning(BLOCKED_TITLE, blocked) : null,
          // What everyone sees, under the amount, before the fee: in view without scrolling.
          shielded ? null : note(visible, "eye", { className: "ap-visible" }),
          ...(service ? bridgeServiceWarnings(service).map((w) => warning(w.title, w.text)) : []),
          service && !service.recipientOk
            ? warning(
                `The memo isn't an address on ${service.chain}`,
                `The bridge pays out to the address in the memo. Reject this, and check the address on the site.`
              )
            : null,
          siteFee,
          gasEditor,
          group([
            kv("From", shielded ? inWallet(h("span", { text: "Your shielded balance" })) : payerLine(rail)),
            service
              ? kv("To", [h("span", { class: "ap-kv-note", text: `The bridge's account for ${service.chain}` }), h("code", { class: "ap-address", text: to })], {
                  stack: true,
                  className: "ap-to-row",
                })
              : kv("To", h("code", { class: "ap-address", text: to || "(missing)" }), { stack: true, className: "ap-to-row" }),
            service
              ? kv(`Recipient on ${service.chain}`, h("code", { class: "ap-address", text: safeText(memo).text || "(none)" }), { stack: true })
              : memo
                ? kv("Memo", safeTextEl(memo), { stack: memo.length > 24 })
                : null,
          ]),
          details("Details", [group(networkRows(), { className: "group--inset" })]),
        ],
        bar.nodes
      );
      return;
    }

    if (txKind === TX_KIND.CONTRACT_CALL) {
      return renderContractCall({ networkRows, gasEditorFor, guardFor, siteFee, rail, me });
    }

    renderError(`Unknown transaction kind: ${txKind || "(missing kind)"}`);
  }

  async function renderContractCall({ networkRows, gasEditorFor, guardFor, siteFee, rail, me }) {
    const gas = params?.gas ?? null;
    const amountLux = safeBigInt(params?.amount, 0n).toString();
    const depositLux = safeBigInt(params?.deposit, 0n).toString();
    const gasEditor = gasEditorFor(amountLux, [depositLux]);

    const contractIdRaw = params?.contractId;
    let contractIdHex = "";
    try {
      contractIdHex =
        typeof contractIdRaw === "string"
          ? contractIdRaw.startsWith("0x")
            ? contractIdRaw
            : `0x${contractIdRaw}`
          : `0x${bytesToHex(toBytes(contractIdRaw))}`;
    } catch {
      contractIdHex = String(contractIdRaw ?? "");
    }

    // As every Dusk app writes a contract ID: without 0x.
    const contractShown = contractIdText(contractIdHex);

    const fnName = String(params?.fnName ?? "");
    const fnNameTrim = fnName.trim();
    const fnNameLower = fnNameTrim.toLowerCase();

    const argsBytes = callArgs(params);
    const argsOk = Boolean(argsBytes);
    const argsHex = argsOk ? `0x${bytesToHex(argsBytes)}` : "";
    const argsHash = argsOk ? await sha256Hex(argsBytes) : "";
    const callData = argsOk ? argsLine(argsBytes, argsHash) : String(params?.fnArgs ?? "");
    const display = params?.display;
    const sendsLux = safeBigInt(amountLux, 0n) + safeBigInt(depositLux, 0n);

    // The call as a person checks it: the contract and the DUSK it sends,
    // and whom its amount pays when the site names someone.
    const amountTo = String(params?.to ?? "").trim();
    const callRows = ({ from = false } = {}) =>
      group([
        from ? kv("From", payerLine(rail)) : null,
        kv("Contract", contractValueEl(contractLabel(contractShown, nodeUrl), shortMono(contractShown))),
        safeBigInt(amountLux, 0n) > 0n ? kv("Amount", `${formatDuskExact(amountLux)} DUSK`) : null,
        safeBigInt(amountLux, 0n) > 0n && amountTo ? kv("Amount to", h("code", { class: "ap-address", text: amountTo }), { stack: true }) : null,
        safeBigInt(depositLux, 0n) > 0n ? kv("Deposit", `${formatDuskExact(depositLux)} DUSK`) : null,
      ]);
    // Under Details: the network, the function, its arguments' size and hash
    // (the line a site can show to match), the bytes, and the site's words.
    const detailsBlock = () =>
      details("Details", [
        group(
          [
            ...networkRows(),
            kv("Contract ID", mono(contractShown), { stack: true }),
            // The site's name for it, as a memo is shown: what reorders text shows as its code.
            kv("Method", fnName ? safeTextEl(fnName, { mono: true }) : mono("(none)")),
            kv("Call data", mono(callData), { stack: true }),
          ],
          { className: "group--inset" }
        ),
        details("Raw call data", [h("code", { class: "ap-raw", text: argsHex || String(params?.fnArgs ?? "") })]),
        siteDetails(display),
      ]);
    // What everyone sees of a send, as on Send's Review; other calls have no such line.
    const sendVisible = (what) => (rail === "Public" ? note(`Visible to everyone: ${what}, and ${me}.`, "eye", { className: "ap-visible" }) : null);
    // Reject and Approve, with the box to type MAX in: an allowance that is or
    // may be unlimited waits for MAX, and any approval for gas that will do.
    const maxGatedBar = (gated, approveText) => {
      const bar = decisionBar({
        approveText,
        approveDisabled: gated,
        approveTitle: gated ? "Type MAX to enable approval" : "",
        getApprovedParams: () => gasEditor.readOverrideGas(gas),
        sends: true,
      });
      const ackInput = textInput({
        placeholder: "Type MAX to confirm",
        "aria-label": "Type MAX to confirm",
        onEnter: () => bar.approveBtn.click(),
        oninput: () => pay.draw(),
      });
      const acknowledged = () => !gated || String(ackInput.value ?? "").trim().toUpperCase() === "MAX";
      const pay = guardFor(gasEditor, bar, sendsLux, acknowledged);
      submitOnGasEnter(gasEditor, bar.approveBtn, { ready: () => acknowledged() && pay.covered() });
      return { bar, ackInput, pay };
    };

    // A known DuskEVM bridge call: what it does, read from its arguments,
    // above the call and its bytes.
    const bridge = argsOk ? bridgeCallOf(params, { own }) : null;
    if (bridge) {
      const bar = decisionBar({ getApprovedParams: () => gasEditor.readOverrideGas(gas), sends: true });
      const pay = guardFor(gasEditor, bar, sendsLux);
      submitOnGasEnter(gasEditor, bar.approveBtn, { ready: () => pay.covered() });
      const summary = requestSummary("send_tx", params, { own });
      let head;
      let decoded;
      if (bridge.kind === "deposit") {
        // Sent as the bridge expects (bridgeCallOf): its deposit is what it bridges.
        head = requestHead({
          title: summary.title,
          amount: summary.amount,
          to: plainTo(bridge.recipient, "on DuskEVM"),
          tag: headTag("Known DuskEVM bridge call"),
        });
        decoded = group([
          kv("DuskEVM recipient", h("code", { class: "ap-address", text: bridge.recipient }), { stack: true }),
          kv("Amount", `${formatDuskExact(bridge.amountLux)} DUSK`),
          kv("From", payerLine(rail)),
          bridge.extraDataBytes ? kv("Extra data", `${bridge.extraDataBytes} bytes`) : null,
        ]);
      } else {
        // What it costs leads, then the withdrawal and whom it pays, and the
        // cost follows the fee as Custom fee changes it.
        head = requestHead({
          title: summary.title,
          amount: summary.amount,
          to: headTo(summary.to),
          sub: summary.sub,
          tag: headTag("Known DuskEVM bridge call"),
        });
        const cost = head.querySelector(".ap-amount");
        gasEditor.addEventListener("dusk-gas-fee", (event) => cost.replaceChildren(...amountParts(withdrawalCost(event.detail?.feeLux ?? null))));
        const amount = withdrawalAmount(bridge.amountWei);
        decoded = group([
          kv(
            bridge.recipient.kind === "account" ? "Pays to" : "Pays to contract",
            h("code", { class: "ap-address", text: bridge.recipient.kind === "account" ? bridge.recipient.account : bridge.recipient.contractId }),
            { stack: true }
          ),
          kv("Amount", `${amount.value} ${amount.unit}`),
          kv("Sent from DuskEVM", h("code", { class: "ap-address", text: bridge.from }), { stack: true }),
          bridge.proofSubmitter ? kv("Proved by", h("code", { class: "ap-address", text: bridge.proofSubmitter }), { stack: true }) : null,
        ]);
      }

      show(
        [
          site,
          head,
          decoded,
          siteFee,
          gasEditor,
          callRows(),
          detailsBlock(),
        ],
        bar.nodes
      );
      return;
    }

    const wantsDrc20 = argsOk && DRC20_CALL_NAMES.includes(fnNameLower);
    const wantsDrc721 = argsOk && ["approve", "set_approval_for_all", "transfer_from"].includes(fnNameLower);

    // A token call as the engine reads it with each token driver
    // (drc20Calls.js): the call, `unread` when a driver reads it but not as
    // one the wallet can show, or when the engine couldn't read it, or null.
    const tokenCall = wantsDrc20
      ? await sendResult({ type: "DUSK_UI_DRC20_DECODE_INPUT", fnName: fnNameTrim, fnArgs: argsHex }).catch(() => ({ unread: true }))
      : null;
    const drc20 = tokenCall?.fn ? tokenCall : null;

    let drcKind = drc20 ? "DRC20" : "";
    let decoded = null;

    if (!tokenCall && wantsDrc721) {
      try {
        decoded = await sendResult({ type: "DUSK_UI_DRC721_DECODE_INPUT", fnName: fnNameTrim, fnArgs: argsHex });
        drcKind = "DRC721";
      } catch {
        // ignore
      }
    }

    let drcMeta = null;
    if (drcKind === "DRC20") {
      drcMeta = await sendResult({ type: "DUSK_UI_DRC20_GET_METADATA", contractId: contractIdHex, driver: drc20.driver }).catch(() => null);
    }
    if (drcKind === "DRC721") {
      drcMeta = await sendResult({ type: "DUSK_UI_DRC721_GET_METADATA", contractId: contractIdHex }).catch(() => null);
    }

    // Token standards: what the call moves or allows, in the token's units.
    if (drc20) {
      const sym = String(drcMeta?.symbol ?? "").trim() || "TOKEN";
      const name = String(drcMeta?.name ?? "").trim() || "DRC20 token";
      const dec = Number(drcMeta?.decimals ?? 0) || 0;

      // Exact, as an approval shows DUSK: every decimal the token has.
      const units = drc20.amount;
      const amount = groupThousands(formatTokenUnits(units, dec, { maxFrac: dec }));

      const isApprove = drc20.fn === "approve";
      const isIncrease = drc20.fn === "increase_allowance";
      const isTransfer = drc20.fn === "transfer";
      const isMax = (isApprove || isIncrease) && safeBigInt(units, -1n) === MAX_U64;
      // Whom it names: a public account as a payment's recipient; a contract
      // or a shielded address as it is, and which it is.
      const kindOf = (party) => (party.kind === "contract" ? "contract" : party.kind === "shielded" ? "shielded address" : "");
      const partyValue = (party) => [
        kindOf(party) ? h("span", { class: "ap-kv-note", text: `A ${kindOf(party)}` }) : null,
        h("code", { class: "ap-address", text: party.value }),
      ];
      const partyTo = (party) => (kindOf(party) ? plainTo(party.value, "", { evm: false, prefix: `to ${kindOf(party)} ` }) : toLine(party.value));

      const { bar, ackInput, pay } = maxGatedBar(isMax, isTransfer ? "Approve transfer" : isApprove || isIncrease ? "Approve spending" : "Approve");

      show(
        [
          site,
          requestHead({
            title: isApprove
              ? "Allow spending?"
              : isIncrease
                ? "Allow more spending?"
                : drc20.fn === "decrease_allowance"
                  ? "Allow less spending?"
                  : "Send tokens",
            amount: { value: amount, unit: sym },
            to: drc20.to ? partyTo(drc20.to) : null,
            sub: `${name} · DRC20`,
          }),
          // A transfer names whom it pays; an allowance moves nothing yet.
          drc20.to ? sendVisible("this call, the tokens it moves") : null,
          group([
            kv("From", payerLine(rail)),
            drc20.to ? kv("To", partyValue(drc20.to), { stack: true }) : null,
            drc20.spender ? kv("Spender", partyValue(drc20.spender), { stack: true }) : null,
            drc20.owner ? kv("Owner", partyValue(drc20.owner), { stack: true }) : null,
            kv("Token", h("span", {}, [h("span", { text: `${name} (${sym}) ` }), shortMono(contractShown)])),
            kv("Units", mono(units)),
          ]),
          isMax
            ? warning("Unlimited allowance", "This lets the spender move all of this token from your account, now and later. Only continue if you trust it.", [ackInput])
            : null,
          callRows(),
          siteFee,
          gasEditor,
          detailsBlock(),
        ],
        bar.nodes
      );
      return;
    }

    if (drcKind === "DRC721" && decoded && typeof decoded === "object") {
      const sym = String(drcMeta?.symbol ?? "").trim() || "NFT";
      const name = String(drcMeta?.name ?? "").trim() || "DRC721";

      const approvedStr = accountEnumToString(decoded?.approved);
      const operatorStr = accountEnumToString(decoded?.operator);
      const fromStr = accountEnumToString(decoded?.from);
      const toStr = accountEnumToString(decoded?.to);
      const tokenIdStr =
        decoded?.token_id != null ? String(decoded.token_id) : decoded?.tokenId != null ? String(decoded.tokenId) : "";

      const isApprove = fnNameLower === "approve";
      const isSetApprovalForAll = fnNameLower === "set_approval_for_all";
      const isTransferFrom = fnNameLower === "transfer_from";
      const approvedBool = Boolean(decoded?.approved);

      const bar = decisionBar({
        approveText: isTransferFrom ? "Approve transfer" : "Approve",
        getApprovedParams: () => gasEditor.readOverrideGas(gas),
        sends: true,
      });
      const pay = guardFor(gasEditor, bar, sendsLux);
      submitOnGasEnter(gasEditor, bar.approveBtn, { ready: () => pay.covered() });

      show(
        [
          site,
          requestHead({
            title: isTransferFrom ? "Send an NFT" : isSetApprovalForAll ? "Allow all your NFTs?" : "Allow an NFT?",
            to: isTransferFrom && toStr ? toLine(toStr) : null,
            sub: `${name} (${sym})${tokenIdStr ? ` · #${tokenIdStr}` : ""}`,
          }),
          isTransferFrom ? sendVisible("this call") : null,
          group([
            kv("From", payerLine(rail)),
            tokenIdStr ? kv("Token ID", mono(tokenIdStr)) : null,
            isApprove ? kv("Approved", h("code", { class: "ap-address", text: approvedStr || "(missing)" }), { stack: true }) : null,
            isSetApprovalForAll ? kv("Operator", h("code", { class: "ap-address", text: operatorStr || "(missing)" }), { stack: true }) : null,
            isSetApprovalForAll ? kv("Approved for all", approvedBool ? "Yes" : "No") : null,
            isTransferFrom ? kv("Owner", h("code", { class: "ap-address", text: fromStr || "(missing)" }), { stack: true }) : null,
            isTransferFrom ? kv("To", h("code", { class: "ap-address", text: toStr || "(missing)" }), { stack: true }) : null,
            kv("Collection", shortMono(contractShown)),
          ]),
          isSetApprovalForAll && approvedBool
            ? warning("High risk", "This lets the operator move all of your NFTs in this collection.")
            : null,
          callRows(),
          siteFee,
          gasEditor,
          detailsBlock(),
        ],
        bar.nodes
      );
      return;
    }

    // Any other call: the wallet can't read its arguments, so it says so. One
    // to the bridge's contracts that isn't a transfer it knows, such as a
    // withdrawal off the bridge's route, gets a warning, as does a token call
    // a driver reads but not as one the wallet can show. Such a call that sets
    // an allowance may be unlimited, so it waits for MAX.
    const unreadAllowance = Boolean(tokenCall) && ["approve", "increase_allowance"].includes(fnNameLower);
    const { bar, ackInput, pay } = maxGatedBar(unreadAllowance);
    const summary = requestSummary("send_tx", params, { own });
    const unchecked = callsBridge({ nodeUrl: params?.nodeUrl, contractId: contractIdHex })
      ? warning(
          "The wallet can't check this bridge call",
          "It goes to the DuskEVM bridge, but it isn't a transfer the wallet knows for this network. Reject it unless you know why the site sent it."
        )
      : tokenCall
        ? warning(
            "The wallet can't read this request",
            "It looks like a token call, but the wallet can't show its amount or the accounts it names. Reject it unless you know what the site sent."
          )
        : note("The wallet can't read this call's arguments. Check them on the site before you approve.", "alert", {
            className: "ap-opaque",
          });
    show(
      [
        site,
        requestHead({
          title: summary.title,
          amount: sendsLux > 0n ? { value: formatDuskExact(sendsLux), unit: "DUSK" } : null,
        }),
        callRows({ from: true }),
        unchecked,
        unreadAllowance
          ? warning(
              "This may be an unlimited allowance",
              "The wallet can't check how much this lets the spender move. It could be all of this token, now and later. Only continue if you trust the site.",
              [ackInput]
            )
          : null,
        siteFee,
        gasEditor,
        detailsBlock(),
      ],
      bar.nodes
    );
  }
}

export function mountNotification() {
  renderNotification().catch((e) => renderError(e?.message ?? String(e)));
}
