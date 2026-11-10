// Whether a send that failed went out, as far as its error says: for the
// Sent screen, and for a site's record of an approval that didn't send.

// Errors that mean the wallet or the node refused the transaction before it
// ran: nothing went out, so there is no fee. Anything else (a reply that got
// lost, a timeout, a failure after the hand-over) may have reached the network.
// "Wallet changed while …" is the engine finding another network, profile or
// wallet than the one the transaction was reviewed on; "nothing was signed" is
// the engine refusing a node that contradicts the chain it's fixed to; "waits
// for your password" the wallet refusing a send above the amount chosen.
const REFUSED =
  /waits for your password|nothing was signed|not accepted|wallet locked|wallet (or network )?changed while|invalid|insufficient|not enough|exceed|must be|minimum|too (low|high|small|large)|nonce|balance|rejected|refused|denied|does not accept|cannot include|not configured|is required|unauthori[sz]ed|failed to (archive|unarchive|deserialize)|unknown error code/i;

// The connection, as the browser reports it: no signal, or a node down.
const NO_CONNECTION = /websocket|failed to connect to node|failed to fetch|networkerror|network error|load failed|err_internet_disconnected/i;

/**
 * Whether a send's error says it was refused before it ran (true), rather
 * than leaving open whether it reached the network.
 * @param {string} error
 */
export function sendRefused(error) {
  const text = String(error ?? "").trim();
  return Boolean(text) && REFUSED.test(text);
}

/**
 * Whether an error's words are the connection failing.
 * @param {string} error
 */
export const connectionLost = (error) => NO_CONNECTION.test(String(error ?? ""));

/**
 * Whether a send that failed went out: false when nothing did, "unknown" when
 * it may have. The engine says so for a transaction it built (`data.sent`, and
 * then `data.hash`); before that, a refusal, or a connection that failed,
 * sent nothing, as only the engine hands a transaction over.
 * @param {{ message?: string, data?: { sent?: false | "unknown" } } | null | undefined} error
 * @returns {false | "unknown"}
 */
export function sentOf(error) {
  const said = error?.data?.sent;
  if (said === false || said === "unknown") return said;
  const text = String(error?.message ?? "");
  return sendRefused(text) || connectionLost(text) ? false : "unknown";
}
