// A sent transaction's first record, as Activity and the watchers start from
// it (txStore.js): the wallet that sent it, who asked, on which node and network, the profile that paid, what
// it sends and to whom, its gas, and the shielded notes it reserves. The
// wallet's own sends add the stake's owner, how they were paid, the token,
// the .dusk name typed for the recipient and what a Sozu unstake brings back;
// a site's add what its call says.

import { SOZU_FN } from "@dusk-network/networks/sozu";

import { normalizeNullifiers } from "./bytes.js";
import { TX_KIND } from "./constants.js";
import { chainIdForNode } from "./nodeNetwork.js";

const text = (value) => (value !== undefined && value !== null ? String(value) : undefined);

/**
 * The .dusk name a send's recipient was typed as, kept with the send for
 * Activity: a short name ending in .dusk, else undefined.
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function typedRecipientName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length <= 64 && /^[^\s\u0000-\u001f\u007f]+\.dusk$/i.test(name) ? name : undefined;
}

/**
 * @param {object} params - the transaction as it was sent
 * @param {{ walletId?: string, origin: string, nodeUrl: string, profileIndex: number, nullifiers?: unknown }} sent
 * @param {object} [extras] - what only the caller knows
 */
export function submittedTxMeta(params, { walletId, origin, nodeUrl, profileIndex, nullifiers }, extras = {}) {
  const kind = String(params?.kind ?? "");
  const call = kind === TX_KIND.CONTRACT_CALL;
  const pendingNullifiers = normalizeNullifiers(nullifiers);
  const now = Date.now();
  return {
    // The wallet that sent it, whose Activity lists it.
    walletId: walletId ? String(walletId) : undefined,
    origin,
    nodeUrl,
    // The network it was sent on, as the settings the sender just loaded name
    // the node's (nodeNetwork.js): its notices keep it after a switch.
    chainId: chainIdForNode(nodeUrl),
    kind,
    privacy: params?.privacy ? String(params.privacy) : undefined,
    profileIndex,
    to: params?.to ? String(params.to) : undefined,
    amount: text(params?.amount),
    deposit: text(params?.deposit),
    // On the chain for all to see: where the bridge pays, until the chain's row comes.
    memo: kind === TX_KIND.TRANSFER && params?.privacy === "public" && params?.memo ? String(params.memo) : undefined,
    contractId: call && params?.contractId ? String(params.contractId) : undefined,
    fnName: call && params?.fnName ? String(params.fnName) : undefined,
    gasLimit: text(params?.gas?.limit),
    gasPrice: text(params?.gas?.price),
    ...extras,
    pendingNullifiers,
    reservationStatus: pendingNullifiers.length ? "pending" : undefined,
    reservationUpdatedAt: pendingNullifiers.length ? now : undefined,
    submittedAt: now,
    status: "submitted",
  };
}

/**
 * The record of a send handed to the node with no clear answer: as a sent
 * one's, not known to have gone, to be looked up by its ID.
 * @param {object} params
 * @param {{ walletId?: string, origin: string, nodeUrl: string, profileIndex: number }} sent
 * @param {object} [extras]
 */
export function unclearTxMeta(params, sent, extras = {}) {
  return { ...submittedTxMeta(params, sent, extras), status: "unknown", recoveryReason: "handover_unclear" };
}

/**
 * The profile that pays a wallet's own send: the one it names, as a stake's
 * own may not be the one selected, else the one selected.
 * @param {object} params
 * @param {{ selectedAccountIndex?: number }} [status] - the engine's
 * @param {{ selectedAccountIndex?: number }} [settings]
 */
export function sendingProfile(params, status, settings) {
  const named = params?.profileIndex ?? status?.selectedAccountIndex ?? settings?.selectedAccountIndex ?? 0;
  return Number(named) || 0;
}

/**
 * What a Sozu unstake brings back in its own transaction: the amount it asks
 * the pool for, which its record moves from the start, as the chain's row
 * will. The call itself sends nothing along.
 * @param {object} params
 * @param {object | undefined} asset
 */
function sozuUnstakeMoves(params, asset) {
  const amount = String(params?.fnArgsAmountLux ?? "");
  return asset?.kind === "sozu" && params?.fnName === SOZU_FN.UNSTAKE && /^\d+$/.test(amount) ? { amount, deposit: undefined } : {};
}

/**
 * What only the wallet's own sends record, from the popup's message.
 * @param {object} params - the transaction as it was sent
 * @param {{ asset?: object, toName?: string }} message
 */
export function walletSendFields(params, message) {
  const asset = message?.asset && typeof message.asset === "object" ? message.asset : undefined;
  return {
    ownerProfileIndex: params?.ownerProfileIndex != null ? Number(params.ownerProfileIndex) || 0 : undefined,
    payment: params?.payment ? String(params.payment) : undefined,
    asset,
    toName: typedRecipientName(message?.toName),
    ...sozuUnstakeMoves(params, asset),
  };
}
