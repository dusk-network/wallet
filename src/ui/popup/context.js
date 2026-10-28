// Which network, profile and wallet the popup is on, as a number in its
// state: it goes up the moment a switch of any of them starts, a lock or a
// reset included. The overview names the new network or profile only once
// it's read again, so whatever began before a switch, such as a check a
// Review waits on, tells by this number that it's for the old one.

/**
 * A switch of network, profile or wallet, as it starts.
 * @param {object} state - the popup's state
 * @param {"switch" | "lock"} [reason] - "lock" for the wallet locking, so
 *   what it ends can say so
 */
export function switchContext(state, reason = "switch") {
  state.context = contextOf(state) + 1;
  state.contextReason = reason;
}

/**
 * The popup's context now: compare it with one taken before.
 * @param {object} state - the popup's state
 * @returns {number}
 */
export function contextOf(state) {
  return Number(state?.context) || 0;
}
