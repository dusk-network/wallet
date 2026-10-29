import {
  UI_DISPLAY_DECIMALS,
  formatDusk,
  formatDuskExact,
  formatFee,
  formatLuxToDusk,
  maxAmountLux,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
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
import { contractIdText } from "../../lib/strings.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { amountField } from "../../components/AmountField.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { contractValueEl, copyContractButton } from "../../components/ContractValue.js";
import { submitOnGasEnter } from "../../components/FormControls.js";
import { gasFeeLux, startingGas, useNetworkGas } from "../../components/NetworkGas.js";
import { profileNameEl } from "../../components/ProfileName.js";
import { sendFromReview } from "./sent.js";

// What a stake of `amount` gets with Sozu (sozuStake), once both the pool's
// rate and the deposit fee are read; null until then.
const stakeQuote = (amount, pool, depositFee) => (pool && depositFee ? sozuStake(amount, pool, depositFee) : null);

function fmtLux(value) {
  return formatDusk(value ?? "0", UI_DISPLAY_DECIMALS);
}

// Sozu's site.
const SOZU_URL = "https://sozu.fi/";

/** How an unstake from Sozu comes back: its pool pays it out in the same call. */
export const SOZU_UNSTAKE_LINE = "The DUSK comes back in the same transaction. No fee, no waiting.";

// Sozu's switches, as its substrate reads them: deposits paused, or not known.
const PAUSED_TITLE = "Sozu has paused deposits";
const UNCHECKED_TITLE = "Sozu's deposits couldn't be checked";
const SYNC_TITLE = "Sozu is synchronizing its pool";
const SYNC_TEXT = "A stake or unstake can fail until it's done.";

// A fee so high that no stake gets stDUSK: 100%, or so near it that the least is past any amount.
const NO_STAKE_TEXT = "No stake gets stDUSK at Sozu's deposit fee now.";

// Sozu's terms read again before a stake is sent, and found changed.
const CHANGED_TITLE = "Sozu's terms changed";
const CHANGED_TEXT = "These are the figures now. Check them, then confirm again.";

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
    title: `Sozu keeps ${feePercent(reward, "en")} of rewards`,
    sub: `${feePercent(deposit, "en")} on deposits · No fee to unstake`,
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
  const pct = feePercent(rate, "en");
  return feeLux === null ? pct : `${pct} · ${formatDuskExact(feeLux.toString())} DUSK`;
}

/**
 * The deposit fee for h(): with Hide balances, its DUSK is hidden as the
 * amount it gives away is ("0.25% · •••• DUSK").
 */
