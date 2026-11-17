import { fixedOrigin } from "./env.js";
import { state } from "./state.js";
import { tabsQuery } from "../../platform/extensionApi.js";
import { noteChainId } from "../../shared/nodeNetwork.js";

export async function getActiveOrigin() {
  if (fixedOrigin) return fixedOrigin;
  try {
    const tabs = await tabsQuery({ active: true, currentWindow: true });
    const url = tabs?.[0]?.url;
    if (!url) return null;
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// The profile an overview is of, on its node: a balance kept from one is that profile's alone.
const profileOf = (ov) => (ov?.isUnlocked ? `${ov.nodeUrl}\n${ov.accounts?.[Number(ov.selectedAccountIndex) || 0] ?? ""}` : "");

// Each part of the balances, by name, with when it was read.
const READ_AT = [
  ["balance", "balanceReadAt"],
  ["shieldedBalance", "shieldedReadAt"],
  ["staked", "stakeReadAt"],
];
const sameFigure = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * An overview whose balance the node couldn't give, as when the connection
 * dropped, with the one read last for the same profile on the same node in its
 * place, said to be maybe out of date (`balanceStale`, `shieldedStale`), rather
 * than a dash. One read fresh takes its place; another profile or node keeps
 * nothing of it. Each part says when it was read (`balanceReadAt`,
 * `shieldedReadAt`, `stakeReadAt`), for a note that it may be out of date to
 * say when it was last read (Lena's wish, the sixth round: with the node
 * silent or the browser offline while the wallet showed, no time was known):
 * now, for one read now; else when the one in its place was, as this popup
 * read it or as the device kept it, the later for the same figure.
 * @param {object | null | undefined} before - the overview shown till now
 * @param {object} next - the one just read
 * @param {number} [now] - when it was read
 * @returns {object}
 */
export function keptBalances(before, next, now = Date.now()) {
  if (!next || !profileOf(next)) return next;
  // Written on the overview as it came, which a first one is shown as.
  if (next.balance && !next.balanceError && !next.balanceStale) next.balanceReadAt = now;
  if (next.shieldedBalance && !next.shieldedError && !next.shieldedStale) next.shieldedReadAt = now;
  if (next.staked && !next.stakeStale) next.stakeReadAt = now;
  if (profileOf(before) !== profileOf(next)) return next;
  const kept = { ...next };
  if (next.balanceError && !next.balance && before.balance) Object.assign(kept, { balance: before.balance, staked: next.staked ?? before.staked, balanceStale: true });
  if (next.shieldedError && !next.shieldedBalance && before.shieldedBalance) Object.assign(kept, { shieldedBalance: before.shieldedBalance, shieldedStale: true });
  // The device keeps a figure's time once a minute at most: this popup's own read of it may be later.
  for (const [part, at] of READ_AT) {
    if (Number(before[at]) > Number(kept[at] ?? 0) && sameFigure(before[part], kept[part])) kept[at] = before[at];
  }
  return kept;
}

export async function refreshOverview(send, { force = false } = {}) {
  const origin = await getActiveOrigin();
  const originChanged = origin !== state.lastOrigin;

  if (!force && state.overview && !state.needsRefresh && !originChanged) {
    return false;
  }

  state.overview = keptBalances(state.overview, await send({ type: "DUSK_UI_OVERVIEW", origin, route: state.route }));
  // The node's network, by the chain ID it gave, for what the popup knows only by the node.
  noteChainId(state.overview?.nodeUrl, state.overview?.chainId);
  if (typeof state.hideBalances === "boolean" && state.overview) {
    state.overview.hideBalances = state.hideBalances;
  }
  state.lastOrigin = origin;
  state.needsRefresh = false;
  return true;
}
