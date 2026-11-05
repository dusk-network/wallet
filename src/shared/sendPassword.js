// The password again, on any send above an amount chosen in Settings, as the web
// wallet asks it: off until it's turned on, and every change takes the password,
// or an unlocked wallet could simply turn it off.
//
// The amount is kept on its own, not with the settings, and no site's request
// reads it or writes it. What's asked is decided here, and checked in the
// background against the vault, for the wallet that's open, before anything of a
// send is made: for the wallet's own sends and for a site's, in its window.
//
// What it counts is what goes out with the most its fee can be; what comes back,
// as an unstake or a claim, counts only its fee. A token's transfer or allowance,
// and a call of a contract the network's file doesn't name, can move what can't be
// counted in DUSK: those ask on any amount.

import { TX_KIND } from "./constants.js";
import { DRC20_CALL_NAMES } from "./drc20Calls.js";
import { ERROR_CODES, rpcError } from "./errors.js";
import { contractLabel } from "./knownCalls.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { checkVaultPassword } from "./vault.js";

const KEY = STORAGE_KEYS.SEND_PASSWORD;

/** What a send says that the wallet refused for want of the password. */
export const SEND_PASSWORD_WAITS = "It waits for your password, so nothing was sent.";

const lux = (value) => {
  try {
    const n = BigInt(value ?? 0);
    return n > 0n ? n : 0n;
  } catch {
    return 0n;
  }
};

/**
 * The amount above which a send asks for the password, in lux: null while it's
 * off. What can't be read asks on every send, rather than turn it off.
 * @returns {Promise<bigint | null>}
 */
