// What a node's refusal of a transaction comes to, in the wallet's own words.
// Its reply is JSON or free text the node chose: a custom node can write
// anything there, so it never reaches a screen or a site as it came.

const REFUSALS = [
  [/value spent|larger than account|insufficient|not enough/i, "the balance doesn't cover the amount and the network fee."],
  [/gas (price|limit) (is )?(lower|too low)|too low/i, "the network fee is too low. Raise it under Custom fee."],
  [/nonce/i, "another transaction from this profile got there first, and it may be an earlier try. Check Activity before sending again."],
  [/spend ?id|nullifier|double/i, "these funds are already being spent by another transaction, and it may be an earlier try. Check Activity before sending again."],
  [/maximum count|mempool (is )?full/i, "the network is busy. Try again in a moment."],
  [/too large/i, "this transaction is too large for the network."],
];

/** What a node's reply says inside its JSON, or the reply as it is. */
function replyOf(text) {
  if (!text.startsWith("{")) return text;
  try {
    const reply = JSON.parse(text);
    return typeof reply?.error === "string" ? reply.error : text;
  } catch {
    return text;
  }
}

/**
 * A node's refusal in the wallet's words. A reply that matches nothing known is
 * still refused in plain words: the node's own aren't shown.
 * @param {unknown} message - the node's reply
 * @returns {string}
 */
export function nodeRefusalText(message) {
  const reply = replyOf(String(message ?? "").trim());
  const known = REFUSALS.find(([re]) => re.test(reply));
  return known ? `The node refused it: ${known[1]}` : "The node refused this transaction.";
}

/**
 * Whether an error's text is a node's reply as it came: JSON, or the words a
 * node's refusal has.
 * @param {unknown} message
 * @returns {boolean}
 */
export function isNodeReply(message) {
  const text = String(message ?? "").trim();
  return /^[{[]/.test(text) || /\bnot accepted\b|^invalid input\b/i.test(text);
}

/** What a send says when the node's answer doesn't settle whether it went: it may have. */
export const NO_CLEAR_ANSWER = "The node gave no clear answer, so this may still go through. Check Activity before sending again.";

/** What a send says when the network turns out to have it already. */
export const ALREADY_THERE = "The network has this transaction already. Check Activity.";

// Rusk's refusal of a transaction, as map_check_tx_error writes it (rusk
// 1.7.3, src/lib/http/chain.rs): "Tx <its ID> not accepted: <why>", as
// {"error":"Invalid input: …"} behind HTTP 400 since 1.7, in plain text
// before. The whys that turn this transaction down, as TxAcceptanceError says
// them (node/src/mempool.rs); "exists in the mempool" or "ledger" means the
// network has it, and Rusk's own failures say "Internal server error".
const RUSK_REFUSAL = /^(?:Invalid input: )?Tx [0-9a-f]{64} not accepted: (.+)$/s;
const REFUSED_BECAUSE =
  /^(?:this transaction's spendId exists in the mempool|this transaction is invalid\b|gas (?:price|limit) lower than minimum\b|transaction format .+ is not supported for live ingress|Maximum future nonce retry queue size exceeded|Maximum queued future Moonlight transactions per account exceeded|Missing intermediate nonce|this transaction is too large to be serialized|Maximum transaction size exceeded|Transaction blob id \w+ is missing sidecar|No blobs provided|Transaction has too many blobs|Invalid blob:)/;

/**
 * Whether an error is the node turning the transaction down, in Rusk's own
 * refusal: then it didn't take it. Anything else, JSON or not, a gateway's
 * timeout among them, says nothing of whether it went.
 * @param {unknown} message
 * @returns {boolean}
 */
export function isRefusal(message) {
  const why = RUSK_REFUSAL.exec(replyOf(String(message ?? "").trim()))?.[1] ?? "";
  return REFUSED_BECAUSE.test(why);
}

/**
 * What to say of an error from sending a transaction out. Only the node's own
 * refusal of the transaction is one (isRefusal): a gateway's timeout or a
 * server error says nothing of whether it got there, and the network having
 * it means it did.
 * @param {unknown} message
 * @returns {string}
 */
export function propagationError(message) {
  const text = String(message ?? "").trim();
  const reply = replyOf(text);
  if (/exists in the (mempool|ledger)|already (exists|known)/i.test(reply)) return ALREADY_THERE;
  return isRefusal(text) ? nodeRefusalText(text) : NO_CLEAR_ANSWER;
}
