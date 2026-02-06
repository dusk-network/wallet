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

  if (!isUnlocked) {
    setApp([header, lockBox()]);
    return;
  }

  if (kindNorm === "connect") {
    const count = Math.max(1, Number(accountCount ?? (accountsArr.length || 1)) || 1);
    const displayAccounts = accountsArr.length
      ? accountsArr
      : Array.from({ length: count }, () => "");

    const accountSelect = h(
      "select",
      {},
      displayAccounts.map((acct, i) =>
        h("option", {
          value: String(i),
          text: String(acct)
            ? `Account ${i + 1} · ${truncateMiddle(String(acct), 10, 8)}`
            : `Account ${i + 1}`,
        })
      )
    );
    accountSelect.value = String(
      Math.max(0, Math.min(idxForOrigin, Math.max(0, displayAccounts.length - 1)))
    );

    setApp([
      header,
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Connect this site to your Dusk account?" }),
      ]),
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Account" }),
        h("div", { class: "select-wrap" }, [accountSelect]),
        h("div", {
          class: "muted",
          text: "The site will only be able to use the selected public account.",
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

      let argsBytes = new Uint8Array();
      let argsLen = 0;
      let argsHash = "";
      try {
        argsBytes = toBytes(params?.fnArgs);
        argsLen = argsBytes.length;
        argsHash = await sha256Hex(argsBytes);
      } catch {
        // ignore; show raw below
      }

      const display = params?.display;

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