export async function sendPasswordLimit() {
  try {
    const kept = (await storage.get(KEY))?.[KEY];
    if (kept === undefined || kept === null) return null;
    return /^\d+$/.test(String(kept)) ? BigInt(kept) : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Sets that amount, once the password was checked: null turns it off.
 * @param {bigint | string | null} limit
 */
export async function setSendPasswordLimit(limit) {
  if (limit === null) await storage.remove(KEY);
  else await storage.set({ [KEY]: String(limit) });
}

// Calls that move or allow a token, or an NFT: their amounts aren't DUSK.
const TOKEN_CALLS = new Set([...DRC20_CALL_NAMES, "transfer_from", "set_approval_for_all"]);

/**
 * What a send takes from the wallet in DUSK, its fee aside, and whether it can
 * move what can't be counted in DUSK.
 * @param {object} params - the transaction, as it goes to the engine
 * @param {string} nodeUrl
 * @returns {{ moves: bigint, always: boolean }}
 */
export function sendMoves(params, nodeUrl) {
  const kind = String(params?.kind ?? "").toLowerCase();
  switch (kind) {
    case TX_KIND.TRANSFER:
    case TX_KIND.SHIELD:
    case TX_KIND.UNSHIELD:
    case TX_KIND.STAKE:
      return { moves: lux(params?.amount), always: false };
    case TX_KIND.UNSTAKE:
    case TX_KIND.WITHDRAW_REWARD:
      return { moves: 0n, always: false };
    case TX_KIND.CONTRACT_CALL: {
      const fn = String(params?.fnName ?? "").trim().toLowerCase();
      return { moves: lux(params?.amount) + lux(params?.deposit), always: TOKEN_CALLS.has(fn) || !contractLabel(String(params?.contractId ?? "").replace(/^0x/, ""), nodeUrl) };
    }
    default:
      return { moves: lux(params?.amount) + lux(params?.deposit), always: true };
  }
}

/** The most a transaction's gas comes to. */
const feeOf = (params) => lux(params?.gas?.limit) * lux(params?.gas?.price);

/**
 * What the wallet asks of a send: null when no password is, as it's off or the
 * send is at or below the amount. A limit given is the one read.
 * @param {object} params - the transaction, with its gas
 * @param {bigint | null} limit
 * @param {string} nodeUrl
 * @returns {{ limit: string, moves: string, always: boolean } | null}
 */
export function askedOf(params, limit, nodeUrl) {
  if (limit === null) return null;
  const { moves, always } = sendMoves(params, nodeUrl);
  return always || moves + feeOf(params) > limit ? { limit: String(limit), moves: String(moves), always } : null;
}

/**
 * What a site's window shows of the setting: the terms it asks on, as the fee
 * changes there, or null while it's off.
 * @param {object} params - the request
 * @param {string} nodeUrl
 * @returns {Promise<{ limit: string, moves: string, always: boolean } | null>}
 */
export async function sendPasswordTerms(params, nodeUrl) {
  const limit = await sendPasswordLimit();
  if (limit === null) return null;
  const { moves, always } = sendMoves(params, nodeUrl);
  return { limit: String(limit), moves: String(moves), always };
}

/** What refuses a send for want of the password, with the amount it's above. */
const waits = (asked) => rpcError(ERROR_CODES.USER_REJECTED, SEND_PASSWORD_WAITS, { sendPassword: asked });

// One password, one send: what the wallet's own pages get for it, for the send
// they go on to. Kept here alone, and gone with the worker.
const TICKET_MS = 2 * 60_000;
const tickets = new Map();

/**
 * Checks the password against the vault, for the wallet that's open, and gives a
 * ticket for the send it was given for.
 * @param {string} password
 * @param {object} params - the transaction, with its gas
 * @param {{ walletKey: string, walletId: string, nodeUrl: string, now?: number }} ctx
 * @returns {Promise<string>}
 */
export async function proveSendPassword(password, params, { walletKey, walletId, nodeUrl, now = Date.now() }) {
  await checkVaultPassword(password, walletKey);
  for (const [id, ticket] of tickets) if (now - ticket.at >= TICKET_MS) tickets.delete(id);
  const id = globalThis.crypto.randomUUID();
  const { moves, always } = sendMoves(params, nodeUrl);
  tickets.set(id, { walletId: String(walletId ?? ""), moves, always, at: now });
  return id;
}

/**
 * Refuses a wallet's own send that needs the password and has no ticket for it,
 * or one of another wallet, for less, or too old. A ticket counts once.
 * @param {object} params - the transaction as it goes to the engine, with its gas
 * @param {{ ticket?: unknown, walletId: string, nodeUrl: string, now?: number }} ctx
 */
export async function assertSendPassword(params, { ticket, walletId, nodeUrl, now = Date.now() }) {
  const asked = askedOf(params, await sendPasswordLimit(), nodeUrl);
  if (!asked) return;
  const held = tickets.get(String(ticket ?? ""));
  tickets.delete(String(ticket ?? ""));
  const good =
    held &&
    now - held.at < TICKET_MS &&
    held.walletId === String(walletId ?? "") &&
    held.moves >= BigInt(asked.moves) &&
    (held.always || !asked.always);
  if (!good) throw waits(asked);
}

/**
 * A site's send, as its window approves it: checks the password against the
 * vault, for the wallet that's open, when the send needs it. Throws for a wrong
 * one, or none, and the request goes on waiting.
 * @param {object} params - the transaction as it would go, with its gas
 * @param {{ password?: unknown, walletKey: string, nodeUrl: string }} ctx
 * @returns {Promise<{ moves: bigint, always: boolean } | null>} what it was checked for, null for no check
 */
export async function proveSiteSend(params, { password, walletKey, nodeUrl }) {
  const asked = askedOf(params, await sendPasswordLimit(), nodeUrl);
  if (!asked) return null;
  if (!password) throw waits(asked);
  await checkVaultPassword(password, walletKey);
  return sendMoves(params, nodeUrl);
}

/**
 * Refuses a site's send whose password wasn't checked for what it does now, as
 * its window answered: the last word before it goes.
 * @param {object} params - the transaction as it goes to the engine
 * @param {{ moves: bigint, always: boolean } | null} proved - proveSiteSend's
 * @param {string} nodeUrl
 */
export async function assertSiteSend(params, proved, nodeUrl) {
  const asked = askedOf(params, await sendPasswordLimit(), nodeUrl);
  if (asked && !(proved && proved.moves >= BigInt(asked.moves) && (proved.always || !asked.always))) throw waits(asked);
}
