import {
  UI_DISPLAY_DECIMALS,
  amountLocale,
  formatDusk,
  formatDuskExact,
  formatFee,
  formatLuxForInput,
  formatLuxToDusk,
  maxAmountLux,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import { chainIdForNode, networkKeyOf } from "../../../shared/nodeNetwork.js";
import { POSITION_WORDS, sozuPosition, sozuRate, sozuRateLine, sozuYear } from "@dusk-network/app-core/sozu";
import { FACTS_WAIT_MS } from "@dusk-network/app-core/export";
import { SOZU_FN, feePercent, leastSozuStake, parsePool, sozuStake, sozuUnstakeAllowed } from "@dusk-network/networks/sozu";

import {
  buildSozuDepositTx,
  buildSozuWithdrawTx,
  makeSozuStDuskToken,
  parseSozuPoolState,
  parseSozuPosition,
} from "../../../shared/sozuAdapter.js";
import { sozuConfigOf } from "../../../shared/sozuConfig.js";
import { TX_KIND } from "../../../shared/constants.js";
import { getDefaultGas, getMinimumGas } from "../../../shared/txDefaults.js";
import { contractLabel } from "../../../shared/knownCalls.js";
import { openUrl } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { waiting } from "../../components/Waiting.js";
import { guarded, screenShown } from "../../lib/clickGuard.js";
import { contractIdText } from "../../lib/strings.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { amountField } from "../../components/AmountField.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { contractValueEl, copyContractButton } from "../../components/ContractValue.js";
import { reviewActions, submitOnGasEnter } from "../../components/FormControls.js";
import { gasFeeLux, payGuard, startingGas, useNetworkGas } from "../../components/NetworkGas.js";
import { shortfallText } from "../../lib/shortfall.js";
import { profileNameEl, withReviewWallet } from "../../components/ProfileName.js";
import { SOZU_FACT_SOON_MS, activityKey, activityRows, keptRatesOf, nativeRewardsOf, sozuFactsOf, sozuGrowthOf, wholeActivity } from "../activity.js";
import { sendFromReview } from "./sent.js";
import { lastReadText } from "./txRow.js";
import { keepBalances, keptBalancesOf } from "../../../shared/keptBalances.js";
import { NODE_ANSWER_MS } from "../../../shared/networkStatus.js";

// What a stake of `amount` gets with Sozu (sozuStake), once both the pool's
// rate and the deposit fee are read; null until then.
const stakeQuote = (amount, pool, depositFee) => (pool && depositFee ? sozuStake(amount, pool, depositFee) : null);

function fmtLux(value) {
  return formatDusk(value ?? "0");
}

// Sozu's site.
const SOZU_URL = "https://sozu.fi/";

const MINUS = "−";

/** How an unstake from Sozu comes back: its pool pays it out in the same call. */
export const SOZU_UNSTAKE_LINE = "The DUSK comes back in the same transaction. No Sozu fee, no waiting.";

// Sozu's switches, as its substrate reads them: deposits paused, or not known.
const PAUSED_TITLE = "Sozu has paused deposits";
const UNCHECKED_TITLE = "Sozu's deposits couldn't be checked";
const SYNC_TITLE = "Sozu is synchronizing its pool";
const SYNC_TEXT = "A stake or unstake can fail until it's done.";

// A fee so high that no stake gets stDUSK: 100%, or so near it that the least is past any amount.
const NO_STAKE_TEXT = "No stake gets stDUSK at Sozu's deposit fee now.";

// Sozu's terms read again before a stake is sent, and found changed.
const CHANGED_TITLE = "Sozu's terms changed";
const CHANGED_TEXT = "These are the figures now. Check them, then stake again.";

// A stake's Review left because the network, profile or lock changed while
// its terms were read again: the stake's form says so.
const SWITCHED_NOTICE = "The network or profile changed, so nothing was sent. Check the stake again.";
const LOCKED_NOTICE = "The wallet locked, so nothing was sent. Check the stake again.";

/**
 * About how much stDUSK a stake gets, as its form and Review show it, to 4
 * decimals as every summary does: "32.4712".
 * @param {bigint|string} stDuskLux
 */
export function stDuskText(stDuskLux) {
  return formatDusk(String(stDuskLux));
}

// A fee rate as the engine sends it, as bigints; null when it isn't one.
function feeRateOf(rate) {
  try {
    const numerator = BigInt(rate?.numerator);
    const denominator = BigInt(rate?.denominator);
    return denominator > 0n && numerator >= 0n && numerator <= denominator ? { numerator, denominator } : null;
  } catch {
    return null;
  }
}

/**
 * Sozu's fees as one fact: what it keeps of rewards, then what it takes of a
 * deposit and that unstaking costs nothing, as its substrate gives them now.
 * @param {{ deposit?: object, reward?: object } | null} fees - the engine's status.fees
 * @returns {{ title: string, sub: string }}
 */
export function sozuFeeFact(fees) {
  const deposit = feeRateOf(fees?.deposit);
  const reward = feeRateOf(fees?.reward);
  if (!deposit || !reward) return { title: "Sozu's fees", sub: "They couldn't be read just now." };
  return {
    title: `Sozu keeps ${feePercent(reward, amountLocale())} of rewards`,
    sub: `${feePercent(deposit, amountLocale())} on deposits · No fee to unstake`,
  };
}

/**
 * What the status says Sozu takes for a stake: the pool's rate and the
 * deposit fee, both as bigints, or null where they couldn't be read.
 */
function stakeTerms(status) {
  const pool = status?.pool ? parseSozuPoolState(status.pool) : null;
  return {
    pool: pool ? parsePool({ numerator: pool.totalStakeLux, denominator: pool.tokenTotalSupply }) : null,
    depositFee: feeRateOf(status?.fees?.deposit),
  };
}

/** The deposit fee as its row shows it: "0.25%", then the fee of an amount. */
function depositFeeText(rate, feeLux = null) {
  const pct = feePercent(rate, amountLocale());
  return feeLux === null ? pct : `${pct} · ${formatDuskExact(feeLux.toString())} DUSK`;
}

/**
 * On a stake's Review, its deposit fee's row: its DUSK, its rate, and that it
 * doesn't come back, for a stake with one.
 * @param {object} quote - the draft's
 * @param {object} rate - its fee rate
 */
function depositFeeRow(quote, rate) {
  const feeLux = safeBigInt(quote.fee, 0n);
  return [`${formatDuskExact(feeLux.toString())} DUSK (${feePercent(rate, amountLocale())})${feeLux > 0n ? ", not refunded" : ""}`];
}

/**
 * On a stake's Review with no deposit fee row (its quote or rate not read),
 * that Sozu's deposit fee doesn't come back. Nothing for a stake with no fee,
 * nor where the row says it.
 * @param {object | null} quote - the draft's
 * @param {object | null} rate - its fee rate
 */
function depositFeeGone(quote, rate) {
  const feeLux = quote ? safeBigInt(quote.fee, 0n) : null;
  if (feeLux === 0n || (rate && feeLux !== null)) return null;
  return h("p", { class: "stake-cap sozu-fee-gone" }, ["Sozu's deposit fee doesn't come back."]);
}

// A stake's quote as a draft keeps it, in strings: the fee and its rate,
// what's left, the stDUSK it gets, and whether it goes ahead.
function quoteJson(quote, rate) {
  return {
    fee: quote.fee.toString(),
    worth: quote.worth.toString(),
    stDusk: quote.stDusk.toString(),
    ok: quote.ok,
    feeRate: { numerator: rate.numerator.toString(), denominator: rate.denominator.toString() },
  };
}

// What a stake's Review shows of Sozu's terms: the fee's rate and what it
// takes, and about how much stDUSK the stake gets.
function shownTerms(quote) {
  const rate = feeRateOf(quote?.feeRate);
  return rate ? `${depositFeeText(rate, safeBigInt(quote.fee, 0n))} | ${stDuskText(quote.stDusk)} | ${quote.ok}` : "";
}

const hexId = (id) => String(id ?? "").trim().toLowerCase().replace(/^0x/, "");

/**
 * Sozu's terms for a drafted stake as they are now, read again just before
 * it's sent: its pool takes the fee of that moment, and Sozu's manager can
 * change it, or pause deposits, at any time. Changes nothing itself.
 * @returns {Promise<{ status: object, quote: object, depositFee: object, poolId: string } | null>}
 *   null when they couldn't be read
 */
async function readStakeTerms(actions, draft) {
  let status = null;
  try {
    const resp = await actions?.send?.({ type: "DUSK_UI_GET_SOZU_STATUS", profileIndex: Number(draft.profileIndex ?? 0) || 0 });
    if (!resp?.error) status = resp?.result ?? resp ?? null;
  } catch {
    // Not read: nothing is sent.
  }
  const { pool, depositFee } = stakeTerms(status);
  const quote = stakeQuote(draftAmountLux(draft), pool, depositFee);
  const poolId = hexId(status?.contracts?.pool);
  return quote && /^[0-9a-f]{64}$/.test(poolId) ? { status, quote, depositFee, poolId } : null;
}

/**
 * Brings a drafted stake, and the status its Review shows, up to the terms
 * just read.
 * @returns {boolean} whether anything the Review shows changed, or deposits
 *   aren't open now
 */
function applyStakeTerms({ st, draft, terms }) {
  const { status, quote, depositFee, poolId } = terms;
  const wasSyncing = st.status?.features?.synchronization === true;
  st.status = status;
  st.pool = status.pool ?? null;
  st.position = status.position ?? null;
  st.readAt = Date.now();
  const next = quoteJson(quote, depositFee);
  const changed =
    shownTerms(draft.quote) !== shownTerms(next) ||
    poolId !== hexId(draft.contractId) ||
    status.features?.maintenance !== false ||
    (!wasSyncing && status.features?.synchronization === true);
  draft.quote = next;
  if (changed) {
    draft.contractId = poolId;
    draft.termsChanged = true;
  }
  return changed;
}

// Drafted stakes whose Review button ("Stake 100 DUSK") is reading Sozu's
// terms again: one check at a time for each, a redrawn Review's included.
const rechecking = new WeakSet();

/**
 * Where a drafted call to Sozu belongs, recorded as it enters Review: the
 * popup's context, and the node, network, wallet, profile and account, as
 * the form it was drafted on was drawn. Its Review compares the popup with
 * this record, never with what the Review was last drawn with: the context
 * is replaced the moment a switch starts (context.js), before the overview
 * names the new network or profile. Drawn after a switch or a lock, the
 * Review offers no button to send; a check that answers after one, from another
 * network, or after the Review was left, does nothing at all. The wallet's
 * engine checks the same just before it sends.
 * @param {object} ov - the overview the form was drawn with
 * @param {number} profileIndex - the profile the call is sent from
 * @param {object | null} context - the popup's context as the form was drawn
 * @param {string} [networkKey] - the network Sozu's terms were read on
 */
function reviewRecord(ov, profileIndex, context, networkKey) {
  const accounts = Array.isArray(ov?.accounts) ? ov.accounts : [];
  return Object.freeze({
    context,
    nodeUrl: String(ov?.nodeUrl ?? ""),
    networkKey: String(networkKey ?? ""),
    walletId: String(accounts[0] ?? ""),
    profileIndex,
    account: String(accounts[profileIndex] ?? ""),
  });
}

/**
 * Whether the popup is still where a drafted call to Sozu belongs: the
 * context, node, wallet and profile its record holds, and unlocked.
 * @param {object | null} record - reviewRecord's
 */
function stillFor(record, state, ov) {
  const now = state.overview ?? ov;
  const accounts = Array.isArray(now?.accounts) ? now.accounts : [];
  return (
    Boolean(record) &&
    state.context === record.context &&
    now?.isUnlocked !== false &&
    String(now?.nodeUrl ?? "") === record.nodeUrl &&
    (Number(now?.selectedAccountIndex ?? 0) || 0) === record.profileIndex &&
    String(accounts[0] ?? "") === record.walletId
  );
}

/**
 * Leaves a stake's Review that doesn't belong where the popup is now, for
 * the stake's form: the amount as typed, checked again there, and one line
 * on why nothing was sent.
 */
function leaveReview(state, st, record, ov) {
  const now = state.overview ?? ov;
  const locked = now?.isUnlocked === false || (state.context !== record?.context && state.context?.reason === "lock");
  st.notice = locked ? LOCKED_NOTICE : SWITCHED_NOTICE;
  st.loaded = false;
  state.sozuDraft = null;
  if (state.staking) state.staking.screen = "liquid";
  state.route = "stake";
}

function sozuState(state) {
  return (state.sozu ??= {
    action: "deposit",
    depositAmountDusk: "",
    withdrawAmountDusk: "",
    loaded: false,
    loading: false,
    error: null,
    // Why the form shows, not the Review it left: SWITCHED_NOTICE or LOCKED_NOTICE.
    notice: "",
    profileIndex: null,
    status: null,
    pool: null,
    position: null,
  });
}

function parseAmountLux(raw) {
  const amount = parseDuskToLux(String(raw ?? "").trim());
  if (safeBigInt(amount, 0n) <= 0n) throw new Error("Enter an amount greater than 0.");
  return amount;
}

function draftAmountLux(draft) {
  const deposit = safeBigInt(draft?.deposit ?? 0, 0n);
  if (deposit > 0n) return deposit;
  return safeBigInt(draft?.fnArgsAmountLux ?? 0, 0n);
}

/**
 * The gas a call of Sozu's pool starts from (startingGas): its own limit at
 * the wallet's price, custom gas from Settings and a draft's own included,
 * so Max and the balance checks match what Review asks.
 * @param {string} fnName - "sozu_stake" or "sozu_unstake"
 */
export function sozuStartingGas(fnName, customGas = null, gas = null) {
  const opts = { privacy: "public", fnName };
  return startingGas({
    defaultGas: getDefaultGas(TX_KIND.CONTRACT_CALL, opts),
    minLimit: getMinimumGas(TX_KIND.CONTRACT_CALL, opts)?.limit,
    customGas,
    gas,
  });
}

function sozuFeeLux(fnName, customGas = null, gas = null) {
  return gasFeeLux(sozuStartingGas(fnName, customGas, gas));
}

function stDuskWatchKey(profileIndex, contractId) {
  return `${Number(profileIndex) || 0}:${String(contractId ?? "").toLowerCase()}`;
}

function canonicalContractId(contractId) {
  const raw = String(contractId ?? "").trim().toLowerCase();
  if (/^0x[0-9a-f]{64}$/.test(raw)) return raw;
  if (/^[0-9a-f]{64}$/.test(raw)) return `0x${raw}`;
  return raw;
}

function maybeAutoWatchStDusk({ state, actions, st, status, profileIndex }) {
  const contractId = status?.contracts?.["staked-dusk"];
  const balance = safeBigInt(status?.position?.stDuskBalanceLux ?? 0, 0n);
  if (!contractId || balance <= 0n) return;

  const key = stDuskWatchKey(profileIndex, contractId);
  if (st.autoStDuskWatchKey === key || st.autoStDuskWatchPending === key) return;

  st.autoStDuskWatchPending = key;
  actions?.send?.({
    type: "DUSK_UI_ASSETS_WATCH_TOKEN",
    profileIndex,
    token: makeSozuStDuskToken(contractId),
  })
    ?.then((resp) => {
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to add stDUSK");
      st.autoStDuskWatchKey = key;
      if (state.assets) state.assets.loaded = false;
    })
    ?.catch(() => {
      // Auto-watch should never break the liquid staking panel.
    })
    ?.finally(() => {
      if (st.autoStDuskWatchPending === key) st.autoStDuskWatchPending = "";
      actions?.render?.().catch(() => {});
    });
}

const accountOf = (ov, idx) => String(ov?.accounts?.[idx] ?? "");

/**
 * Staking's figures were read from the node, as Home's balance was: with no
 * network, or a node that stopped answering, they're said to be maybe out of
 * date, as Home says it, with when they were read last: each figure the
 * screen shows (`readAt`), else the balance, where that's known (Lena's wish,
 * the sixth round). Null while they're as read.
 * @param {object} ov - the overview
 * @param {unknown[]} [readAt] - when each figure shown was read
 * @param {{ kept?: boolean }} [opts] - `kept`: the figures shown are those
 *   read last on this device, the node not having answered for them now
 * @returns {HTMLElement | null}
 */
export function stakeStaleNote(ov, readAt = [], { kept = false } = {}) {
  const read = (readAt.length ? lastReadText(...readAt) : "") || lastReadText(ov?.balanceReadAt);
  const note = (text) => h("div", { class: "muted balance-stale stake-stale", role: "status", text });
  if (globalThis.navigator?.onLine === false) return note(`Your stake may be out of date until you're back online.${read}`);
  if (kept || ov?.balanceStale || ov?.stakeStale || ov?.networkStatus?.nodeStatus === "offline") return note(`Your stake may be out of date.${read}`);
  return null;
}

/**
 * What the profile did with Sozu, for its position: read from its whole history
 * once a status is read, as long as that takes; what's on its way is counted when
 * it's through, with the status read again. `reading` until then, and `rows`
 * empty once it can't be read: what the status says shows all the same.
 * @returns {{ reading: boolean, rows: object[], facts?: Map<string, object> }}
 */
function sozuHistory(ov, st, { state, actions }) {
  const key = activityKey(ov);
  if (state.activity?.key !== key) return { reading: false, rows: [] };
  if (st.history?.key === key) return st.history;
  const history = (st.history = { key, reading: true, rows: [] });
  const done = (found) => {
    if (st.history !== history) return;
    Object.assign(history, { reading: false }, found);
    actions?.render?.()?.catch?.(() => {});
  };
  wholeActivity(ov, { state, publicOnly: true })
    .then(async (whole) => {
      const rows = activityRows(ov, state, whole);
      done({ rows, facts: await factsOfRows(ov, rows), whole: true });
    })
    .catch(() => done({}));
  return history;
}

/**
 * The stakes and unstakes with Sozu in `rows` that went through in a block
 * the wallet knows, in the last FACTS_WAIT_MS, whose facts `facts` doesn't
 * have: app-core leaves those out of rewards by year till they're read
 * (`reading`), and counts an older one without them as not known.
 * @param {object[]} rows
 * @param {Map<string, object> | undefined} facts
 */
function unreadInBlock(rows, facts, now = Date.now()) {
  return (rows ?? []).filter(
    (row) =>
      row?.sozu &&
      row.status === "executed" &&
      Number.isSafeInteger(row.blockHeight) &&
      row.blockHeight > 0 &&
      typeof row.time === "number" &&
      now - row.time <= FACTS_WAIT_MS &&
      !facts?.has(row.hash)
  );
}

/**
 * What each stake and unstake with Sozu in `rows` did, as its pool's event
 * says it: as the archive's history lists it, else, for one that went through
 * in a block the wallet knows (unreadInBlock), from that block's events, as
 * its Completed screen reads it. The archive's history lists a transaction
 * only once its block is final, a little after: one just made is the wallet's
 * own record till then (Lena's, the fourth round: the popup reopened at
 * Completed, Rewards by year kept the "taken out" from before her unstake for
 * 20 to 25 s, beside a "grown" that had moved). Undefined where none could
 * be read.
 * @param {object} ov - the overview
 * @param {object[]} rows - the account's rows
 * @returns {Promise<Map<string, object> | undefined>}
 */
async function factsOfRows(ov, rows) {
  const facts = await sozuFactsOf(ov, rows);
  const early = unreadInBlock(rows, facts);
  if (!early.length) return facts;
  // Each as the archive's history will list it, in its block.
  const inBlock = await sozuFactsOf(ov, early.map((row) => ({ ...row, source: "public" })), { inBlock: true });
  return inBlock?.size ? new Map([...(facts ?? []), ...inBlock]) : facts;
}

/**
 * The profile's whole public history with Sozu's facts, as Liquid staking reads
 * it for its position: for what Staking says of rewards by year.
 * @returns {{ reading: boolean, rows: object[], facts?: Map<string, object>, whole?: boolean }}
 */
export function stakingHistory(ov, { state, actions }) {
  return sozuHistory(ov, sozuState(state), { state, actions });
}

/**
 * A stake or an unstake with Sozu went through, or failed: what Staking read
 * of the profile's history goes, and Rewards by year reads it again as it
 * next draws, the new one from its block's events (factsOfRows) till the
 * archive lists it (Lena's, the third round: right after the extension's own
 * unstake, the year kept the "taken out" from before it for 25 s, beside a
 * "grown" that had moved, as what was read before the unstake stood).
 * @param {object} state - the popup's state
 */
export function readStakingAgain(state) {
  const st = sozuState(state);
  if (st.history?.againTimer) clearTimeout(st.history.againTimer);
  st.history = null;
}

/** How long Sozu's facts wait before they're read again, while some aren't on the archive. */
export const FACTS_AGAIN_MS = 20_000;
// While one in a block the wallet knows isn't read, as its block's events can
// come a moment after it: read again this many times, as often as its
// Completed screen asks (SOZU_FACT_SOON_MS).
const FACTS_SOON_TRIES = 10;

/**
 * A stake's or an unstake's facts come from the archive a little after its
 * block: from its block's events once the archive has them, and from its
 * history once that lists it (factsOfRows). While rewards by year wait on
 * some (app-core's `reading`), the whole history is read again, and its facts
 * with it: 3 seconds on, a few times, while one in a block the wallet knows
 * isn't read, else 20 seconds on, as the web wallet reads it; one read at a
 * time, and the screen drawn again after each read, what came or not
 * (`factsRead`): rewards by year are worked out again, and while some are
 * still read, read again.
 */
export function readSozuFactsAgain(ov, { state, actions }) {
  const st = sozuState(state);
  const history = st.history;
  if (!history || history.reading || history.againTimer) return;
  const soon = unreadInBlock(history.rows, history.facts).length > 0 && (history.soonReads ?? 0) < FACTS_SOON_TRIES;
  if (soon) history.soonReads = (history.soonReads ?? 0) + 1;
  history.againTimer = setTimeout(() => {
    wholeActivity(ov, { state, publicOnly: true })
      .then((whole) => activityRows(ov, state, whole))
      .catch(() => history.rows)
      .then(async (rows) => {
        const facts = await factsOfRows(ov, rows);
        if (st.history !== history) return;
        history.rows = rows;
        // What's read now, over what was: a read that fails takes nothing away.
        if (facts) history.facts = new Map([...(history.facts ?? []), ...facts]);
      })
      .catch(() => {})
      .finally(() => {
        history.againTimer = null;
        if (st.history !== history) return;
        history.factsRead = (history.factsRead ?? 0) + 1;
        actions?.render?.()?.catch?.(() => {});
      });
  }, soon ? SOZU_FACT_SOON_MS : FACTS_AGAIN_MS);
}

/**
 * Native staking's rate, and what the working under Sozu's says is made of:
 * asked once a popup and node, and drawn again when they come. The rate as the
 * chain paid it over the last 30 days (`measured`), where that can be read,
 * else the estimate. The rates measured last, kept a day (keptRatesOf), show
 * till new ones come, and stay where they can't be read.
 * @returns {{ native: number | null, measured?: object, provisioners?: object[], tipHeight?: number, growth?: object | null }}
 */
function sozuRateFigures(ov, st, { actions }) {
  const key = String(ov?.nodeUrl ?? "");
  // How stDUSK grew lately, once the status names its pool: the rate as measured, its line too.
  const measure = (rate) => {
    if (rate.growthAsked || !st.status?.contracts?.pool) return rate;
    rate.growthAsked = true;
    sozuGrowthOf(ov, st.status, rate.tipHeight ?? null).then((growth) => {
      if (st.rate !== rate || !growth) return;
      rate.growth = growth;
      actions?.render?.()?.catch?.(() => {});
    });
    return rate;
  };
  if (st.rate?.key === key) return measure(st.rate);
  const rate = (st.rate = { key, native: null, growth: null });
  const result = (res) => (res?.error ? null : res?.result ?? null);
  const ask = (type) => Promise.resolve(actions?.send?.({ type })).then(result, () => null);
  // The last measured, unless a new measure came first.
  const kept = keptRatesOf(ov)
    .then(({ native, sozu }) => {
      if (st.rate !== rate || !(native || sozu)) return;
      if (native && !rate.measured) Object.assign(rate, { native: native.rate, measured: native });
      if (sozu && !rate.growth) rate.growth = sozu.growth;
      actions?.render?.()?.catch?.(() => {});
    })
    .catch(() => {});
  Promise.all([ask("DUSK_UI_GET_REWARD_RATE"), ask("DUSK_UI_GET_STAKING_FIGURES"), kept]).then(([native, figures]) => {
    if (st.rate !== rate) return;
    Object.assign(rate, rate.measured ? {} : { native: typeof native === "number" ? native : null }, Array.isArray(figures?.provisioners) ? { provisioners: figures.provisioners, tipHeight: figures.tipHeight } : {});
    actions?.render?.()?.catch?.(() => {});
    nativeRewardsOf(ov, figures).then((measured) => {
      if (st.rate !== rate || !measured) return;
      Object.assign(rate, { native: measured.rate, measured });
      actions?.render?.()?.catch?.(() => {});
    });
  });
  return measure(rate);
}

function ensureSozuLoaded(ov, { state, actions } = {}) {
  const st = sozuState(state);
  const idx = Number(ov?.selectedAccountIndex ?? 0) || 0;
  const stale = !st.loaded || st.profileIndex !== idx;
  if (!stale || st.loading) return st;

  st.loading = true;
  st.error = null;
  // An answer from before a switch is for what was switched from: asked again.
  // The context changes as a switch starts, the overview's account once it's done.
  const context = state.context;
  const account = accountOf(ov, idx);
  const place = { nodeUrl: String(ov?.nodeUrl ?? ""), account };
  const read = (st.read = {});
  const switched = () => {
    if (state.context === context && accountOf(state.overview ?? ov, idx) === account) return false;
    st.loading = false;
    st.loaded = false;
    actions?.render?.().catch(() => {});
    return true;
  };
  // What was read last on this device, where nothing's read now: the read
  // failed, or the node's had its time (Lena's: offline, Staking had none of
  // what was with Sozu). Said to be maybe out of date, with when it was read.
  const fromKept = () =>
    keptBalancesOf(place)
      .then((kept) => {
        const sozu = kept?.sozu;
        if (st.read !== read || st.loaded || !sozu?.status || st.status) return;
        Object.assign(st, { readContext: context, readAccount: account, status: sozu.status, pool: sozu.status.pool ?? null, position: sozu.status.position ?? null, readAt: Number(kept.sozuAt) || null, profileIndex: idx, kept: true });
        actions?.render?.().catch(() => {});
      })
      .catch(() => {});
  setTimeout(() => {
    if (st.read === read && st.loading) fromKept();
  }, NODE_ANSWER_MS);
  // A position read last, where this read's failed: the one in hand for
  // this profile, else the one kept on this device.
  const keptPosition = () =>
    keptBalancesOf(place)
      .then((kept) => {
        const position = kept?.sozu?.status?.position;
        const network = kept?.sozu?.status?.networkKey;
        if (st.read !== read || st.position || !position || st.readAccount !== account || (network && network !== st.status?.networkKey)) return;
        Object.assign(st, { status: { ...st.status, position }, position, readAt: Number(kept.sozuAt) || null, kept: true });
        actions?.render?.().catch(() => {});
      })
      .catch(() => {});
  actions?.send?.({ type: "DUSK_UI_GET_SOZU_STATUS", profileIndex: idx })
    ?.then((resp) => {
      if (switched()) return;
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to load Sozu status");
      const status = resp?.result ?? resp ?? null;
      // On a network with Sozu, no position is a read of it that failed, not
      // nothing held: the position read last stays, with when it was read,
      // said to be maybe out of date (round 40's review: the last good one
      // went, and what's held with Sozu was unknown). A position read as
      // nothing held is read as such.
      const unread = status?.configured === true && !status.position;
      // The one in hand only for the same account on the same network: a
      // profile's account is the same on every network (its second review:
      // Testnet's position went with Mainnet's status), else the one kept
      // for this node.
      const sameNetwork = Boolean(st.status?.networkKey) && st.status.networkKey === status?.networkKey;
      const last = unread && sameNetwork && st.readAccount === account && st.position ? { position: st.position, readAt: st.readAt } : null;
      st.readContext = context;
      st.readAccount = account;
      st.status = last ? { ...status, position: last.position } : status;
      st.pool = st.status?.pool ?? null;
      st.position = st.status?.position ?? null;
      // When, for a note that it may be out of date once a read fails or the node goes silent.
      st.readAt = last ? last.readAt : Date.now();
      st.profileIndex = idx;
      st.loaded = true;
      st.loading = false;
      st.kept = Boolean(last);
      if (st.status && !unread) keepBalances(place, { sozu: { status: st.status } }).catch(() => {});
      if (unread && !last) keptPosition();
      // What's through by now counts in the position, read with this status.
      st.history = null;
      maybeAutoWatchStDusk({ state, actions, st, status: st.status, profileIndex: idx });
      actions?.render?.().catch(() => {});
    })
    ?.catch((e) => {
      if (switched()) return;
      st.error = e?.message ?? String(e);
      st.loaded = false;
      st.loading = false;
      actions?.render?.().catch(() => {});
      fromKept();
    });
  return st;
}

/**
 * What the selected profile holds with Sozu, for the Staking overview, as read
 * for this wallet on this network. `known` is false until that's read, or when
 * the read found the pool but not the position. `failed` says the last read
 * failed, so what's known may be out of date, `readAt` when what's known was
 * read, and `reading` that it's being read again.
 * @param {object} ov
 * @param {{ state: object, actions: object }} ctx
 * @returns {{ known: boolean, failed: boolean, reading: boolean, poolLux: bigint, stDuskLux: bigint, readAt: number | null }}
 */
export function sozuHolding(ov, { state, actions } = {}) {
  const st = sozuState(state);
  const idx = Number(ov?.selectedAccountIndex ?? 0) || 0;
  const nodeUrl = String(ov?.nodeUrl ?? "");
  const networkKey = networkKeyOf(Number.isInteger(ov?.chainId) ? ov.chainId : chainIdForNode(nodeUrl), nodeUrl);
  // Read before a switch of wallet, profile or network: not this one's.
  const current = st.readContext === state.context && st.readAccount === accountOf(ov, idx);
  if (st.loaded && !current) st.loaded = false;
  // A custom node's network can come to be known after the read, with no
  // switch: asked again once, as its key may not match until its chain ID is read.
  if (st.status?.networkKey === networkKey) {
    st.askedAgainFor = null;
  } else if (st.loaded && st.askedAgainFor !== networkKey) {
    st.askedAgainFor = networkKey;
    st.loaded = false;
  }
  if (!st.error) ensureSozuLoaded(ov, { state, actions });
  const answered = current && st.profileIndex === idx && st.status?.networkKey === networkKey;
  // A network without Sozu has no position, which is nothing held there. On one
  // with Sozu, no position is a read that failed, not nothing held.
  const noPosition = answered && !st.position && st.status?.configured === true;
  const position = parseSozuPosition((answered && st.position) || {});
  return {
    known: answered && !noPosition,
    failed: Boolean(st.error) || noPosition,
    reading: Boolean(st.loading),
    poolLux: safeBigInt(position.poolBalanceLux, 0n),
    stDuskLux: safeBigInt(position.stDuskBalanceLux, 0n),
    readAt: answered ? st.readAt ?? null : null,
    // The status read for this profile and network, for Rewards by year.
    status: answered ? st.status : null,
  };
}

// Sozu's switches as the screens say them: deposits paused, or a pool being
// synchronized, when calls can fail.
function syncWarning() {
  return h("div", { class: "callout warn sozu-sync", role: "note" }, [
    h("div", { class: "callout-title", text: SYNC_TITLE }),
    h("div", { class: "muted", text: SYNC_TEXT }),
  ]);
}

/**
 * Liquid staking through Sozu, a third party: what Sozu holds for the
 * profile, then the amount to stake or unstake, checked as it is typed.
 * @param {object} ov
 * @param {{ state: object, actions: object, onBack?: Function }} ctx
 */
export function sozuLiquidStakingView(ov, { state, actions, onBack } = {}) {
  // The popup's context as this form is drawn: what its figures are for.
  const formContext = state.context;
  const st = ensureSozuLoaded(ov, { state, actions });
  const staticCfg = sozuConfigOf(ov?.chainId ?? null);
  const liveStatus = st.status;
  const cfg = liveStatus?.configured && liveStatus?.contracts?.pool
    ? { networkKey: liveStatus.networkKey, contracts: liveStatus.contracts }
    : staticCfg;
  const position = st.position ? parseSozuPosition(st.position) : null;
  const { pool, depositFee } = stakeTerms({ ...liveStatus, pool: st.pool });
  // Deposits are open only when Sozu says so: paused, or not known, keeps a stake off.
  const maintenance = liveStatus?.features?.maintenance;
  const paused = maintenance === true;
  const syncing = liveStatus?.features?.synchronization === true;
  // The rate and its working, read once a popup; what the status and the history say of the stake.
  const figures = cfg ? sozuRateFigures(ov, st, { actions }) : { native: null };
  const rateStatus = { ...liveStatus, pool: st.pool, position: st.position };
  const history = cfg && st.loaded && position ? sozuHistory(ov, st, { state, actions }) : { reading: false, rows: [] };
  const publicBalanceLux = safeBigInt(liveStatus?.publicBalance?.value ?? 0, 0n);
  const poolBalanceLux = safeBigInt(position?.poolBalanceLux ?? 0, 0n);
  const stDuskLux = safeBigInt(position?.stDuskBalanceLux ?? 0, 0n);
  const stakeFeeLux = sozuFeeLux(SOZU_FN.STAKE, ov?.customGas);
  const unstakeFeeLux = sozuFeeLux(SOZU_FN.UNSTAKE, ov?.customGas);
  // Max keeps this fee, and the one to unstake later.
  const maxStakeLux = maxAmountLux(publicBalanceLux, stakeFeeLux + unstakeFeeLux);
  const maxUnstakeLux = poolBalanceLux > 0n ? poolBalanceLux : 0n;
  // The least a stake gets stDUSK for, at the rate and fee read now.
  const leastLux = pool && depositFee ? leastSozuStake(pool, depositFee) : null;
  const disabledReason = cfg
    ? ""
    : liveStatus?.reason || "Sozu liquid staking is not configured for this network.";
  const isWithdraw = st.action === "withdraw";
  // Deposits paused or not known: the stake can't go ahead; an unstake can.
  const stakeOff = !isWithdraw && Boolean(cfg && liveStatus) && maintenance !== false;
  const maxActionLux = isWithdraw ? maxUnstakeLux : maxStakeLux;

  const back = () => {
    if (onBack) onBack();
    else {
      // Back to Staking's overview, not to this screen again.
      if (state.staking) state.staking.screen = "overview";
      state.route = "stake";
      actions?.render?.().catch(() => {});
    }
  };

  // Whether Max filled a stake's amount in, for the note on what it kept (maxNote).
  const field = amountField({
    label: isWithdraw ? "Unstake amount" : "Stake amount",
    value: isWithdraw ? st.withdrawAmountDusk : st.depositAmountDusk,
    disabled: !cfg || stakeOff,
    onInput: () => {
      if (!isWithdraw) st.depositMax = false;
      check();
    },
    onEnter: () => review(),
  });

  const estimate = h("div", { class: "stake-estimate", hidden: true });
  // What the stake typed earns in a year at today's rate, under Details.
  const yearNote = h("div", { class: "stake-cap sozu-year", hidden: true });
  // What Sozu takes of a stake, before and as it's typed; how an unstake comes back.
  const feeLine = (feeLux = null) => [depositFee ? `Deposit fee ${depositFeeText(depositFee, feeLux)}` : "Deposit fee not read yet"];
  const termsNote = h("p", { class: "amount-note sozu-terms", hidden: stakeOff || !cfg }, isWithdraw ? [SOZU_UNSTAKE_LINE] : feeLine());
  // What Max kept of a stake, each fee at most, once it filled the amount in.
  const maxNote = h("p", { class: "amount-note sozu-max", hidden: true });
  const showMaxNote = (shown) => {
    maxNote.textContent = shown
      ? `Max keeps ${formatFee(stakeFeeLux + unstakeFeeLux, { max: true })} DUSK: up to ${formatFee(stakeFeeLux, { max: true })} for this fee and ${formatFee(unstakeFeeLux, { max: true })} to unstake later.`
      : "";
    maxNote.hidden = !shown;
  };
  const reviewBtn = h("button", {
    class: "btn-primary",
    type: "button",
    text: isWithdraw ? "Review unstake" : "Review stake",
    disabled: true,
    onclick: () => review(),
  });

  // The amount, checked as it is typed: the error under the field, Review
  // only when it can go ahead, and for a stake, Sozu's fee and what it gets.
  function check() {
    const raw = String(field.input.value ?? "").trim();
    if (isWithdraw) st.withdrawAmountDusk = raw;
    else st.depositAmountDusk = raw;
    estimate.hidden = true;
    yearNote.hidden = true;
    showMaxNote(false);
    if (!isWithdraw) termsNote.replaceChildren(...feeLine());
    if (!cfg) {
      field.setError(disabledReason);
      reviewBtn.disabled = true;
      return null;
    }
    if (stakeOff) {
      field.setError("");
      reviewBtn.disabled = true;
      return null;
    }
    if (!raw) {
      field.setError("");
      reviewBtn.disabled = true;
      return null;
    }
    let lux;
    try {
      lux = safeBigInt(parseAmountLux(raw), 0n);
    } catch (e) {
      if (/greater than 0/.test(String(e?.message))) field.setError("Enter an amount greater than 0.");
      else field.setProblem(raw, { whole: "10", decimal: "10.5" });
      reviewBtn.disabled = true;
      return null;
    }
    if (isWithdraw) {
      if (!sozuUnstakeAllowed(lux, maxUnstakeLux)) {
        field.setError("That's more than you have staked with Sozu.");
        reviewBtn.disabled = true;
        return null;
      }
      // The DUSK comes back from Sozu, but the fee comes from the public balance.
      if (liveStatus?.publicBalance && unstakeFeeLux > publicBalanceLux) {
        field.setError(shortfallText({ missingLux: unstakeFeeLux - publicBalanceLux, moves: false }));
        reviewBtn.disabled = true;
        return null;
      }
      field.setError("");
      reviewBtn.disabled = false;
      return lux;
    }
    // A stake needs the pool's rate and Sozu's fee, read now.
    const quote = stakeQuote(lux, pool, depositFee);
    if (!quote) {
      field.setError(st.loading ? "" : "Sozu's rate and fees couldn't be read. Try again later.");
      reviewBtn.disabled = true;
      return null;
    }
    termsNote.replaceChildren(...feeLine(quote.fee));
    if (!quote.ok) {
      field.setError(leastLux === null ? NO_STAKE_TEXT : `The minimum stake is ${formatDuskExact(leastLux.toString())} DUSK.`);
      reviewBtn.disabled = true;
      return null;
    }
    // What it gets for what's left after the fee, and its worth now; what that
    // earns in a year at today's rate under Details, where what stDUSK is, and
    // that its worth moves with the pool, are said too.
    const { earned } = sozuYear({ amount: lux, growth: figures.growth, nativeRate: figures.native, status: rateStatus });
    estimate.replaceChildren(
      h("div", { class: "stake-estimate__main", text: `You get about ${stDuskText(quote.stDusk)} stDUSK, worth about ${formatDusk(quote.worth.toString())} DUSK now.` })
    );
    estimate.hidden = false;
    yearNote.replaceChildren(
      ...(earned !== null && earned > 0n ? [`At today's rate that's about ${formatDusk(earned)} DUSK in rewards a year, after Sozu's share and the deposit fee.`] : [])
    );
    yearNote.hidden = !(earned !== null && earned > 0n);
    if (lux > maxStakeLux) {
      field.setError(shortfallText({ missingLux: lux + stakeFeeLux + unstakeFeeLux - publicBalanceLux, withFee: "this fee and the fee to unstake later" }));
      reviewBtn.disabled = true;
      return null;
    }
    field.setError("");
    reviewBtn.disabled = false;
    showMaxNote(Boolean(st.depositMax));
    return lux;
  }

  function review() {
    const amountLux = check();
    if (amountLux == null) {
      field.input.focus();
      return;
    }
    const quote = isWithdraw ? null : stakeQuote(amountLux, pool, depositFee);
    const profileIndex = Number(ov?.selectedAccountIndex ?? 0) || 0;
    st.notice = "";
    state.sozuDraft = {
      ...(isWithdraw
        ? buildSozuWithdrawTx({ config: cfg, amountLux })
        : buildSozuDepositTx({ config: cfg, amountLux })),
      profileIndex,
      fnArgsAmountLux: amountLux.toString(),
      quote: quote ? quoteJson(quote, depositFee) : null,
      label: isWithdraw ? "Unstake from Sozu" : "Liquid staking",
      // Where it belongs, as this form was drawn: its Review checks the popup is still there.
      reviewed: reviewRecord(ov, profileIndex, formContext, liveStatus?.networkKey),
    };
    state.route = "sozu_confirm";
    actions?.render?.().catch(() => {});
  }

  const setAction = (next) => {
    st.action = next;
    actions?.render?.().catch(() => {});
  };
  const actionTabs = h("div", {
    class: "tabs sozu-action-tabs",
    role: "tablist",
    style: `--seg-index: ${isWithdraw ? 1 : 0};`,
  }, [
    h("button", {
      class: isWithdraw ? "tab" : "tab is-active",
      role: "tab",
      "aria-selected": String(!isWithdraw),
      disabled: !cfg,
      onclick: () => setAction("deposit"),
    }, [h("span", { text: "Stake" })]),
    h("button", {
      class: isWithdraw ? "tab is-active" : "tab",
      role: "tab",
      "aria-selected": String(isWithdraw),
      disabled: !cfg,
      onclick: () => setAction("withdraw"),
    }, [h("span", { text: "Unstake" })]),
  ]);

  const maxBtn = h("button", {
    class: "mini-btn",
    type: "button",
    text: "Max",
    title: isWithdraw ? "All you have staked with Sozu" : "All of it, less the network fee and the fee to unstake later",
    disabled: !cfg || stakeOff || maxActionLux <= 0n,
    onclick: () => {
      if (!isWithdraw) st.depositMax = true;
      field.setValue(formatLuxForInput(maxActionLux));
      check();
      field.focus();
    },
  });
  const available = h("div", { class: "amount-avail" }, [
    h(
      "span",
      {},
      isWithdraw
        ? [`Staked with Sozu ${fmtLux(poolBalanceLux)} DUSK`]
        : [`Available ${fmtLux(publicBalanceLux)} DUSK from your public balance`]
    ),
    maxBtn,
  ]);

  // stDUSK in Assets: open it once added, else add it.
  const stDuskContractId = cfg?.contracts?.["staked-dusk"];
  const currentProfileIndex = Number(ov?.selectedAccountIndex ?? 0) || 0;
  const currentStDuskWatchKey = stDuskContractId ? stDuskWatchKey(currentProfileIndex, stDuskContractId) : "";
  const stDuskPending = stDuskLux > 0n && currentStDuskWatchKey && st.autoStDuskWatchPending === currentStDuskWatchKey;
  const stDuskAutoAdded = stDuskLux > 0n && currentStDuskWatchKey && st.autoStDuskWatchKey === currentStDuskWatchKey;
  const assetError = h("div", { class: "field-error", role: "alert", hidden: true });
  const addStDuskToken = async () => {
    try {
      if (!stDuskContractId) throw new Error("The stDUSK contract isn't known yet.");
      const resp = await actions?.send?.({
        type: "DUSK_UI_ASSETS_WATCH_TOKEN",
        profileIndex: currentProfileIndex,
        token: makeSozuStDuskToken(stDuskContractId),
      });
      if (resp?.error) throw new Error(resp.error.message ?? "Couldn't add stDUSK");
      st.autoStDuskWatchKey = stDuskWatchKey(currentProfileIndex, stDuskContractId);
      if (state.assets) state.assets.loaded = false;
      actions?.showToast?.("stDUSK added to Assets.");
      actions?.render?.({ forceRefresh: true }).catch(() => {});
    } catch (e) {
      assetError.textContent = e?.message ?? String(e);
      assetError.hidden = false;
    }
  };
  const openStDuskAsset = () => {
    state.assetTokenContractId = canonicalContractId(stDuskContractId);
    state.route = "asset_token";
    actions?.render?.().catch(() => {});
  };
  const stDuskAction = !stDuskContractId
    ? null
    : stDuskAutoAdded
      ? h("button", { class: "mini-btn", type: "button", text: "Open", "aria-label": "Open stDUSK in Assets", onclick: openStDuskAsset })
      : stDuskPending
        ? h("span", { class: "muted", text: "Adding…" })
        : h("button", { class: "mini-btn", type: "button", text: "Add to Assets", "aria-label": "Add stDUSK to Assets", onclick: addStDuskToken });

  const kv = (label, value) =>
    h("div", { class: "kv" }, [h("span", { class: "kv-label", text: label }), h("span", { class: "kv-value" }, [].concat(value))]);

  // The position, as the shared sums make it (sozuPosition), in both wallets'
  // words: each short, as a row is, with what it is to the last lux for a
  // pointer. What it's worth now and its stDUSK on the screen; what's put in,
  // taken out and earned under Details. Those wait for the whole history, and
  // the rewards for each stake's deposit fee; they're before those fees, which
  // the row above them says, as Rewards by year's growth is after them. They're
  // what's held, hidden with the balances, as Staking's are, a loss's sign
  // too; the forms under them show theirs, as they're used.
  const hidden = balancesHidden(ov);
  const held = sozuPosition({ rows: history.rows, status: rateStatus, facts: history.facts, complete: Boolean(history.whole) });
  const money = (lux) => h("span", { title: hidden ? undefined : formatDuskExact(lux.toString()) }, [balance(hidden, fmtLux(lux)), " DUSK"]);
  const reading = h("span", { class: "muted", text: "Reading your history…" });
  const positionGroup = position && (poolBalanceLux > 0n || stDuskLux > 0n || held.putIn > 0n)
    ? h("div", { class: "group sozu-position" }, [
        kv(POSITION_WORDS.worthNow, money(poolBalanceLux)),
        kv(POSITION_WORDS.stDusk, [balance(hidden, fmtLux(stDuskLux)), " stDUSK", stDuskAction].filter(Boolean)),
        held.waiting ? h("p", { class: "stake-cap", text: held.waiting === 1 ? "One more on its way isn't counted yet." : `${held.waiting} more on their way aren't counted yet.` }) : null,
      ].filter(Boolean))
    : null;
  const historyRows = positionGroup
    ? [
        history.whole ? kv(POSITION_WORDS.putIn, money(held.putIn)) : null,
        history.whole && held.takenOut > 0n ? kv(POSITION_WORDS.takenOut, money(held.takenOut)) : null,
        history.whole && held.depositFees > 0n ? kv(held.feesExact ? POSITION_WORDS.depositFees : POSITION_WORDS.depositFeesAbout, money(held.depositFees)) : null,
        history.reading
          ? kv(POSITION_WORDS.earned, reading)
          : history.whole && held.earned !== null
            ? kv(POSITION_WORDS.earned, held.earned < 0n && !hidden ? h("span", {}, [MINUS, money(-held.earned)]) : money(held.earned < 0n ? -held.earned : held.earned))
            : null,
      ].filter(Boolean)
    : [];

  const sozuLink = h("button", {
    class: "text-btn chain-link sozu-site",
    type: "button",
    text: "sozu.fi",
    onclick: async () => {
      const ok = await openUrl(SOZU_URL);
      if (!ok) actions?.showToast?.("Couldn't open sozu.fi");
    },
  });

  const fees = sozuFeeFact(liveStatus?.fees);
  // A fact: its title, the line or lines under it, and what can be done with it.
  const fact = (iconName, title, sub, extra = null) =>
    h("div", { class: "list-row" }, [
      h("span", { class: "row-icon", html: iconSvg(iconName) }),
      h("span", { class: "row-main" }, [h("span", { class: "row-title", text: title }), ...[].concat(sub).filter(Boolean).map((line) => h("span", { class: "row-sub", text: line }))]),
      extra,
    ].filter(Boolean));
  // What it pays a year, once that's read, after Sozu's share of rewards; the one line of what that's made of under Details.
  const yearly = sozuRate(figures.native, rateStatus, figures.growth);
  const working = sozuRateLine({ growth: figures.growth, native: figures.measured ?? null, nativeRate: figures.native, provisioners: figures.provisioners, tipHeight: figures.tipHeight, status: rateStatus, locale: amountLocale() });
  const rewardFee = feeRateOf(rateStatus?.fees?.reward);
  const facts = h("div", { class: "group info" }, [
    yearly !== null && working
      ? fact(
          "percent",
          `About ${new Intl.NumberFormat(amountLocale(), { maximumFractionDigits: 0, style: "percent" }).format(yearly)} a year, after Sozu's ${rewardFee ? feePercent(rewardFee, amountLocale()) : "share"}. Not promised.`
        )
      : null,
    fact("fee", `Fee up to ${formatFee(isWithdraw ? unstakeFeeLux : stakeFeeLux, { max: true })} DUSK`),
  ].filter(Boolean));
  // The rest, out of the way, open or not as it was left: the position's
  // history, what a stake typed earns, the rate's working, Sozu's own fees
  // (read from its contract each time), what Sozu staking takes and gives,
  // and that stDUSK's worth moves with the pool.
  const details = h("details", { class: "advanced sozu-details", open: Boolean(st.detailsOpen) }, [
    h("summary", { text: "Details" }),
    h("div", { class: "advanced-body" }, [
      historyRows.length ? h("div", { class: "group group--inset sozu-history" }, historyRows) : null,
      yearNote,
      yearly !== null && working ? h("p", { class: "stake-cap sozu-working", text: working }) : null,
      h("div", { class: "group info" }, [
        fact("percent", fees.title, fees.sub),
        fact(
          "drop",
          "Any amount, no node needed",
          ["You get stDUSK, a token for your share of Sozu's pool.", "stDUSK's DUSK value follows Sozu's pool, its rewards and its fees."],
          positionGroup ? null : stDuskAction
        ),
      ]),
    ].filter(Boolean)),
  ]);
  details.addEventListener("toggle", () => {
    st.detailsOpen = details.open;
  });

  // Brought back from Review, the amount says how it stands at once.
  if ((isWithdraw ? st.withdrawAmountDusk : st.depositAmountDusk) || !cfg) check();

  return [
    subnav({ title: "Liquid staking", onBack: back }),
    h("div", { class: "liquid-intro" }, [
      h("div", { class: "liquid-who" }, ["Sozu", h("span", { class: "tag", text: "third party" }), sozuLink]),
    ]),
    st.notice ? h("div", { class: "muted sozu-notice", role: "status", text: st.notice }) : null,
    st.loading && !st.loaded ? waiting("Loading Sozu…") : null,
    st.error ? h("div", { class: "err", text: st.error }) : null,
    cfg && liveStatus?.reason ? h("div", { class: "muted", text: liveStatus.reason }) : null,
    syncing ? syncWarning() : null,
    positionGroup,
    positionGroup ? stakeStaleNote(ov, [st.readAt], { kept: Boolean(st.kept) }) : null,
    assetError,
    actionTabs,
    stakeOff
      ? h("div", { class: "callout sozu-paused", role: "note" }, [
          h("div", { class: "callout-title", text: paused ? PAUSED_TITLE : UNCHECKED_TITLE }),
          h("div", { class: "muted", text: paused ? "Unstaking still works." : "Staking stays off until they can be. Unstaking still works." }),
        ])
      : null,
    h("div", { class: "amount-entry" }, [field.el, field.error, available, maxNote, termsNote, estimate]),
    // Review right under the amount, so both fit above a phone's keyboard.
    h("div", { class: "stake-bottom" }, [reviewBtn]),
    facts,
    details,
  ].filter(Boolean);
}

export function sozuConfirmView(ov, { state, actions } = {}) {
  const draft = state.sozuDraft;
  if (!draft) {
    state.route = "stake";
    return sozuLiquidStakingView(ov, { state, actions });
  }

  const st = sozuState(state);
  // Where this stake belongs (reviewRecord); anywhere else, back to the stake's form, with why.
  const record = draft.reviewed ?? null;
  if (!stillFor(record, state, ov)) {
    leaveReview(state, st, record, ov);
    return sozuLiquidStakingView(ov, { state, actions });
  }
  const liveStatus = st.status;
  const publicBalance = safeBigInt(liveStatus?.publicBalance?.value ?? 0, 0n);
  const draftNeeds = draftAmountLux(draft);
  const isStake = draft.fnName === SOZU_FN.STAKE;
  const fnName = isStake ? SOZU_FN.STAKE : SOZU_FN.UNSTAKE;
  // Deposits paused or not known since the form: the stake waits; an unstake goes ahead.
  const maintenance = liveStatus?.features?.maintenance;
  const paused = isStake && maintenance !== false;
  const syncing = liveStatus?.features?.synchronization === true;
  // What the stake gets, and Sozu's fee off it: as worked out on the form, or
  // as read again before it was sent.
  const quote = isStake ? draft.quote ?? null : null;
  const quoteRate = feeRateOf(quote?.feeRate);
  const getsNothing = quote?.ok === false;
  // What it pays with is checked with the fee as Custom fee changes it (payGuard, below).
  const submitDisabled = paused || getsNothing;
  const submitDisabledReason = paused
    ? `${maintenance === true ? PAUSED_TITLE : UNCHECKED_TITLE}.`
    : getsNothing
    ? "At Sozu's deposit fee now, this stake gets no stDUSK."
    : "";

  // Back returns to Staking, so Review has no Cancel.
  const goBack = () => {
    state.route = "stake";
    actions?.render?.().catch(() => {});
  };

  // The button names what it does, with the amount as the head shows it: "Stake 0.5 DUSK".
  const confirmBtn = h("button", {
    class: "btn-primary",
    disabled: submitDisabled || rechecking.has(draft),
    text: `${isStake ? "Stake" : "Unstake"} ${formatDuskExact(draftNeeds.toString())} DUSK`,
  });

  // The call's own gas at the network's price; Custom fee for gas of your own.
  const gasOpts = { privacy: "public", fnName };
  const ownGas = getDefaultGas(TX_KIND.CONTRACT_CALL, gasOpts);
  const gasEditor = document.createElement("dusk-gas-editor");
  gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;
  // A stake's total is its deposit and fee; what an unstake brings back is
  // what you receive, the fee apart (Lena's: "Total up to 0.01 DUSK" for 0.1).
  gasEditor.comesBack = !isStake;
  gasEditor.amountLux = isStake ? "0" : draftNeeds.toString();
  gasEditor.extraLux = [String(draft.deposit ?? "0")];
  gasEditor.setGas(draft?.gas ?? null);
  // The contract the call goes to, Sozu's pool as its hub named it, with the
  // gas under Custom fee: there to check before it's sent, out of the way.
  const poolId = contractIdText(draft.contractId);
  const contractRow = h("div", { class: "kv sozu-contract" }, [
    h("span", { class: "kv-label", text: "Contract" }),
    h("span", { class: "kv-value" }, [
      contractValueEl(
        contractLabel(poolId, ov?.nodeUrl) ?? "Sozu pool",
        h("span", { class: "mono", title: poolId, text: contractIdText(poolId, { short: true }) }),
        copyContractButton(poolId, actions?.showToast)
      ),
    ]),
  ]);
  useNetworkGas({
    customGas: ov?.customGas,
    actions,
    gas: draft?.gas,
    defaultLimit: ownGas.limit,
    fallbackPrice: ownGas.price,
    gasEditor,
    minLimit: getMinimumGas(TX_KIND.CONTRACT_CALL, gasOpts)?.limit,
    extra: contractRow,
  });

  // The public balance pays: a stake with its fee, an unstake its fee alone.
  const pay = payGuard({
    editor: gasEditor,
    availableLux: liveStatus?.publicBalance ? publicBalance : null,
    sendsLux: isStake ? draftNeeds : 0n,
    button: confirmBtn,
    ready: () => !submitDisabled && !rechecking.has(draft),
  });

  const title = isStake ? "Liquid staking" : "Unstake from Sozu";
  const line = isStake ? "With Sozu, a third party" : "From Sozu, back to your public balance";
  const profileName = profileNameEl(ov, { index: Number(draft.profileIndex ?? 0) || 0 });

  // Gas that won't do, or terms that couldn't be checked, say so above its button; nothing is sent.
  const confirmError = h("div", { class: "field-error", role: "alert", hidden: !draft.checkError, text: draft.checkError ?? "" });

  // This Review, with the popup still where its stake belongs (reviewRecord).
  const onThisReview = () => state.route === "sozu_confirm" && state.sozuDraft === draft;
  const belongs = () => stillFor(record, state, ov);
  const stillHere = (terms) =>
    onThisReview() &&
    belongs() &&
    (!terms || !record.networkKey || String(terms.status?.networkKey ?? "") === record.networkKey);
  // Not where it belongs any more: back to the stake's form, with why.
  const leave = ({ refresh = false } = {}) => {
    leaveReview(state, st, record, ov);
    if (refresh) state.needsRefresh = true;
    actions?.render?.().catch(() => {});
  };

  // It ignores a click for a moment once Review is up (clickGuard.js).
  confirmBtn.addEventListener("click", guarded(async () => {
    // One check at a time for this stake, whichever Review's button is pressed.
    if (rechecking.has(draft) || !pay.covered()) return;
    // The popup moved on since this Review was drawn.
    if (!stillHere(null)) {
      if (onThisReview()) leave();
      return;
    }
    let gas;
    try {
      gas = gasEditor.readFinalGas();
    } catch (e) {
      confirmError.textContent = e?.message ?? String(e);
      confirmError.hidden = false;
      return;
    }
    draft.checkError = "";
    confirmError.hidden = true;
    confirmBtn.disabled = true;
    // Fields left empty send the call's own gas at the network's price,
    // never the wallet's default for any contract call.
    const sentGas = gas ?? gasEditor.networkGas ?? { limit: ownGas.limit, price: ownGas.price };
    draft.gas = gas;
    // A stake goes ahead on Sozu's terms as they are when it's sent: read
    // them again first, and if anything this Review shows changed, show the
    // new figures for another press instead of sending.
    if (isStake) {
      rechecking.add(draft);
      let terms = null;
      try {
        terms = await readStakeTerms(actions, draft);
      } finally {
        rechecking.delete(draft);
      }
      // Left meanwhile, another stake drafted, or another network or profile:
      // the answer is for nothing now. Still on this Review, it's back to the
      // stake's form, from the overview read again: another window may have
      // switched.
      if (!stillHere(terms)) {
        if (onThisReview()) leave({ refresh: true });
        return;
      }
      if (!terms) {
        // Staking reads Sozu again on the way back.
        st.loaded = false;
        draft.checkError =
          globalThis.navigator?.onLine === false
            ? "No connection, so nothing was sent. Try again once you're back online."
            : "Couldn't check Sozu's terms just now, so nothing was sent. Try again.";
        actions?.render?.().catch(() => {});
        return;
      }
      if (applyStakeTerms({ st, draft, terms })) {
        // New figures, for a press of their own: one a moment ago is not for them.
        screenShown();
        actions?.render?.().catch(() => {});
        return;
      }
    }
    const { quote: _quote, label: _label, termsChanged: _changed, checkError: _error, reviewed: _reviewed, ...txDraft } = draft;
    // The engine sends it only on the wallet, profile, account and node the
    // stake was drafted on, whichever window switched them meanwhile.
    const { walletId, profileIndex, account, nodeUrl } = record;
    const params = { ...txDraft, gas: sentGas, _approvalContext: { walletId, profileIndex, account, nodeUrl } };
    await sendFromReview({
      state,
      actions,
      message: {
        type: "DUSK_UI_SEND_TX",
        params,
        asset: { kind: "sozu", action: params.fnName, pool: params.contractId },
      },
      summary: {
        title,
        amountLux: draftNeeds.toString(),
        line,
        // For Completed to say what it got or gave back in stDUSK, from its pool's event.
        sozu: isStake ? "stake" : "unstake",
        pool: params.contractId,
        from: isStake ? "from your public balance" : "",
        feeCapLux: (safeBigInt(sentGas.limit, 0n) * safeBigInt(sentGas.price, 0n)).toString(),
      },
      backRoute: "sozu_confirm",
      doneRoute: "stake",
      // A switch begun while the Sent screen was drawn keeps it from going.
      unchanged: belongs,
      onSent: () => {
        st.loaded = false;
        st.loading = false;
        // Done with, unless a newer Sozu draft took its place meanwhile.
        if (state.sozuDraft !== draft) return;
        state.sozuDraft = null;
        if (isStake) st.depositAmountDusk = "";
        else st.withdrawAmountDusk = "";
        if (state.staking) state.staking.screen = "overview";
      },
    });
    pay.draw();
  }));
  submitOnGasEnter(gasEditor, confirmBtn, { ready: () => !submitDisabled && !rechecking.has(draft) && pay.covered() });

  const kv = (label, value) =>
    h("div", { class: "kv" }, [h("span", { class: "kv-label", text: label }), h("span", { class: "kv-value" }, [].concat(value))]);

  return [
    subnav({ title: "Review", onBack: goBack }),
    h("div", { class: "row" }, [
      h("div", { class: "review-head" }, [
        h("div", { class: "review-kind", text: title }),
        h("div", { class: "balance-amount", text: `${formatDuskExact(draftNeeds.toString())} DUSK` }),
        h("div", { class: "review-line", text: line }),
      ]),
      draft.termsChanged
        ? h("div", { class: "callout warn sozu-changed", role: "alert" }, [
            h("div", { class: "callout-title", text: CHANGED_TITLE }),
            h("div", { class: "muted", text: CHANGED_TEXT }),
          ])
        : null,
      syncing ? syncWarning() : null,
      h("div", { class: "group" }, [
        quote
          ? kv("You get about", `${stDuskText(quote.stDusk)} stDUSK, worth about ${fmtLux(quote.worth)} DUSK now`)
          : null,
        quote && quoteRate ? kv("Deposit fee", depositFeeRow(quote, quoteRate)) : null,
        kv(isStake ? "From" : "To", [h("span", {}, [withReviewWallet(profileName, actions?.review), h("span", { class: "kv-muted", text: " · Public" })])]),
      ].filter(Boolean)),
      // How an unstake comes back; a stake's deposit fee row says it doesn't.
      isStake ? depositFeeGone(quote, quoteRate) : h("p", { class: "stake-cap", text: SOZU_UNSTAKE_LINE }),
      gasEditor,
      reviewActions(
        confirmBtn,
        submitDisabledReason ? h("div", { class: "field-error", role: "alert", text: submitDisabledReason }) : null,
        confirmError,
        pay.el
      ),
    ].filter(Boolean)),
  ];
}
