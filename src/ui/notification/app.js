import { UI_DISPLAY_DECIMALS, formatLuxShort, safeBigInt } from "../../shared/amount.js";
import { bytesToHex, sha256Hex, toBytes } from "../../shared/bytes.js";
import { TX_KIND } from "../../shared/constants.js";
import { h } from "../lib/dom.js";
import { truncateMiddle } from "../lib/strings.js";
import "../components/GasEditor.js";
import {
  runtimeGetURL,
  runtimeSendMessage,
  tabsCreate,
} from "../../platform/extensionApi.js";

const app = document.getElementById("app");
const MAX_U64 = 18446744073709551615n;

function setApp(children) {
  app.innerHTML = "";
  for (const child of children) app.appendChild(child);
}

async function send(msg) {
  return runtimeSendMessage(msg, { allowLastError: true });
}

function getRid() {
  const url = new URL(window.location.href);
  return url.searchParams.get("rid") || "";
}

function renderError(text) {
  setApp([h("div", { class: "err", text })]);
}

function prettyAmount(v) {
  try {
    return BigInt(v).toString();
  } catch {
    return String(v);
  }
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

// Keep the approval window alive while the user is actively reviewing it.
let activityHeartbeatTimer = null;

function startActivityHeartbeat() {
  if (activityHeartbeatTimer) return;
  send({ type: "DUSK_UI_ACTIVITY" }).catch(() => {});
  activityHeartbeatTimer = setInterval(() => {
    send({ type: "DUSK_UI_ACTIVITY" }).catch(() => {});
  }, 30_000);
}

function stopActivityHeartbeat() {
  if (!activityHeartbeatTimer) return;
  clearInterval(activityHeartbeatTimer);
  activityHeartbeatTimer = null;
}

startActivityHeartbeat();

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
    send({ type: "DUSK_UI_ACTIVITY" }).catch(() => {});
  },
  { passive: true }
);

