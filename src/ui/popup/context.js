// Which network, profile and wallet the popup is on, as a number in its
// state: it goes up the moment a switch of any of them starts, a lock or a
// reset included. The overview names the new network or profile only once
// it's read again, so whatever began before a switch, such as a check a
// Review waits on, tells by this number that it's for the old one.

/**
 * A switch of network, profile or wallet, as it starts.
 * @param {object} state - the popup's state
 */
export function switchContext(state) {
  state.context = contextOf(state) + 1;
}

/**
 * The popup's context now: compare it with one taken before.
 * @param {object} state - the popup's state
 * @returns {number}
 */
export function contextOf(state) {
  return Number(state?.context) || 0;
}
