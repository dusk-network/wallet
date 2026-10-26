// The window a site's request opens: the site that asks and what it asks for
// first, then the facts that matter, with Reject and the approve button fixed
// at the bottom where they always show. Chain, node and raw bytes sit under
// Details. A locked wallet shows what is asked, with Unlock and Reject.

import { UI_DISPLAY_DECIMALS, safeBigInt } from "../../shared/amount.js";
import { bytesToHex, sha256Hex, toBytes } from "../../shared/bytes.js";
import { TX_KIND } from "../../shared/constants.js";
import { classifyDuskIdentifier } from "../../shared/duskIdentifiers.js";
import { networkNameFromNodeUrl } from "../../shared/network.js";
import { flattenTypedMessage, prepareTypedDataDisclosure, sanitizeStringForDisplay } from "../../shared/typedDataDisplay.js";
import { duskNamesNetwork } from "../../shared/verifiedNames.js";
import { h, setChildren } from "../lib/dom.js";
import { shortAddress } from "../lib/strings.js";
import { passwordInput, submitOnGasEnter, textInput } from "../components/FormControls.js";
import { shortAddressEl } from "../components/ShortAddress.js";
import "../components/GasEditor.js";
import {
  details,
  exactDusk,
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
import { bridgeCallOf, callArgs, requestSummary, withdrawalAmount } from "./summary.js";
import { runtimeGetURL, runtimeSendMessage, tabsCreate } from "../../platform/extensionApi.js";

const app = document.getElementById("app");
const MAX_U64 = 18446744073709551615n;

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

function show(body, actions = []) {
  setChildren(app, body.filter(Boolean));
  const bar = actionsHost();
  const kept = actions.filter(Boolean);
  setChildren(bar, kept);
  bar.hidden = kept.length === 0;
}

function renderError(text) {
  show([h("div", { class: "err", role: "alert", text })]);
}

// The network the request is on, in the header beside the wallet's name.
function showNetwork(name) {
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A time as the popup writes it: "26 Oct 2026, 14:10". One that isn't a
// time shows as it came.
function dateText(value) {
  const d = new Date(String(value ?? ""));
  if (!Number.isFinite(d.getTime())) return String(value ?? "");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

// The network of a known chain ID: "dusk:2" is Testnet.
function chainName(chainId) {
  return { "dusk:1": "Mainnet", "dusk:2": "Testnet", "dusk:3": "Devnet", "dusk:0": "Local" }[String(chainId ?? "").trim()] ?? "";
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
    return;
  }
  startActivityHeartbeat();
});

document.addEventListener(
  "click",
  () => {
    if (approvalLive) sendActivity();
  },
  { passive: true }
);

async function decide(decision, approvedParams) {
  await send({ type: "DUSK_PENDING_DECISION", rid, decision, ...(decision === "approve" ? { approvedParams } : {}) });
  window.close();
}

/**
 * Reject and the approve button, side by side. Input that won't do (a gas
 * edit, a missing MAX) says so above them; nothing is sent.
 */
function decisionBar({ approveText = "Approve", approveDisabled = false, approveTitle = "", getApprovedParams } = {}) {
  const error = h("div", { class: "field-error ap-actions__error", role: "alert", hidden: true });
  const rejectBtn = h("button", {
    class: "btn-outline",
    type: "button",
    text: "Reject",
    onclick: () => decide("reject"),
  });
  const approveBtn = h("button", {
    class: "btn-primary",
    type: "button",
    text: approveText,
    disabled: Boolean(approveDisabled),
    title: approveTitle || undefined,
    onclick: async () => {
      let approvedParams = null;
      try {
        approvedParams = typeof getApprovedParams === "function" ? getApprovedParams() : null;
      } catch (e) {
        error.textContent = e?.message ?? String(e);
        error.hidden = false;
        return;
      }
      error.hidden = true;
      await decide("approve", approvedParams);
    },
  });
  return { nodes: [error, rejectBtn, approveBtn], approveBtn, rejectBtn, error };
}

export async function renderNotification() {
  if (!rid) {
    renderError("Missing request id.");
    return;
  }

  const pending = await send({ type: "DUSK_GET_PENDING", rid });
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

  // The network: a transaction's own, which it was approved for, a
  // signature's chain, or the wallet's.
  const nodeUrl = String(params?.nodeUrl ?? pending.nodeUrl ?? "");
  showNetwork(
    String(params?.networkName ?? "") || chainName(params?.chainId) || String(pending.networkName ?? "") || (nodeUrl ? networkNameFromNodeUrl(nodeUrl) : "")
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

  // The profile that signs or pays: its verified .dusk name over its short
  // account, or the account in full without one.
  const profileValue = (account = activeAccount) => {
    const name = nameOf(account);
    if (!account || !name) return h("span", { class: "named-address" }, [h("code", { text: account || "(none)" })]);
    return h("span", { class: "named-address" }, [h("span", { class: "dusk-name", text: name, title: name }), shortAddressEl(account)]);
  };
  // The paying profile in one line: "alice.dusk · Public".
  const payerLine = (rail) => {
    const name = nameOf(activeAccount);
    return h("span", {}, [
      name ? h("span", { text: name, title: activeAccount }) : shortMono(activeAccount, 6, 6),
      h("span", { class: "kv-muted", text: ` · ${rail}` }),
    ]);
  };

  // Who the wallet knows an account or address as: one of its profiles, by
  // its public account or shielded address, or a saved contact. A site picks
  // the address, so it must be the saved one exactly: base58 tells cases
  // apart.
  const ownAddresses = Array.isArray(addresses) ? addresses : [];
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
          if (typeof name === "string" && name) showName(name);
        })
        .catch(() => {});
    }
    const tag = known
      ? h("span", { class: "ap-recipient__tag", title: known.label }, [
          h("span", { class: "ap-recipient__label", text: known.label }),
          h("span", { class: "ap-recipient__source", text: ` · ${known.source}` }),
        ])
      : null;
    return { lead, tag, known };
  };

  // "to wallet-both.dusk", and under it your label for it, for a head's
  // `to` line.
  const toLine = (address, { network = "" } = {}) => {
    const r = recipient(address);
    return h("span", { class: "ap-recipient" }, [
      h("span", { class: "ap-recipient__line" }, [
        h("span", { class: "ap-recipient__to", text: "to " }),
        r.lead,
        network ? h("span", { class: "ap-recipient__to", text: ` ${network}` }) : null,
      ]),
      r.tag,
    ]);
  };
  // An address without a name: "to 0x96BA…893e on DuskEVM".
  const plainTo = (value, network, head = 6, tail = 4) =>
    h("span", { class: "ap-recipient" }, [
      h("span", { class: "ap-recipient__line" }, [
        h("span", { class: "ap-recipient__to", text: "to " }),
        shortMono(value, head, tail),
        network ? h("span", { class: "ap-recipient__to", text: ` ${network}` }) : null,
      ]),
    ]);

  const site = siteChip(origin);

  if (!hasVault) {
    show(
      [
        site,
        requestHead({ title: "Set up Dusk Wallet first", sub: "Create or import a recovery phrase, then try again on the site." }),
      ],
      [
        h("button", { class: "btn-outline", type: "button", text: "Reject", onclick: () => decide("reject") }),
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

  // ---- Locked --------------------------------------------------------------

  // What the site asks, then the password, with Reject beside Unlock: no
  // need to unlock to say no.
  function renderLocked() {
    const summary = requestSummary(kindNorm, params);
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

    const to =
      summary.to?.network === "duskevm"
        ? plainTo(summary.to.address, "on DuskEVM")
        : summary.to?.address
          ? toLine(summary.to.address)
          : null;

    show(
      [
        site,
        requestHead({ title: summary.title, amount: summary.amount, to, sub: summary.sub }),
        h("div", { class: "ap-unlock" }, [
          h("label", { for: "approval-password", text: "Unlock to review and approve it" }),
          pwd,
          errLine,
          busyNote,
        ]),
      ],
      [h("button", { class: "btn-outline", type: "button", text: "Reject", onclick: () => decide("reject") }), unlockBtn]
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
                  sub: `${who ? `${who}, ` : ""}until you disconnect it`,
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
          sectionTitle(choosing ? "Choose a profile" : "Profile", "connect-profile-label"),
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

  function renderSwitchNetwork() {
    const from = params?.from ?? {};
    const to = params?.to ?? {};
    const net = (n) =>
      h("span", { class: "ap-net-value" }, [
        h("span", { text: String(n.networkName ?? "Unknown") }),
        n.chainId ? h("span", { class: "kv-muted", text: ` · ${n.chainId}` }) : null,
      ]);
    show(
      [
        site,
        requestHead({ title: requestSummary("switch_network", params).title, sub: "The wallet then uses that network, for every site." }),
        group([kv("From", net(from)), kv("To", net(to))]),
        details("Details", [
          group(
            [
              from.nodeUrl ? kv("From node", mono(from.nodeUrl), { stack: true }) : null,
              to.nodeUrl ? kv("To node", mono(to.nodeUrl), { stack: true }) : null,
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
      message = h("section", { class: "ap-message-wrap", "aria-labelledby": "ap-message-title" }, [
        sectionTitle(preview.truncated ? "Message, shortened" : "Message", "ap-message-title"),
        h("div", {
          class: "ap-message",
          text: String(preview.text ?? ""),
          title: preview.truncated ? "Preview shortened; the hash covers the full message." : undefined,
        }),
        preview.truncated ? h("p", { class: "ap-sub", text: "Shortened here. The hash below covers the full message." }) : null,
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
        details("Details", [group([kv("Network", chainName(chainId) || "Custom network"), kv("Chain ID", mono(chainId || "—"))], { className: "group--inset" })]),
      ],
      decisionBar({ approveText: "Sign" }).nodes
    );
  }

  // ---- Sign in -------------------------------------------------------------

  function renderSignAuth() {
    const chainId = String(params?.chainId ?? "");
    const nonce = String(params?.nonce ?? "");
    const statement = String(params?.statement ?? "").trim();
    const expiresAt = String(params?.expiresAt ?? "").trim();

    show(
      [
        site,
        requestHead({ title: "Sign in to this site?" }),
        statement
          ? h("section", { class: "ap-message-wrap", "aria-labelledby": "ap-statement-title" }, [
              sectionTitle("The site's statement", "ap-statement-title"),
              h("div", { class: "ap-message", text: statement }),
            ])
          : null,
        group([
          kv("Account", profileValue()),
          kv("Nonce", mono(nonce || "—"), { stack: nonce.length > 24 }),
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
    const unsafeTextFlags = ["control_chars", "bidi_control", "invalid_surrogate", "invisible_format", "line_separator", "non_nfc"];
    const hasTextSafetyWarning = [originPreview, domainName, domainVersion, domainChainId, ...rows].some((row) =>
      (row.flags ?? []).some((flag) => unsafeTextFlags.includes(flag))
    );

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
              "Text needs review",
              "Some origin, domain or message text contains controls, formatting characters, line separators or non-NFC sequences. The preview may use placeholders or escapes. Inspect the originals in Full signing request before signing."
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
          kv("Contract", contractId ? shortMono(contractId) : "(missing)"),
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
    const networkName = String(params?.networkName ?? "") || networkNameFromNodeUrl(nodeUrl);
    const privacy = String(params?.privacy ?? (txKind === TX_KIND.CONTRACT_CALL ? "public" : "")).trim().toLowerCase();
    const shielded = privacy === "shielded";
    const rail = shielded ? "Shielded" : "Public";
    const gas = params?.gas ?? null;
    // Who a public transaction shows as: the profile's verified .dusk name,
    // or its account when it has none.
    const myName = nameOf(activeAccount);
    const me = myName ? `your name ${myName}` : "your account";

    // The network's lines, which most people skip.
    const networkRows = () => [
      kv("Network", networkName || "Unknown"),
      txChainId ? kv("Chain ID", mono(txChainId)) : null,
      nodeUrl ? kv("Node", mono(nodeUrl), { stack: true }) : null,
    ];

    const gasEditorFor = (amountLux, extraLux = []) => {
      const gasEditor = document.createElement("dusk-gas-editor");
      gasEditor.amountLux = amountLux;
      gasEditor.extraLux = extraLux;
      gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;
      gasEditor.helpText = "Max fee = gas limit × gas price. Only the gas used is charged. Clear both to use the defaults.";
      gasEditor.setGas(gas);
      return gasEditor;
    };

    if (txKind === TX_KIND.TRANSFER) {
      const to = String(params?.to ?? "").trim();
      const amountLux = safeBigInt(params?.amount, 0n).toString();
      const memo = String(params?.memo ?? "");
      const gasEditor = gasEditorFor(amountLux);
      const bar = decisionBar({ getApprovedParams: () => gasEditor.readOverrideGas(gas) });
      submitOnGasEnter(gasEditor, bar.approveBtn);
      // A public transfer shows on chain for good: say what, only what
      // applies, and under which name. A shielded one gets no line.
      const visible = memo
        ? `Visible to everyone: amount, memo, and ${me}.`
        : `Visible to everyone: amount and ${me}.`;

      show(
        [
          site,
          requestHead({ title: "Pay", amount: { value: exactDusk(amountLux), unit: "DUSK" }, to: toLine(to) }),
          gasEditor,
          shielded ? null : note(visible, "eye", { className: "ap-visible" }),
          group([
            kv("From", shielded ? "Your shielded balance" : payerLine(rail)),
            kv("To", h("code", { class: "ap-address", text: to || "(missing)" }), { stack: true, className: "ap-to-row" }),
            memo ? kv("Memo", memo, { stack: memo.length > 24 }) : null,
          ]),
          details("Details", [group(networkRows(), { className: "group--inset" })]),
        ],
        bar.nodes
      );
      return;
    }

    if (txKind === TX_KIND.CONTRACT_CALL) {
      return renderContractCall({ networkRows, gasEditorFor, rail, me });
    }

    renderError(`Unknown transaction kind: ${txKind || "(missing kind)"}`);
  }

  async function renderContractCall({ networkRows, gasEditorFor, rail, me }) {
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

    // The call itself: contract, function and its arguments' size and hash,
    // which the site can show too; the bytes themselves under Raw call data.
    const callRows = ({ from = false } = {}) =>
      group([
        from ? kv("From", payerLine(rail)) : null,
        kv("Contract", shortMono(contractIdHex)),
        kv("Function", mono(fnName || "(none)")),
        kv("Call data", mono(callData), { stack: true }),
        safeBigInt(amountLux, 0n) > 0n ? kv("Amount", `${exactDusk(amountLux)} DUSK`) : null,
        safeBigInt(depositLux, 0n) > 0n ? kv("Deposit", `${exactDusk(depositLux)} DUSK`) : null,
      ]);
    const rawData = () =>
      details("Raw call data", [h("code", { class: "ap-raw", text: argsHex || String(params?.fnArgs ?? "") })]);
    const detailsBlock = () =>
      details("Details", [group([...networkRows(), kv("Contract ID", mono(contractIdHex), { stack: true })], { className: "group--inset" })]);
    const visible = (what) => (rail === "Public" ? note(`Visible to everyone: ${what}, and ${me}.`, "eye", { className: "ap-visible" }) : null);

    // A known DuskEVM bridge call: what it does, read from its arguments,
    // above the call and its bytes.
    const bridge = argsOk ? bridgeCallOf(params) : null;
    if (bridge) {
      const bar = decisionBar({ getApprovedParams: () => gasEditor.readOverrideGas(gas) });
      submitOnGasEnter(gasEditor, bar.approveBtn);
      const summary = requestSummary("send_tx", params);
      let head;
      let decoded;
      let extra = null;
      if (bridge.kind === "deposit") {
        // A deposit that sends other DUSK than it bridges is the bridge's
        // call, but not one to approve without asking why.
        const matches = bridge.sentLux === bridge.amountLux;
        head = requestHead({
          title: summary.title,
          amount: summary.amount,
          to: plainTo(bridge.recipient, "on DuskEVM"),
          tag: matches ? headTag("Known DuskEVM bridge call") : null,
        });
        decoded = group([
          kv("DuskEVM recipient", h("code", { class: "ap-address", text: bridge.recipient }), { stack: true }),
          kv("Amount", `${exactDusk(bridge.amountLux)} DUSK`),
          kv("From", payerLine(rail)),
          bridge.extraDataBytes ? kv("Extra data", `${bridge.extraDataBytes} bytes`) : null,
        ]);
        if (!matches) {
          extra = warning(
            "The amounts don't match",
            `This call sends ${exactDusk(depositLux)} DUSK but bridges ${exactDusk(bridge.amountLux)} DUSK. Reject it unless the site told you why.`
          );
        }
      } else {
        const paysTo =
          bridge.recipient.kind === "account"
            ? toLine(bridge.recipient.account, { network: "on Dusk" })
            : plainTo(bridge.recipient.contractId, "on Dusk, a contract", 6, 6);
        head = requestHead({
          title: summary.title,
          amount: withdrawalAmount(bridge.amountWei),
          to: paysTo,
          tag: headTag("Known DuskEVM bridge call"),
        });
        const amount = withdrawalAmount(bridge.amountWei);
        decoded = group([
          kv(
            bridge.recipient.kind === "account" ? "Pays to" : "Pays to contract",
            h("code", { class: "ap-address", text: bridge.recipient.kind === "account" ? bridge.recipient.account : bridge.recipient.contractId }),
            { stack: true }
          ),
          kv("Amount", `${amount.value} ${amount.unit}`),
          kv("Sent from DuskEVM", h("code", { class: "ap-address", text: bridge.sender }), { stack: true }),
          bridge.proofSubmitter ? kv("Proved by", h("code", { class: "ap-address", text: bridge.proofSubmitter }), { stack: true }) : null,
        ]);
        extra = note(
          bridge.kind === "prove"
            ? "Proving moves no DUSK. You claim it once the waiting period ends."
            : "Claiming pays this DUSK to the account above. You pay only the network fee.",
          "info"
        );
      }

      show(
        [
          site,
          head,
          decoded,
          extra,
          gasEditor,
          visible(bridge.kind === "deposit" ? "the amount, the DuskEVM recipient" : "this call, the withdrawal"),
          callRows(),
          rawData(),
          siteDetails(display),
          detailsBlock(),
        ],
        bar.nodes
      );
      return;
    }

    const wantsDrc20 = argsOk && ["transfer", "approve", "transfer_from"].includes(fnNameLower);
    const wantsDrc721 = argsOk && ["approve", "set_approval_for_all", "transfer_from"].includes(fnNameLower);

    let drcKind = "";
    let drcDriver = "";
    let decoded = null;

    if (wantsDrc20) {
      try {
        decoded = await sendResult({ type: "DUSK_UI_DRC20_DECODE_INPUT", fnName: fnNameTrim, fnArgs: argsHex });
        drcKind = "DRC20";
        drcDriver = "drc20";
      } catch {
        try {
          decoded = await sendResult({
            type: "DUSK_UI_DRC20_DECODE_INPUT",
            fnName: fnNameTrim,
            fnArgs: argsHex,
            driver: "sozu_staked_dusk",
          });
          drcKind = "DRC20";
          drcDriver = "sozu_staked_dusk";
        } catch {
          // ignore
        }
      }
    }

    if (!drcKind && wantsDrc721) {
      try {
        decoded = await sendResult({ type: "DUSK_UI_DRC721_DECODE_INPUT", fnName: fnNameTrim, fnArgs: argsHex });
        drcKind = "DRC721";
      } catch {
        // ignore
      }
    }

    let drcMeta = null;
    if (drcKind === "DRC20") {
      drcMeta = await sendResult({ type: "DUSK_UI_DRC20_GET_METADATA", contractId: contractIdHex, driver: drcDriver }).catch(() => null);
    }
    if (drcKind === "DRC721") {
      drcMeta = await sendResult({ type: "DUSK_UI_DRC721_GET_METADATA", contractId: contractIdHex }).catch(() => null);
    }

    // Token standards: what the call moves or allows, in the token's units.
    if (drcKind === "DRC20" && decoded && typeof decoded === "object") {
      const sym = String(drcMeta?.symbol ?? "").trim() || "TOKEN";
      const name = String(drcMeta?.name ?? "").trim() || "DRC20 token";
      const dec = Number(drcMeta?.decimals ?? 0) || 0;

      const toStr = accountEnumToString(decoded?.to);
      const spenderStr = accountEnumToString(decoded?.spender);
      const ownerStr = accountEnumToString(decoded?.owner);
      const valueUnitsStr = decoded?.value != null ? String(decoded.value) : "";
      const valueHuman = valueUnitsStr ? formatTokenUnits(valueUnitsStr, dec, { maxFrac: UI_DISPLAY_DECIMALS }) : "—";

      const isApprove = fnNameLower === "approve";
      const isTransfer = fnNameLower === "transfer";
      const isTransferFrom = fnNameLower === "transfer_from";
      const isMax = isApprove && safeBigInt(valueUnitsStr, -1n) === MAX_U64;

      const bar = decisionBar({
        approveText: isTransfer ? "Approve transfer" : isApprove ? "Approve spending" : "Approve",
        approveDisabled: Boolean(isMax),
        approveTitle: isMax ? "Type MAX to enable approval" : "",
        getApprovedParams: () => gasEditor.readOverrideGas(gas),
      });
      submitOnGasEnter(gasEditor, bar.approveBtn);
      const ackInput = textInput({
        placeholder: "Type MAX to confirm",
        "aria-label": "Type MAX to confirm",
        onEnter: () => bar.approveBtn.click(),
        oninput: () => {
          bar.approveBtn.disabled = String(ackInput.value ?? "").trim().toUpperCase() !== "MAX";
        },
      });

      show(
        [
          site,
          requestHead({
            title: isApprove ? "Allow spending?" : "Send tokens",
            amount: valueUnitsStr ? { value: valueHuman, unit: sym } : null,
            to: (isTransfer || isTransferFrom) && toStr ? toLine(toStr) : null,
            sub: `${name} · DRC20`,
          }),
          group([
            kv("From", payerLine(rail)),
            isTransfer || isTransferFrom ? kv("To", h("code", { class: "ap-address", text: toStr || "(missing)" }), { stack: true }) : null,
            isApprove ? kv("Spender", h("code", { class: "ap-address", text: spenderStr || "(missing)" }), { stack: true }) : null,
            isTransferFrom ? kv("Owner", h("code", { class: "ap-address", text: ownerStr || "(missing)" }), { stack: true }) : null,
            kv("Token", h("span", {}, [h("span", { text: `${name} (${sym}) ` }), shortMono(contractIdHex, 6, 6)])),
            valueUnitsStr ? kv("Units", mono(valueUnitsStr)) : null,
          ]),
          isMax
            ? warning("Unlimited allowance", "This lets the spender move all of this token from your account, now and later. Only continue if you trust it.", [ackInput])
            : null,
          callRows(),
          rawData(),
          gasEditor,
          visible("this call, the tokens it moves"),
          siteDetails(display),
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
      });
      submitOnGasEnter(gasEditor, bar.approveBtn);

      show(
        [
          site,
          requestHead({
            title: isTransferFrom ? "Send an NFT" : isSetApprovalForAll ? "Allow all your NFTs?" : "Allow an NFT?",
            to: isTransferFrom && toStr ? toLine(toStr) : null,
            sub: `${name} (${sym})${tokenIdStr ? ` · #${tokenIdStr}` : ""}`,
          }),
          group([
            kv("From", payerLine(rail)),
            tokenIdStr ? kv("Token ID", mono(tokenIdStr)) : null,
            isApprove ? kv("Approved", h("code", { class: "ap-address", text: approvedStr || "(missing)" }), { stack: true }) : null,
            isSetApprovalForAll ? kv("Operator", h("code", { class: "ap-address", text: operatorStr || "(missing)" }), { stack: true }) : null,
            isSetApprovalForAll ? kv("Approved for all", approvedBool ? "Yes" : "No") : null,
            isTransferFrom ? kv("Owner", h("code", { class: "ap-address", text: fromStr || "(missing)" }), { stack: true }) : null,
            isTransferFrom ? kv("To", h("code", { class: "ap-address", text: toStr || "(missing)" }), { stack: true }) : null,
            kv("Collection", shortMono(contractIdHex, 6, 6)),
          ]),
          isSetApprovalForAll && approvedBool
            ? warning("High risk", "This lets the operator move all of your NFTs in this collection.")
            : null,
          callRows(),
          rawData(),
          gasEditor,
          visible("this call"),
          siteDetails(display),
          detailsBlock(),
        ],
        bar.nodes
      );
      return;
    }

    // Any other call: the wallet can't read its arguments, so it says so.
    const bar = decisionBar({ getApprovedParams: () => gasEditor.readOverrideGas(gas) });
    submitOnGasEnter(gasEditor, bar.approveBtn);
    const summary = requestSummary("send_tx", params);
    show(
      [
        site,
        requestHead({
          title: summary.title,
          amount: sendsLux > 0n ? { value: exactDusk(sendsLux), unit: "DUSK" } : null,
          sub: fnNameTrim ? h("span", {}, ["Calls ", mono(fnNameTrim)]) : null,
        }),
        callRows({ from: true }),
        note("The wallet can't read this call's arguments. Check them on the site before you approve.", "alert", {
          className: "ap-opaque",
        }),
        gasEditor,
        visible("this call, the DUSK it sends"),
        rawData(),
        siteDetails(display),
        detailsBlock(),
      ],
      bar.nodes
    );
  }
}

export function mountNotification() {
  renderNotification().catch((e) => renderError(e?.message ?? String(e)));
}
