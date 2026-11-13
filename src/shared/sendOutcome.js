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

/** Why a payment called off with Cancel wasn't sent (waitingSends.js). */
export const SEND_CANCELLED_TEXT = "You cancelled it, so nothing was sent.";

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

// The network out of reach, the connection failing or giving up on a node
// that doesn't answer: as the web wallet tells it (describeFailure.js).
const OUT_OF_REACH = /timed out|timeout/i;

/**
 * Whether an error's words are the network out of reach: the connection
 * failing, or a node that didn't answer in time.
 * @param {string} error
 */
export const outOfReach = (error) => connectionLost(error) || OUT_OF_REACH.test(String(error ?? ""));

/**
 * Whether an error is the network out of reach: as the engine marks it
 * (`data.unreachable`, as for a prover it couldn't reach, whose words are its
 * own), or as its words say.
 * @param {{ message?: string, data?: { unreachable?: boolean } } | null | undefined} error
 */
export const unreachable = (error) => error?.data?.unreachable === true || outOfReach(error?.message);

/**
 * Whether a send failed for the network before it went out: nothing was
 * handed over, and the network couldn't be reached. A send called off isn't.
 * @param {{ message?: string, data?: { sent?: false | "unknown", cancelled?: boolean, unreachable?: boolean } } | null | undefined} error
 */
export const unreachableBeforeSent = (error) =>
  error?.data?.sent === false && error?.data?.cancelled !== true && unreachable(error);

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
