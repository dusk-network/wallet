// What a node's refusal of a transaction comes to, in the wallet's own words.
// Its reply is JSON or free text the node chose: a custom node can write
// anything there, so it never reaches a screen or a site as it came.

const REFUSALS = [
  [/value spent|larger than account|insufficient|not enough/i, "the balance doesn't cover the amount and the network fee."],
  [/gas (price|limit) (is )?(lower|too low)|too low/i, "the network fee is too low. Raise it under Custom fee."],
  [/nonce/i, "another transaction from this profile is still going through. Try again in a moment."],
  [/spend ?id|nullifier|double/i, "these funds are already being spent by another transaction. Try again in a moment."],
  [/exists in the (mempool|ledger)|already (exists|known)/i, "the network has this transaction already."],
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
