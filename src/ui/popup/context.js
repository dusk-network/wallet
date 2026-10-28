// Which network, profile and wallet the popup is on, as a token in its
// state: a new one the moment a switch of any of them starts, a lock or a
// reset included, compared by identity. The overview names the new network
// or profile only once it's read again, so whatever began before a switch,
// such as a check a Review waits on, tells by the token it kept that it's
// for the old one.

/**
 * A switch of network, profile or wallet, as it starts.
 * @param {object} state - the popup's state
 * @param {"switch" | "lock"} [reason] - "lock" for the wallet locking, so
 *   what it ends can say so
 */
export function switchContext(state, reason = "switch") {
  state.context = Object.freeze({ reason });
}
