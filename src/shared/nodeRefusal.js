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

/**
 * What to say of an error from sending a transaction out. Only the node's own
 * word on the transaction is a refusal: a gateway's timeout or a server error
 * says nothing of whether it got there, and the network having it means it did.
 * @param {unknown} message
 * @returns {string}
 */
export function propagationError(message) {
  const text = String(message ?? "").trim();
  const reply = replyOf(text);
  if (/exists in the (mempool|ledger)|already (exists|known)/i.test(reply)) return ALREADY_THERE;
  return isNodeReply(text) || REFUSALS.some(([re]) => re.test(reply)) ? nodeRefusalText(text) : NO_CLEAR_ANSWER;
}