function depositFeeParts(rate, feeLux, hidden) {
  const pct = feePercent(rate, "en");
  return feeLux === null ? [pct] : [`${pct} · `, balance(hidden, formatDuskExact(feeLux.toString())), " DUSK"];
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

// Drafted stakes whose Confirm is reading Sozu's terms again: one check at a
// time for each, a redrawn Review's Confirm included.
const rechecking = new WeakSet();

/**
 * Where a drafted call to Sozu belongs, recorded as it enters Review: the
 * popup's context, and the node, network, wallet, profile and account, as
 * the form it was drafted on was drawn. Its Review compares the popup with
 * this record, never with what the Review was last drawn with: the context
 * is replaced the moment a switch starts (context.js), before the overview
 * names the new network or profile. Drawn after a switch or a lock, the
 * Review offers no Confirm; a check that answers after one, from another
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

function ensureSozuLoaded(ov, { state, actions } = {}) {
  const st = sozuState(state);
  const idx = Number(ov?.selectedAccountIndex ?? 0) || 0;
  const stale = !st.loaded || st.profileIndex !== idx;
  if (!stale || st.loading) return st;

  st.loading = true;
  st.error = null;
  actions?.send?.({ type: "DUSK_UI_GET_SOZU_STATUS", profileIndex: idx })
    ?.then((resp) => {
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to load Sozu status");
      st.status = resp?.result ?? resp ?? null;
      st.pool = st.status?.pool ?? null;
      st.position = st.status?.position ?? null;
      st.profileIndex = idx;
      st.loaded = true;
      st.loading = false;
      maybeAutoWatchStDusk({ state, actions, st, status: st.status, profileIndex: idx });
      actions?.render?.().catch(() => {});
    })
    ?.catch((e) => {
      st.error = e?.message ?? String(e);
      st.loaded = false;
      st.loading = false;
      actions?.render?.().catch(() => {});
    });
  return st;
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
  const hidden = balancesHidden(ov);
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

  const field = amountField({
    label: isWithdraw ? "Unstake amount" : "Stake amount",
    value: isWithdraw ? st.withdrawAmountDusk : st.depositAmountDusk,
    disabled: !cfg || stakeOff,
    onInput: () => check(),
    onEnter: () => review(),
  });

  const estimate = h("div", { class: "stake-estimate", hidden: true });
  // What Sozu takes of a stake, before and as it's typed; how an unstake comes back.
  const feeLine = (feeLux = null) => (depositFee ? ["Deposit fee ", ...depositFeeParts(depositFee, feeLux, hidden)] : ["Deposit fee not read yet"]);
  const termsNote = h("p", { class: "amount-note sozu-terms", hidden: stakeOff || !cfg }, isWithdraw ? [SOZU_UNSTAKE_LINE] : feeLine());
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
      field.setError(/greater than 0/.test(String(e?.message)) ? "Enter an amount greater than 0." : "Enter an amount such as 10 or 10.5.");
      reviewBtn.disabled = true;
      return null;
    }
    if (isWithdraw) {
      if (!sozuUnstakeAllowed(lux, maxUnstakeLux)) {
        field.setError("That's more than you have staked with Sozu.");
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
    if (lux > maxStakeLux) {
      field.setError("That's more than your public balance, with the network fee.");
      reviewBtn.disabled = true;
      return null;
    }
    field.setError("");
    reviewBtn.disabled = false;
    // What it gets for what's left after the fee, then what stDUSK is.
    estimate.replaceChildren(
      h("div", {
        class: "stake-estimate__main",
        text: `You get about ${stDuskText(quote.stDusk)} stDUSK, worth about ${formatDusk(quote.worth.toString())} DUSK now.`,
      }),
      h("div", { text: "stDUSK is Sozu's token for your share. Its DUSK value follows Sozu's pool, its rewards and its fees." })
    );
    estimate.hidden = false;
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
      field.setValue(formatLuxToDusk(maxActionLux));
      check();
      field.input.focus();
    },
  });
  const available = h("div", { class: "amount-avail" }, [
    h(
      "span",
      {},
      isWithdraw
        ? ["Staked with Sozu ", balance(hidden, fmtLux(poolBalanceLux)), " DUSK"]
        : ["Available ", balance(hidden, fmtLux(publicBalanceLux)), " DUSK from your public balance"]
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

  const positionGroup = position && (poolBalanceLux > 0n || stDuskLux > 0n)
    ? h("div", { class: "group" }, [
        kv("Staked with Sozu", [balance(hidden, fmtLux(poolBalanceLux)), " DUSK"]),
        kv("stDUSK", [balance(hidden, fmtLux(stDuskLux)), " stDUSK", stDuskAction].filter(Boolean)),
      ])
    : null;

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
  const fact = (iconName, title, sub, extra = null) =>
    h("div", { class: "list-row" }, [
      h("span", { class: "row-icon", html: iconSvg(iconName) }),
      h("span", { class: "row-main" }, [h("span", { class: "row-title", text: title }), sub ? h("span", { class: "row-sub", text: sub }) : null].filter(Boolean)),
      extra,
    ].filter(Boolean));
  const facts = h("div", { class: "group info" }, [
    fact("drop", "Any amount, no node needed", "You get stDUSK, a token for your share of Sozu's pool.", positionGroup ? null : stDuskAction),
    // Sozu's own fees, read from its contract each time.
    fact("percent", fees.title, fees.sub),
    fact("fee", `Network fee up to ${formatFee(isWithdraw ? unstakeFeeLux : stakeFeeLux, { max: true })} DUSK`),
  ].filter(Boolean));

  // Brought back from Review, the amount says how it stands at once.
  if ((isWithdraw ? st.withdrawAmountDusk : st.depositAmountDusk) || !cfg) check();

  return [
    subnav({ title: "Liquid staking", onBack: back }),
    h("div", { class: "liquid-intro" }, [
      h("div", { class: "liquid-who" }, ["Sozu", h("span", { class: "tag", text: "third party" }), sozuLink]),
    ]),
    st.notice ? h("div", { class: "muted sozu-notice", role: "status", text: st.notice }) : null,
    st.loading && !st.loaded ? h("div", { class: "muted", text: "Loading Sozu…" }) : null,
    st.error ? h("div", { class: "err", text: st.error }) : null,
    cfg && liveStatus?.reason ? h("div", { class: "muted", text: liveStatus.reason }) : null,
    syncing ? syncWarning() : null,
    positionGroup,
    assetError,
    actionTabs,
    stakeOff
      ? h("div", { class: "callout sozu-paused", role: "note" }, [
          h("div", { class: "callout-title", text: paused ? PAUSED_TITLE : UNCHECKED_TITLE }),
          h("div", { class: "muted", text: paused ? "Unstaking still works." : "Staking stays off until they can be. Unstaking still works." }),
        ])
      : null,
    h("div", { class: "amount-entry" }, [field.el, field.error, available, termsNote, estimate]),
    facts,
    h("div", { class: "stake-bottom" }, [reviewBtn]),
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
  const draftFeeLux = sozuFeeLux(fnName, ov?.customGas, draft?.gas);
  const stakeRequiredLux = isStake ? draftNeeds + draftFeeLux : draftFeeLux;
  // Deposits paused or not known since the form: the stake waits; an unstake goes ahead.
  const maintenance = liveStatus?.features?.maintenance;
  const paused = isStake && maintenance !== false;
  const syncing = liveStatus?.features?.synchronization === true;
  // What the stake gets, and Sozu's fee off it: as worked out on the form, or
  // as read again before it was sent.
  const quote = isStake ? draft.quote ?? null : null;
  const quoteRate = feeRateOf(quote?.feeRate);
  const getsNothing = quote?.ok === false;
  const submitDisabled =
    paused ||
    getsNothing ||
    (isStake && stakeRequiredLux > publicBalance) ||
    publicBalance <= 0n;
  const submitDisabledReason = paused
    ? `${maintenance === true ? PAUSED_TITLE : UNCHECKED_TITLE}.`
    : getsNothing
    ? "At Sozu's deposit fee now, this stake gets no stDUSK."
    : publicBalance <= 0n
    ? "The network fee is paid from the public balance, and it's empty."
    : isStake && stakeRequiredLux > publicBalance
    ? "That's more than your public balance, with the network fee."
    : "";

  // Back returns to Staking, so Review has no Cancel.
  const goBack = () => {
    state.route = "stake";
    actions?.render?.().catch(() => {});
  };
  const confirmBtn = h("button", {
    class: "btn-primary",
    text: "Confirm",
    disabled: submitDisabled || rechecking.has(draft),
  });

  // The call's own gas at the network's price; Custom fee for gas of your own.
  const gasOpts = { privacy: "public", fnName };
  const ownGas = getDefaultGas(TX_KIND.CONTRACT_CALL, gasOpts);
  const gasEditor = document.createElement("dusk-gas-editor");
  gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;
  gasEditor.amountLux = "0";
  gasEditor.extraLux = [String(draft.deposit ?? "0")];
  gasEditor.setGas(draft?.gas ?? null);
  // The contract the call goes to, Sozu's pool as its hub named it, with the
  // gas under Custom fee: there to check before Confirm, out of the way.
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

  const title = isStake ? "Liquid staking" : "Unstake from Sozu";
  const line = isStake ? "With Sozu, a third party" : "From Sozu, back to your public balance";
  const hidden = balancesHidden(ov);
  const profileName = profileNameEl(ov, { index: Number(draft.profileIndex ?? 0) || 0 });

  // Gas that won't do, or terms that couldn't be checked, say so above Confirm; nothing is sent.
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

  confirmBtn.addEventListener("click", async () => {
    // One check at a time for this stake, whichever Confirm is pressed.
    if (rechecking.has(draft)) return;
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
    // new figures for another Confirm instead of sending.
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
        draft.checkError = "Couldn't check Sozu's terms just now, so nothing was sent. Try again.";
        actions?.render?.().catch(() => {});
        return;
      }
      if (applyStakeTerms({ st, draft, terms })) {
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
    confirmBtn.disabled = submitDisabled;
  });
  submitOnGasEnter(gasEditor, confirmBtn, { ready: () => !submitDisabled && !rechecking.has(draft) });

  const kv = (label, value) =>
    h("div", { class: "kv" }, [h("span", { class: "kv-label", text: label }), h("span", { class: "kv-value" }, [].concat(value))]);

  return [
    subnav({ title: "Review", onBack: goBack }),
    h("div", { class: "row" }, [
      h("div", { class: "review-head" }, [
        h("div", { class: "review-kind", text: title }),
        h("div", { class: "balance-amount", text: `${fmtLux(draftNeeds.toString())} DUSK` }),
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
        quote && quoteRate ? kv("Deposit fee", h("span", {}, depositFeeParts(quoteRate, safeBigInt(quote.fee, 0n), hidden))) : null,
        kv(isStake ? "From" : "To", [h("span", {}, [profileName, h("span", { class: "kv-muted", text: " · Public" })])]),
      ].filter(Boolean)),
      // How an unstake comes back.
      isStake ? null : h("p", { class: "stake-cap", text: SOZU_UNSTAKE_LINE }),
      submitDisabledReason ? h("div", { class: "field-error", role: "alert", text: submitDisabledReason }) : null,
      gasEditor,
      confirmError,
      h("div", { class: "btnrow" }, [confirmBtn]),
    ].filter(Boolean)),
  ];
}
