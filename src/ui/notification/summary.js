// What a site's request asks for, in a title and a line: the approval's own
// title, and for a payment its amount and recipient. The window that opens
// while the wallet is locked shows it above Unlock and Reject, so nobody has
// to type a password to learn what a site wants.

import { decodeBridgeCall, weiToDusk } from "../../shared/bridgeCalls.js";
import { toBytes } from "../../shared/bytes.js";
import { TX_KIND } from "../../shared/constants.js";
import { safeBigInt } from "../../shared/amount.js";
import { exactDusk } from "./parts.js";

/** A contract call's arguments as bytes, or null when they aren't any. */
export function callArgs(params) {
  try {
    return toBytes(params?.fnArgs);
  } catch {
    return null;
  }
}

/** The DuskEVM bridge call a site's contract call is, if it is a known one. */
export function bridgeCallOf(params) {
  if (String(params?.kind ?? "").toLowerCase() !== TX_KIND.CONTRACT_CALL) return null;
  const args = callArgs(params);
  return args
    ? decodeBridgeCall({ nodeUrl: params?.nodeUrl, contractId: params?.contractId, fnName: params?.fnName, args, deposit: params?.deposit })
    : null;
}

/** A withdrawal's amount as `{ value, unit }`. */
export function withdrawalAmount(wei) {
  const { lux, text } = weiToDusk(wei);
  return { value: lux === null ? text : exactDusk(lux), unit: "DUSK" };
}

/**
 * The title of a request's approval, and what it is about.
 *
 * - `amount`: `{ value, unit }` for a request that moves DUSK
 * - `to`: `{ address, network }` of whom it pays, for the window to name
 * - `sub`: a line of small print
 *
 * @param {string} kind - the approval kind (connect, send_tx, sign_message, ...)
 * @param {object} params - the request as rpc.js passes it on
 * @returns {{ title: string, amount?: {value: string, unit: string}, to?: {address: string, network: "dusk"|"duskevm"}, sub?: string }}
 */
export function requestSummary(kind, params = {}) {
  const p = params ?? {};
  switch (String(kind ?? "").trim().toLowerCase()) {
    case "connect":
      if (p.shieldedReceiveAddress) {
        return {
          title: p.currentAccountIndex == null ? "Connect and share your shielded address?" : "Share your shielded address?",
          sub: "It asks for your shielded receive address.",
        };
      }
      return { title: "Connect this site?", sub: "It asks to see your public address, .dusk name and balance." };
    case "switch_network": {
      const to = String(p.to?.networkName ?? "").trim();
      return { title: to ? `Switch to ${to}?` : "Switch network?" };
    }
    case "sign_message": {
      const preview = p.messagePreview;
      const text = preview?.kind === "text" ? String(preview.text ?? "") : "";
      return {
        title: "Sign a message?",
        sub: text ? (text.length > 80 ? `${text.slice(0, 80)}…` : text) : `${Number(p.messageLen ?? 0) || 0} bytes, not readable text`,
      };
    }
    case "sign_auth":
      return { title: "Sign in to this site?" };
    case "sign_typed_data":
      return { title: "Sign typed data?" };
    case "watch_asset":
      return { title: String(p.type ?? "").toUpperCase() === "DRC721" ? "Import an NFT?" : "Add a token?" };
    case "send_tx":
      return txSummary(p);
    default:
      return { title: "Review this request" };
  }
}

function txSummary(p) {
  const kind = String(p.kind ?? "").toLowerCase();
  if (kind === TX_KIND.TRANSFER) {
    return {
      title: "Pay",
      amount: { value: exactDusk(p.amount), unit: "DUSK" },
      to: { address: String(p.to ?? "").trim(), network: "dusk" },
    };
  }
  if (kind === TX_KIND.CONTRACT_CALL) {
    const bridge = bridgeCallOf(p);
    if (bridge?.kind === "deposit") {
      return {
        title: "Bridge to DuskEVM",
        amount: { value: exactDusk(bridge.amountLux), unit: "DUSK" },
        to: { address: bridge.recipient, network: "duskevm" },
      };
    }
    if (bridge) {
      return {
        title: bridge.kind === "prove" ? "Prove a DuskEVM withdrawal" : "Claim a DuskEVM withdrawal",
        amount: withdrawalAmount(bridge.amountWei),
        to: bridge.recipient.kind === "account" ? { address: bridge.recipient.account, network: "dusk" } : undefined,
      };
    }
    const sends = safeBigInt(p.amount, 0n) + safeBigInt(p.deposit, 0n);
    const fn = String(p.fnName ?? "").trim();
    return {
      title: "Contract call",
      amount: sends > 0n ? { value: exactDusk(sends), unit: "DUSK" } : undefined,
      sub: fn ? `Calls ${fn}` : undefined,
    };
  }
  return { title: "Review this transaction" };
}
