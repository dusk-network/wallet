// What a site's request asks for, in a title and a line: the approval's own
// title, and for a payment its amount and recipient. The window that opens
// while the wallet is locked shows it above Unlock and Reject, so nobody has
// to type a password to learn what a site wants.

import { bridgeEnvelopeOk, bridgeServiceTransfer, decodeBridgeCall, weiToDusk } from "../../shared/bridgeCalls.js";
import { toBytes } from "../../shared/bytes.js";
import { TX_KIND } from "../../shared/constants.js";
import { formatDuskExact, safeBigInt } from "../../shared/amount.js";

/** A contract call's arguments as bytes, or null when they aren't any. */
export function callArgs(params) {
  try {
    return toBytes(params?.fnArgs);
  } catch {
    return null;
  }
}

/**
 * The DuskEVM bridge call a site's contract call is, if it is a known one
 * sent as the bridge's route expects (bridgeEnvelopeOk): `own` are the
 * wallet's accounts and addresses, the only ones it may name as `to`.
 */
export function bridgeCallOf(params, { own = [] } = {}) {
  if (String(params?.kind ?? "").toLowerCase() !== TX_KIND.CONTRACT_CALL) return null;
  const args = callArgs(params);
  const call = args
    ? decodeBridgeCall({ nodeUrl: params?.nodeUrl, contractId: params?.contractId, fnName: params?.fnName, args, deposit: params?.deposit })
    : null;
  return call && bridgeEnvelopeOk(call, { amount: params?.amount, deposit: params?.deposit, to: params?.to, own }) ? call : null;
}

/** A withdrawal's amount as `{ value, unit }`. */
export function withdrawalAmount(wei) {
  const { lux, text } = weiToDusk(wei);
  return { value: lux === null ? text : formatDuskExact(lux), unit: "DUSK" };
}

/**
 * The title of a request's approval, and what it is about.
 *
 * - `amount`: `{ value, unit }` for a request that moves DUSK
 * - `to`: `{ address, network, on? }` of whom it pays, for the window to
 *   name: `on` says where an address on another chain is, "on Sepolia"
 * - `sub`: a line of small print
 *
 * @param {string} kind - the approval kind (connect, send_tx, sign_message, ...)
 * @param {object} params - the request as rpc.js passes it on
 * @param {{ own?: string[] }} [ctx] - the wallet's accounts and addresses (bridgeCallOf)
 * @returns {{ title: string, amount?: {value: string, unit: string}, to?: {address: string, network: "dusk"|"duskevm"|"evm", on?: string}, sub?: string }}
 */
export function requestSummary(kind, params = {}, { own = [] } = {}) {
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
      return txSummary(p, own);
    default:
      return { title: "Review this request" };
  }
}

function txSummary(p, own) {
  const kind = String(p.kind ?? "").toLowerCase();
  if (kind === TX_KIND.TRANSFER) {
    const amount = { value: formatDuskExact(p.amount), unit: "DUSK" };
    // To the bridge's account, which pays the memo's address on another chain.
    const service = bridgeServiceTransfer({ nodeUrl: p.nodeUrl, to: p.to, memo: p.memo });
    if (service) {
      return {
        title: `Bridge to ${service.chain}`,
        amount,
        to: service.recipientOk
          ? { address: service.recipient, network: "evm", on: `on ${service.short}` }
          : { address: String(p.to ?? "").trim(), network: "dusk" },
      };
    }
    return { title: "Pay", amount, to: { address: String(p.to ?? "").trim(), network: "dusk" } };
  }
  if (kind === TX_KIND.CONTRACT_CALL) {
    const bridge = bridgeCallOf(p, { own });
    if (bridge?.kind === "deposit") {
      return {
        title: "Bridge to DuskEVM",
        amount: { value: formatDuskExact(bridge.amountLux), unit: "DUSK" },
        to: { address: bridge.recipient, network: "duskevm", on: "on DuskEVM" },
      };
    }
    if (bridge) {
      return {
        title: bridge.kind === "prove" ? "Prove a DuskEVM withdrawal" : "Claim a DuskEVM withdrawal",
        amount: withdrawalAmount(bridge.amountWei),
        to: bridge.recipient.kind === "account" ? { address: bridge.recipient.account, network: "dusk" } : undefined,
      };
    }
    // The function is under the approval's Details, with the arguments.
    const sends = safeBigInt(p.amount, 0n) + safeBigInt(p.deposit, 0n);
    return {
      title: "Contract call",
      amount: sends > 0n ? { value: formatDuskExact(sends), unit: "DUSK" } : undefined,
    };
  }
  return { title: "Review this transaction" };
}