export async function renderNotification() {
  const rid = getRid();
  if (!rid) {
    renderError("Missing request id.");
    return;
  }

  const pending = await send({ type: "DUSK_GET_PENDING", rid });
  if (!pending) {
    renderError("Request not found (maybe already handled). You can close this window.");
    return;
  }

  const {
    kind,
    origin,
    params,
    hasVault,
    isUnlocked,
    accounts,
    accountCount,
    selectedAccountIndex,
    accountNames,
    permissionAccountIndex,
  } = pending;
  // Normalize request kind defensively. In some environments the value might
  // include whitespace or differ in casing (e.g. service worker restarts,
  // serialization quirks). The UI should still render the correct screen.
  const kindNorm = String(kind ?? "")
    .trim()
    .toLowerCase();

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

  const header = h("div", { class: "row" }, [
    h("div", { class: "muted", text: "Request from" }),
    h("div", { class: "box" }, [h("code", { text: origin })]),
  ]);

  if (!hasVault) {
    const openBtn = h("button", {
      class: "btn-primary",
      text: "Set up wallet",
      onclick: async () => {
        try {
          const url = runtimeGetURL("full.html");
          await tabsCreate({ url });
        } catch {
          // ignore
        }
        window.close();
      },
    });

    setApp([
      header,
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Your Dusk Wallet is not set up yet." }),
        h("div", { class: "muted", text: "Create or import a recovery phrase to continue." }),
        h("div", { class: "btnrow" }, [openBtn]),
      ]),
    ]);
    return;
  }

  const lockBox = () => {
    const pwd = h("input", { type: "password", placeholder: "Password" });
    const unlockBtn = h("button", {
      class: "btn-primary",
      text: "Unlock",
      onclick: async () => {
        const res = await send({ type: "DUSK_UI_UNLOCK", password: pwd.value });
        if (res?.error) {
          renderError(res.error.message || "Unlock failed");
          return;
        }
        await renderNotification();
      },
    });

    return h("div", { class: "row" }, [
      h("div", { class: "muted", text: "Wallet locked. Unlock to proceed." }),
      h("div", { class: "row" }, [pwd]),
      h("div", { class: "btnrow" }, [unlockBtn]),
    ]);
  };

  const decisionButtons = (approveText, getApprovedParams) =>
    h("div", { class: "btnrow" }, [
      h("button", {
        class: "btn-outline",
        text: "Reject",
        onclick: async () => {
          await send({ type: "DUSK_PENDING_DECISION", rid, decision: "reject" });
          window.close();
        },
      }),
      h("button", {
        class: "btn-primary",
        text: approveText,
        onclick: async () => {
          try {
            const approvedParams = typeof getApprovedParams === "function" ? getApprovedParams() : null;
            await send({
              type: "DUSK_PENDING_DECISION",
              rid,
              decision: "approve",
              approvedParams,
            });
            window.close();
          } catch (e) {
            // Keep it simple for MVP: block approval if inputs are invalid.
            alert(e?.message ?? String(e));
          }
        },
      }),
    ]);

  function decisionButtonsWithState({ approveText, approveDisabled, approveTitle, getApprovedParams } = {}) {
    const rejectBtn = h("button", {
      class: "btn-outline",
      text: "Reject",
      onclick: async () => {
        await send({ type: "DUSK_PENDING_DECISION", rid, decision: "reject" });
        window.close();
      },
    });

    const approveBtn = h("button", {
      class: "btn-primary",
      text: approveText || "Approve",
      disabled: Boolean(approveDisabled),
      title: approveTitle || "",
      onclick: async () => {
        try {
          const approvedParams =
            typeof getApprovedParams === "function" ? getApprovedParams() : null;
          await send({
            type: "DUSK_PENDING_DECISION",
            rid,
            decision: "approve",
            approvedParams,
          });
          window.close();
        } catch (e) {
          alert(e?.message ?? String(e));
        }
      },
    });

    return { row: h("div", { class: "btnrow" }, [rejectBtn, approveBtn]), approveBtn, rejectBtn };
  }

  if (!isUnlocked) {
    setApp([header, lockBox()]);
    return;
  }

  if (kindNorm === "connect") {
    const count = Math.max(1, Number(accountCount ?? (accountsArr.length || 1)) || 1);
    const displayAccounts = accountsArr.length
      ? accountsArr
      : Array.from({ length: count }, () => "");

    const nameMap = accountNames && typeof accountNames === "object" ? accountNames : {};

    const accountSelect = h(
      "select",
      {},
      displayAccounts.map((acct, i) =>
        h("option", {
          value: String(i),
          text: (() => {
            const name = String(nameMap?.[String(i)] ?? "").trim();
            const acctText = String(acct)
              ? truncateMiddle(String(acct), 10, 8)
              : "";
            if (name && acctText) return `${name} · ${acctText}`;
            if (name) return `${name}`;
            if (acctText) return `Profile ${i + 1} · ${acctText}`;
            return `Profile ${i + 1}`;
          })(),
        })
      )
    );
    accountSelect.value = String(
      Math.max(0, Math.min(idxForOrigin, Math.max(0, displayAccounts.length - 1)))
    );

    setApp([
      header,
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Connect this site to a Dusk profile?" }),
      ]),
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Profile" }),
        h("div", { class: "select-wrap" }, [accountSelect]),
        h("div", {
          class: "muted",
          text: "The site will only be able to use the selected profile's public account.",
        }),
      ]),
      decisionButtons("Connect", () => ({ accountIndex: Number(accountSelect.value) })),
    ]);
    return;
  }

  if (kindNorm === "switch_network") {
    const from = params?.from ?? {};
    const to = params?.to ?? {};

    setApp([
      header,
      h("div", { class: "row" }, [
        h("div", {
          class: "muted",
          text: "This site is requesting to switch the wallet network.",
        }),
      ]),
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "From" }),
        h("div", { class: "box" }, [
          h("div", { text: String(from.networkName ?? "Unknown") }),
          h("div", { class: "muted", text: String(from.chainId ?? "") }),
          from.nodeUrl ? h("div", { class: "muted", text: String(from.nodeUrl) }) : null,
        ].filter(Boolean)),
      ]),
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "To" }),
        h("div", { class: "box" }, [
          h("div", { text: String(to.networkName ?? "Unknown") }),
          h("div", { class: "muted", text: String(to.chainId ?? "") }),
          to.nodeUrl ? h("div", { class: "muted", text: String(to.nodeUrl) }) : null,
        ].filter(Boolean)),
      ]),
      decisionButtons("Switch"),
    ]);
    return;
  }

  if (kindNorm === "sign_message") {
    const chainId = String(params?.chainId ?? "");
    const messageHash = String(params?.messageHash ?? "");
    const messageLen = Number(params?.messageLen ?? 0) || 0;

    setApp([
      header,
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Approve message signature" }),
      ]),
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Account" }),
        h("div", { class: "box" }, [h("code", { text: activeAccount || "(none)" })]),
      ]),
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Chain ID" }),
        h("div", { class: "box" }, [h("code", { text: chainId || "—" })]),
      ]),
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Message (hashed)" }),
        h("div", { class: "box" }, [
          h("code", {
            text: messageHash
              ? `${messageLen} bytes · sha256=${messageHash.slice(0, 12)}…${messageHash.slice(-8)}`
              : `${messageLen} bytes`,
          }),
        ]),
      ]),
      h("div", {
        class: "muted",
        text: "This request does not submit a transaction. It signs a domain-separated hash for off-chain use.",
      }),
      decisionButtons("Sign"),
    ]);
    return;
  }

  if (kindNorm === "sign_auth") {
    const chainId = String(params?.chainId ?? "");
    const nonce = String(params?.nonce ?? "");
    const statement = String(params?.statement ?? "").trim();

    setApp([
      header,
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Approve sign-in" }),
      ]),
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Account" }),
        h("div", { class: "box" }, [h("code", { text: activeAccount || "(none)" })]),
      ]),
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Chain ID" }),
        h("div", { class: "box" }, [h("code", { text: chainId || "—" })]),
      ]),
      statement
        ? h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Statement" }),
            h("div", { class: "box" }, [h("code", { text: statement })]),
          ])
        : h("div"),
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Nonce" }),
        h("div", { class: "box" }, [h("code", { text: nonce || "—" })]),
      ]),
      h("div", {
        class: "muted",
        text: "Only sign in if you trust this site.",
      }),
      decisionButtons("Sign in"),
    ]);
    return;
  }

  if (kindNorm === "watch_asset") {
    const typeRaw = String(params?.type ?? "").trim();
    const type = typeRaw.toUpperCase();
    const options = params?.options && typeof params.options === "object" ? params.options : {};

    const contractId = String(options?.contractId ?? "");
    const tokenId = options?.tokenId != null ? String(options.tokenId) : "";

    let meta = null;
    let owner = null;
    let tokenUri = "";
    let ownedKnown = false;
    let owned = true;

    if (type === "DRC20") {
      try {
        meta = await sendResult({ type: "DUSK_UI_DRC20_GET_METADATA", contractId });
      } catch {
        meta = null;
      }
    } else if (type === "DRC721") {
      try {
        meta = await sendResult({ type: "DUSK_UI_DRC721_GET_METADATA", contractId });
      } catch {
        meta = null;
      }
      if (tokenId) {
        try {
          owner = await sendResult({ type: "DUSK_UI_DRC721_OWNER_OF", contractId, tokenId });
          const ownerStr = accountEnumToString(owner);
          ownedKnown = Boolean(ownerStr);
          owned = ownerStr === String(activeAccount ?? "");
        } catch {
          ownedKnown = false;
          owned = true;
        }
        try {
          tokenUri = String(
            await sendResult({ type: "DUSK_UI_DRC721_TOKEN_URI", contractId, tokenId })
          );
        } catch {
          tokenUri = "";
        }
      }
    }

    const add = decisionButtonsWithState({
      approveText: type === "DRC721" ? "Import NFT" : "Add token",
      approveDisabled: type === "DRC721" && ownedKnown && !owned,
    });

    setApp([
      header,
      h("div", { class: "row" }, [h("div", { class: "muted", text: "Approve watch asset" })]),
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Account" }),
        h("div", { class: "box" }, [h("code", { text: activeAccount || "(none)" })]),
      ]),
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Type" }),
        h("div", { class: "box" }, [h("code", { text: type || "(missing)" })]),
      ]),
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Contract" }),
        h("div", { class: "box" }, [h("code", { text: contractId || "(missing)" })]),
      ]),
      type === "DRC721"
        ? h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Token ID" }),
            h("div", { class: "box" }, [h("code", { text: tokenId || "(missing)" })]),
          ])
        : h("div"),
      meta
        ? h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Metadata (on-chain)" }),
            h("div", { class: "box" }, [
              h("code", {
                text: JSON.stringify(meta, null, 2),
              }),
            ]),
          ])
        : h("div"),
      type === "DRC721" && tokenUri
        ? h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Token URI (raw)" }),
            h("div", { class: "box" }, [h("code", { text: tokenUri })]),
          ])
        : h("div"),
      type === "DRC721" && ownedKnown && !owned
        ? h("div", { class: "callout warn" }, [
            h("div", { class: "callout-title", text: "Not owned" }),
            h("div", {
              class: "muted",
              text: "This NFT is not owned by the connected account, so it cannot be imported.",
            }),
          ])
        : h("div"),
      h("div", {
        class: "muted",
        text: "The wallet will verify the standard interface and on-chain metadata before persisting the asset.",
      }),
      add.row,
    ]);
    return;
  }

  if (kindNorm === "send_tx") {
    const txKind = String(params?.kind ?? "").toLowerCase();

    if (txKind === TX_KIND.TRANSFER) {
      const to = params?.to ?? "";
      const amount = params?.amount ?? "0";
      const memo = params?.memo ?? "";
      const gas = params?.gas ?? null;

      const amountLuxStr = prettyAmount(amount);
      const amountDuskStr = formatLuxShort(amountLuxStr, UI_DISPLAY_DECIMALS);

      const gasEditor = document.createElement("dusk-gas-editor");
      gasEditor.amountLux = amountLuxStr;
      gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;
      gasEditor.helpText =
        "Max fee shown is limit × price. If left blank, the protocol/node may choose defaults.";
      gasEditor.setGas(gas);

      setApp([
        header,
        h("div", { class: "row" }, [h("div", { class: "muted", text: "Approve transfer" })]),
        h("div", { class: "row" }, [
          h("div", { class: "muted", text: "From" }),
          h("div", { class: "box" }, [h("code", { text: activeAccount || "(none)" })]),
        ]),
        h("div", { class: "row" }, [
          h("div", { class: "muted", text: "To" }),
          h("div", { class: "box" }, [h("code", { text: to })]),
        ]),
        h("div", { class: "row" }, [
          h("div", { class: "muted", text: "Amount" }),
          h("div", { class: "box" }, [
            h("code", { text: `${amountDuskStr} DUSK`, title: `Lux: ${amountLuxStr}` }),
          ]),
        ]),
        memo
          ? h("div", { class: "row" }, [
              h("div", { class: "muted", text: "Memo" }),
              h("div", { class: "box" }, [h("code", { text: memo })]),
            ])
          : h("div"),
        gasEditor,
        decisionButtons("Approve", () => gasEditor.readOverrideGas(gas)),
      ]);
      return;
    }

    if (txKind === TX_KIND.CONTRACT_CALL) {
      const amount = params?.amount ?? "0";
      const deposit = params?.deposit ?? "0";
      const gas = params?.gas ?? null;
      const privacy = String(params?.privacy ?? "public").trim().toLowerCase();

      const amountLuxStr = prettyAmount(amount);
      const depositLuxStr = prettyAmount(deposit);
      const amountDuskStr = formatLuxShort(amountLuxStr, UI_DISPLAY_DECIMALS);
      const depositDuskStr = formatLuxShort(depositLuxStr, UI_DISPLAY_DECIMALS);

      const gasEditor = document.createElement("dusk-gas-editor");
      gasEditor.amountLux = amountLuxStr;
      gasEditor.extraLux = [depositLuxStr];
      gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;
      gasEditor.helpText =
        "Max fee shown is limit × price. If left blank, the protocol/node may choose defaults.";
      gasEditor.setGas(gas);

      const contractIdRaw = params?.contractId;
      let contractIdHex = "";
      try {
        if (typeof contractIdRaw === "string") {
          contractIdHex = contractIdRaw.startsWith("0x") ? contractIdRaw : `0x${contractIdRaw}`;
        } else {
          contractIdHex = `0x${bytesToHex(toBytes(contractIdRaw))}`;
        }
      } catch {
        contractIdHex = String(contractIdRaw ?? "");
      }

      const fnName = String(params?.fnName ?? "");
      const fnNameTrim = fnName.trim();
      const fnNameLower = fnNameTrim.toLowerCase();

      let argsBytes = new Uint8Array();
      let argsLen = 0;
      let argsHash = "";
      let argsOk = false;
      try {
        argsBytes = toBytes(params?.fnArgs);
        argsLen = argsBytes.length;
        argsHash = await sha256Hex(argsBytes);
        argsOk = true;
      } catch {
        // ignore; show raw below
      }

      const display = params?.display;

      const wantsDrc20 =
        argsOk && ["transfer", "approve", "transfer_from"].includes(fnNameLower);
      const wantsDrc721 =
        argsOk && ["approve", "set_approval_for_all", "transfer_from"].includes(fnNameLower);

      let drcKind = "";
      let decoded = null;

      if (wantsDrc20) {
        try {
          decoded = await sendResult({
            type: "DUSK_UI_DRC20_DECODE_INPUT",
            fnName: fnNameTrim,
            fnArgs: argsBytes,
          });
          drcKind = "DRC20";
        } catch {
          // ignore
        }
      }

      if (!drcKind && wantsDrc721) {
        try {
          decoded = await sendResult({
            type: "DUSK_UI_DRC721_DECODE_INPUT",
            fnName: fnNameTrim,
            fnArgs: argsBytes,
          });
          drcKind = "DRC721";
        } catch {
          // ignore
        }
      }

      let drcMeta = null;
      if (drcKind === "DRC20") {
        try {
          drcMeta = await sendResult({ type: "DUSK_UI_DRC20_GET_METADATA", contractId: contractIdHex });
        } catch {
          drcMeta = null;
        }
      }
      if (drcKind === "DRC721") {
        try {
          drcMeta = await sendResult({ type: "DUSK_UI_DRC721_GET_METADATA", contractId: contractIdHex });
        } catch {
          drcMeta = null;
        }
      }

      // Specialized approval UI for canonical token standards.
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

        const isMax =
          isApprove && safeBigInt(valueUnitsStr, -1n) === MAX_U64;

        const ackInput = h("input", {
          placeholder: "Type MAX to confirm",
          oninput: () => {
            const ok = String(ackInput.value ?? "")
              .trim()
              .toUpperCase() === "MAX";
            add.approveBtn.disabled = !(ok && isUnlocked);
          },
        });

        const add = decisionButtonsWithState({
          approveText: isTransfer ? "Approve transfer" : isApprove ? "Approve spending" : "Approve",
          approveDisabled: Boolean(isMax),
          approveTitle: isMax ? "Type MAX to enable approval" : "",
          getApprovedParams: () => gasEditor.readOverrideGas(gas),
        });

        setApp([
          header,
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Approve DRC20 contract call" }),
          ]),
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "From" }),
            h("div", { class: "box" }, [h("code", { text: activeAccount || "(none)" })]),
          ]),
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Token" }),
            h("div", { class: "box" }, [
              h("div", { text: `${name} (${sym})` }),
              h("div", { class: "muted" }, [h("code", { text: contractIdHex })]),
            ]),
          ]),
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Privacy" }),
            h("div", { class: "box" }, [
              h("code", { text: privacy === "shielded" ? "Shielded" : "Public" }),
            ]),
          ]),
          isTransfer || isTransferFrom
            ? h("div", { class: "row" }, [
                h("div", { class: "muted", text: "To" }),
                h("div", { class: "box" }, [h("code", { text: toStr || "(missing)" })]),
              ])
            : h("div"),
          isApprove
            ? h("div", { class: "row" }, [
                h("div", { class: "muted", text: "Spender" }),
                h("div", { class: "box" }, [h("code", { text: spenderStr || "(missing)" })]),
              ])
            : h("div"),
          isTransferFrom
            ? h("div", { class: "row" }, [
                h("div", { class: "muted", text: "Owner" }),
                h("div", { class: "box" }, [h("code", { text: ownerStr || "(missing)" })]),
              ])
            : h("div"),
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Amount" }),
            h("div", { class: "box" }, [
              h("code", {
                text: valueUnitsStr ? `${valueHuman} ${sym}` : "—",
                title: valueUnitsStr ? `Units: ${valueUnitsStr}` : "",
              }),
            ]),
          ]),
          isMax
            ? h("div", { class: "callout warn" }, [
                h("div", { class: "callout-title", text: "Unlimited allowance (MAX)" }),
                h("div", {
                  class: "muted",
                  text:
                    "This approval grants unlimited spending permission (u64::MAX). Only continue if you trust the spender.",
                }),
                ackInput,
              ])
            : h("div"),
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Args hash" }),
            h("div", { class: "box" }, [
              h("code", {
                text: argsHash
                  ? `${argsLen} bytes · sha256=${argsHash.slice(0, 12)}…${argsHash.slice(-8)}`
                  : "—",
              }),
            ]),
          ]),
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Amount (DUSK)" }),
            h("div", { class: "box" }, [
              h("code", { text: `${amountDuskStr} DUSK`, title: `Lux: ${amountLuxStr}` }),
            ]),
          ]),
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Deposit (DUSK)" }),
            h("div", { class: "box" }, [
              h("code", { text: `${depositDuskStr} DUSK`, title: `Lux: ${depositLuxStr}` }),
            ]),
          ]),
          gasEditor,
          display
            ? h("div", { class: "row" }, [
                h("div", { class: "muted", text: "Site-provided details (unverified)" }),
                h("div", { class: "box" }, [h("code", { text: JSON.stringify(display, null, 2) })]),
              ])
            : h("div"),
          add.row,
        ]);
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
          decoded?.token_id != null
            ? String(decoded.token_id)
            : decoded?.tokenId != null
              ? String(decoded.tokenId)
              : "";

        const isApprove = fnNameLower === "approve";
        const isSetApprovalForAll = fnNameLower === "set_approval_for_all";
        const isTransferFrom = fnNameLower === "transfer_from";

        const approvedBool = Boolean(decoded?.approved);

        const add = decisionButtonsWithState({
          approveText: isTransferFrom ? "Approve transfer" : isApprove ? "Approve" : "Approve",
          getApprovedParams: () => gasEditor.readOverrideGas(gas),
        });

        setApp([
          header,
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Approve DRC721 contract call" }),
          ]),
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "From" }),
            h("div", { class: "box" }, [h("code", { text: activeAccount || "(none)" })]),
          ]),
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Contract" }),
            h("div", { class: "box" }, [
              h("div", { text: `${name} (${sym})` }),
              h("div", { class: "muted" }, [h("code", { text: contractIdHex })]),
            ]),
          ]),
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Privacy" }),
            h("div", { class: "box" }, [
              h("code", { text: privacy === "shielded" ? "Shielded" : "Public" }),
            ]),
          ]),
          tokenIdStr
            ? h("div", { class: "row" }, [
                h("div", { class: "muted", text: "Token ID" }),
                h("div", { class: "box" }, [h("code", { text: tokenIdStr })]),
              ])
            : h("div"),
          isApprove
            ? h("div", { class: "row" }, [
                h("div", { class: "muted", text: "Approved" }),
                h("div", { class: "box" }, [h("code", { text: approvedStr || "(missing)" })]),
              ])
            : h("div"),
          isSetApprovalForAll
            ? h("div", { class: "row" }, [
                h("div", { class: "muted", text: "Operator" }),
                h("div", { class: "box" }, [h("code", { text: operatorStr || "(missing)" })]),
              ])
            : h("div"),
          isSetApprovalForAll
            ? h("div", { class: "row" }, [
                h("div", { class: "muted", text: "Approved for all" }),
                h("div", { class: "box" }, [
                  h("code", { text: approvedBool ? "true" : "false" }),
                ]),
              ])
            : h("div"),
          isTransferFrom
            ? h("div", { class: "row" }, [
                h("div", { class: "muted", text: "From (owner)" }),
                h("div", { class: "box" }, [h("code", { text: fromStr || "(missing)" })]),
              ])
            : h("div"),
          isTransferFrom
            ? h("div", { class: "row" }, [
                h("div", { class: "muted", text: "To" }),
                h("div", { class: "box" }, [h("code", { text: toStr || "(missing)" })]),
              ])
            : h("div"),
          isSetApprovalForAll && approvedBool
            ? h("div", { class: "callout warn" }, [
                h("div", { class: "callout-title", text: "High risk" }),
                h("div", {
                  class: "muted",
                  text: "This grants an operator permission to transfer all of your NFTs in this collection.",
                }),
              ])
            : h("div"),
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Args hash" }),
            h("div", { class: "box" }, [
              h("code", {
                text: argsHash
                  ? `${argsLen} bytes · sha256=${argsHash.slice(0, 12)}…${argsHash.slice(-8)}`
                  : "—",
              }),
            ]),
          ]),
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Amount (DUSK)" }),
            h("div", { class: "box" }, [
              h("code", { text: `${amountDuskStr} DUSK`, title: `Lux: ${amountLuxStr}` }),
            ]),
          ]),
          h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Deposit (DUSK)" }),
            h("div", { class: "box" }, [
              h("code", { text: `${depositDuskStr} DUSK`, title: `Lux: ${depositLuxStr}` }),
            ]),
          ]),
          gasEditor,
          display
            ? h("div", { class: "row" }, [
                h("div", { class: "muted", text: "Site-provided details (unverified)" }),
                h("div", { class: "box" }, [h("code", { text: JSON.stringify(display, null, 2) })]),
              ])
            : h("div"),
          add.row,
        ]);
        return;
      }

      setApp([
        header,
        h("div", { class: "row" }, [h("div", { class: "muted", text: "Approve contract call" })]),
        h("div", { class: "row" }, [
          h("div", { class: "muted", text: "From" }),
          h("div", { class: "box" }, [h("code", { text: activeAccount || "(none)" })]),
        ]),
        h("div", { class: "row" }, [
          h("div", { class: "muted", text: "Contract" }),
          h("div", { class: "box" }, [h("code", { text: contractIdHex })]),
        ]),
        h("div", { class: "row" }, [
          h("div", { class: "muted", text: "Privacy" }),
          h("div", { class: "box" }, [
            h("code", {
              text: privacy === "shielded" ? "Shielded" : "Public",
            }),
          ]),
        ]),
        h("div", { class: "row" }, [
          h("div", { class: "muted", text: "Function" }),
          h("div", { class: "box" }, [h("code", { text: fnName || "(none)" })]),
        ]),
        h("div", { class: "row" }, [
          h("div", { class: "muted", text: "Args (opaque bytes)" }),
          h("div", { class: "box" }, [
            h("code", {
              text:
                argsHash
                  ? `${argsLen} bytes · sha256=${argsHash.slice(0, 12)}…${argsHash.slice(-8)}`
                  : String(params?.fnArgs ?? ""),
            }),
          ]),
        ]),
        h("div", { class: "row" }, [
          h("div", { class: "muted", text: "Amount" }),
          h("div", { class: "box" }, [
            h("code", { text: `${amountDuskStr} DUSK`, title: `Lux: ${amountLuxStr}` }),
          ]),
        ]),
        h("div", { class: "row" }, [
          h("div", { class: "muted", text: "Deposit" }),
          h("div", { class: "box" }, [
            h("code", { text: `${depositDuskStr} DUSK`, title: `Lux: ${depositLuxStr}` }),
          ]),
        ]),
        gasEditor,
        display
          ? h("div", { class: "row" }, [
              h("div", { class: "muted", text: "Decoded details (provided by site)" }),
              h("div", { class: "box" }, [h("code", { text: JSON.stringify(display, null, 2) })]),
            ])
          : h("div"),
        h("div", {
          class: "muted",
          text: "Warning: Contract args are opaque bytes. Verify details in the dApp before approving.",
        }),
        decisionButtons("Approve", () => gasEditor.readOverrideGas(gas)),
      ]);
      return;
    }

    renderError(`Unknown transaction kind: ${txKind || "(missing kind)"}`);
    return;
  }

  renderError(`Unknown kind: ${kindNorm || String(kind)}`);
}

export function mountNotification() {
  renderNotification().catch((e) => renderError(e?.message ?? String(e)));
}
