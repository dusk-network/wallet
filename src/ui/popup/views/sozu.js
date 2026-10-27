import {
  UI_DISPLAY_DECIMALS,
  formatDusk,
  formatFee,
  formatLuxShort,
  formatLuxToDusk,
  groupThousands,
  maxAmountLux,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import {
  buildSozuDepositTx,
  buildSozuWithdrawTx,
  makeSozuStDuskToken,
  parseSozuPoolState,
  parseSozuPosition,
} from "../../../shared/sozuAdapter.js";
import { getSozuConfig } from "../../../shared/sozuConfig.js";
import { getDefaultGas, getMinimumGas } from "../../../shared/txDefaults.js";
import { openUrl } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { shortAddress } from "../../lib/strings.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { amountField } from "../../components/AmountField.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { submitOnGasEnter } from "../../components/FormControls.js";
import { gasFeeLux, startingGas, useNetworkGas } from "../../components/NetworkGas.js";
import { profileNameEl } from "../../components/ProfileName.js";
import { sendFromReview } from "./sent.js";

function networkKey(ov) {
  const name = String(ov?.networkName ?? "").trim().toLowerCase();
  if (name === "mainnet") return "mainnet";
  if (name === "testnet") return "testnet";
  return name || "custom";
}

function fmtLux(value) {
  return formatDusk(value ?? "0", UI_DISPLAY_DECIMALS);
}

// Sozu's site, for its own rules.
const SOZU_URL = "https://sozu.fi/";

/**
 * What a public staking transaction shows everyone, for its Review.
 * @param {string} what - e.g. "the amount staked, your rewards"
 * @param {string} [name] - the profile's verified .dusk name
 */
export function publicStakeLine(what, name) {
  return `Visible to everyone: ${what} and ${name ? `your name ${name}` : "your account"}.`;
}

// Why a call to Sozu's contract may cost more than a transfer.
const CONTRACT_FEE_NOTE = "Contract calls need more gas. You pay only what's used.";

/**
 * About how much stDUSK a deposit of `amountLux` gets: the pool mints
 * amount × supply / stake (before any fee Sozu takes), worth the amount at
 * the pool's rate (its total stake over the stDUSK supply).
 * @returns {string} e.g. "32.57", or "" without a pool rate
 */
export function stDuskEstimate(amountLux, pool) {
  const stake = safeBigInt(pool?.totalStakeLux ?? 0, 0n);
  const supply = safeBigInt(pool?.tokenTotalSupply ?? 0, 0n);
  const amount = safeBigInt(amountLux ?? 0, 0n);
  if (amount <= 0n || stake <= 0n || supply <= 0n) return "";
  return groupThousands(formatLuxShort(((amount * supply) / stake).toString(), 2));
}

function sozuState(state) {
  return (state.sozu ??= {
    action: "deposit",
    depositAmountDusk: "",
    withdrawAmountDusk: "",
    loaded: false,
    loading: false,
    error: null,
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

// The fee Review starts from (startingGas), custom gas from Settings and a
// draft's own gas included, so Max and the balance checks match it.
function contractCallFeeLux(customGas = null, gas = null) {
  return gasFeeLux(
    startingGas({
      defaultGas: getDefaultGas(TX_KIND.CONTRACT_CALL, { privacy: "public" }),
      minLimit: getMinimumGas(TX_KIND.CONTRACT_CALL, { privacy: "public" })?.limit,
      customGas,
      gas,
    })
  );
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

/**
 * Liquid staking through Sozu, a third party: what Sozu holds for the
 * profile, then the amount to stake or unstake, checked as it is typed.
 * @param {object} ov
 * @param {{ state: object, actions: object, onBack?: Function }} ctx
 */
export function sozuLiquidStakingView(ov, { state, actions, onBack } = {}) {
  const st = ensureSozuLoaded(ov, { state, actions });
  const staticCfg = getSozuConfig(networkKey(ov));
  const liveStatus = st.status;
  const cfg = liveStatus?.configured && liveStatus?.contracts?.pool
    ? { networkKey: liveStatus.networkKey, contracts: liveStatus.contracts }
    : staticCfg;
  const pool = st.pool ? parseSozuPoolState(st.pool) : null;
  const position = st.position ? parseSozuPosition(st.position) : null;
  const hidden = balancesHidden(ov);
  const publicBalanceLux = safeBigInt(liveStatus?.publicBalance?.value ?? 0, 0n);
  const poolBalanceLux = safeBigInt(position?.poolBalanceLux ?? 0, 0n);
  const stDuskLux = safeBigInt(position?.stDuskBalanceLux ?? 0, 0n);
  const publicFeeLux = contractCallFeeLux(ov?.customGas);
  // Max keeps this fee, and the one to unstake later.
  const maxStakeLux = maxAmountLux(publicBalanceLux, 2n * publicFeeLux);
  const maxUnstakeLux = poolBalanceLux > 0n ? poolBalanceLux : 0n;
  const disabledReason = cfg
    ? ""
    : liveStatus?.reason || "Sozu liquid staking is not configured for this network.";
  const isWithdraw = st.action === "withdraw";
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
    disabled: !cfg,
    onInput: () => check(),
    onEnter: () => review(),
  });

  const estimate = h("div", { class: "stake-estimate", hidden: true });
  const reviewBtn = h("button", {
    class: "btn-primary",
    type: "button",
    text: isWithdraw ? "Review unstake" : "Review stake",
    disabled: true,
    onclick: () => review(),
  });

  // The amount, checked as it is typed: the error under the field, Review
  // only when it can go ahead, and for a stake, about what it gets.
  function check() {
    const raw = String(field.input.value ?? "").trim();
    if (isWithdraw) st.withdrawAmountDusk = raw;
    else st.depositAmountDusk = raw;
    estimate.hidden = true;
    if (!cfg) {
      field.setError(disabledReason);
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
    if (isWithdraw && lux > maxUnstakeLux) {
      field.setError("That's more than you have staked with Sozu.");
      reviewBtn.disabled = true;
      return null;
    }
    if (!isWithdraw && lux > maxStakeLux) {
      field.setError("That's more than your public balance, with the network fee.");
      reviewBtn.disabled = true;
      return null;
    }
    field.setError("");
    reviewBtn.disabled = false;
    // What it gets, then what stDUSK is: worth what was staked, now.
    const got = isWithdraw ? "" : stDuskEstimate(lux, pool);
    if (got) {
      estimate.replaceChildren(
        h("div", { class: "stake-estimate__main", text: `You get about ${got} stDUSK, worth ${formatDusk(lux.toString())} DUSK now.` }),
        h("div", { text: "stDUSK is Sozu's token for your share; its DUSK value grows as rewards come in." })
      );
      estimate.hidden = false;
    }
    return lux;
  }

  function review() {
    const amountLux = check();
    if (amountLux == null) {
      field.input.focus();
      return;
    }
    state.sozuDraft = {
      ...(isWithdraw
        ? buildSozuWithdrawTx({ config: cfg, amountLux })
        : buildSozuDepositTx({ config: cfg, amountLux })),
      profileIndex: Number(ov?.selectedAccountIndex ?? 0) || 0,
      fnArgsAmountLux: amountLux.toString(),
      stDuskEstimate: isWithdraw ? "" : stDuskEstimate(amountLux, pool),
      label: isWithdraw ? "Unstake from Sozu" : "Liquid staking",
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
    disabled: !cfg || maxActionLux <= 0n,
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

  const poolContract = cfg?.contracts?.pool ? String(cfg.contracts.pool) : "";
  const copyContract = poolContract
    ? h("button", {
        class: "mini-btn",
        type: "button",
        text: "Copy",
        "aria-label": "Copy Sozu's contract ID",
        onclick: async () => {
          const ok = await copyToClipboard(poolContract);
          actions?.showToast?.(ok ? "Contract ID copied" : "Couldn't copy the contract ID");
        },
      })
    : null;

  const sozuLink = h("button", {
    class: "text-btn text-btn--inline chain-link",
    type: "button",
    text: "sozu.fi",
    onclick: async () => {
      const ok = await openUrl(SOZU_URL);
      if (!ok) actions?.showToast?.("Couldn't open sozu.fi");
    },
  });

  const facts = h("div", { class: "group info" }, [
    h("div", { class: "list-row" }, [
      h("span", { class: "row-icon", html: iconSvg("drop") }),
      h("span", { class: "row-main" }, [
        h("span", { class: "row-title", text: "Any amount, no node needed" }),
        h("span", { class: "row-sub", text: "You get stDUSK, a token for your share of Sozu's pool." }),
      ]),
      positionGroup ? null : stDuskAction,
    ].filter(Boolean)),
    h("div", { class: "list-row" }, [
      h("span", { class: "row-icon", html: iconSvg("fee") }),
      h("span", { class: "row-main" }, [
        h("span", { class: "row-title", text: `Network fee up to ${formatFee(publicFeeLux, { max: true })} DUSK` }),
        h("span", { class: "row-sub", text: CONTRACT_FEE_NOTE }),
      ]),
    ]),
    poolContract
      ? h("div", { class: "list-row" }, [
          h("span", { class: "row-icon", html: iconSvg("server") }),
          h("span", { class: "row-main" }, [
            h("span", { class: "row-title", text: "Sozu's contract" }),
            h("span", { class: "row-sub" }, [h("span", { class: "mono", title: poolContract, text: shortAddress(poolContract) })]),
          ]),
          copyContract,
        ].filter(Boolean))
      : null,
  ].filter(Boolean));

  // Brought back from Review, the amount says how it stands at once.
  if ((isWithdraw ? st.withdrawAmountDusk : st.depositAmountDusk) || !cfg) check();

  return [
    subnav({ title: "Liquid staking", onBack: back }),
    h("div", { class: "liquid-intro" }, [
      h("div", { class: "liquid-who" }, ["Sozu", h("span", { class: "tag", text: "third party" })]),
      h("p", {}, ["Sozu, not Dusk, holds the DUSK you stake here and returns it under Sozu's own rules: ", sozuLink, "."]),
    ]),
    st.loading && !st.loaded ? h("div", { class: "muted", text: "Loading Sozu…" }) : null,
    st.error ? h("div", { class: "err", text: st.error }) : null,
    cfg && liveStatus?.reason ? h("div", { class: "muted", text: liveStatus.reason }) : null,
    positionGroup,
    assetError,
    actionTabs,
    h("div", { class: "amount-entry" }, [field.el, field.error, available, estimate]),
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
  const liveStatus = st.status;
  const publicBalance = safeBigInt(liveStatus?.publicBalance?.value ?? 0, 0n);
  const draftNeeds = draftAmountLux(draft);
  const draftFeeLux = contractCallFeeLux(ov?.customGas, draft?.gas);
  const isStake = draft.fnName === "sozu_stake";
  const stakeRequiredLux = isStake ? draftNeeds + draftFeeLux : draftFeeLux;
  const submitDisabled =
    st.submitting ||
    (isStake && stakeRequiredLux > publicBalance) ||
    publicBalance <= 0n;
  const submitDisabledReason = publicBalance <= 0n
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
    disabled: submitDisabled,
  });

  const defaultGas = getDefaultGas(TX_KIND.CONTRACT_CALL, { privacy: draft.privacy || "public" });
  const defaultLimit =
    defaultGas?.limit !== undefined && defaultGas?.limit !== null ? String(defaultGas.limit) : "";
  const fallbackPrice =
    defaultGas?.price !== undefined && defaultGas?.price !== null ? String(defaultGas.price) : "";
  const gasEditor = document.createElement("dusk-gas-editor");
  gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;
  gasEditor.amountLux = "0";
  gasEditor.extraLux = [String(draft.deposit ?? "0")];
  gasEditor.setGas(draft?.gas ?? null);
  // The network's gas price by default; Custom fee for gas of your own.
  useNetworkGas({
    customGas: ov?.customGas,
    actions,
    gas: draft?.gas,
    defaultLimit,
    fallbackPrice,
    gasEditor,
    minLimit: getMinimumGas(TX_KIND.CONTRACT_CALL, { privacy: draft.privacy || "public" })?.limit,
  });

  const title = isStake ? "Liquid staking" : "Unstake from Sozu";
  const line = isStake ? "With Sozu, a third party" : "From Sozu, back to your public balance";
  // A call to Sozu is public: the explorer shows it under the profile's name.
  const publicWhat = isStake ? "the amount you stake with Sozu" : "the amount you unstake";
  const visibleLine = h("div", { class: "review-line review-visible", text: publicStakeLine(publicWhat) });
  const profileName = profileNameEl(ov, {
    index: Number(draft.profileIndex ?? 0) || 0,
    onName: (name) => {
      visibleLine.textContent = publicStakeLine(publicWhat, name);
    },
  });

  // Gas that won't do says so above Confirm; nothing is sent.
  const confirmError = h("div", { class: "field-error", role: "alert", hidden: true });

  confirmBtn.addEventListener("click", async () => {
    let gas;
    try {
      gas = gasEditor.readFinalGas();
    } catch (e) {
      confirmError.textContent = e?.message ?? String(e);
      confirmError.hidden = false;
      return;
    }
    confirmError.hidden = true;
    confirmBtn.disabled = true;
    draft.gas = gas;
    const { stDuskEstimate: _estimate, label: _label, ...txDraft } = draft;
    const params = { ...txDraft, gas: gas || undefined };
    const capGas = gas ?? defaultGas;
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
        feeCapLux: (safeBigInt(capGas?.limit, 0n) * safeBigInt(capGas?.price, 0n)).toString(),
      },
      backRoute: "sozu_confirm",
      doneRoute: "stake",
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
  submitOnGasEnter(gasEditor, confirmBtn, { ready: () => !submitDisabled });

  const kv = (label, value) =>
    h("div", { class: "kv" }, [h("span", { class: "kv-label", text: label }), h("span", { class: "kv-value" }, [].concat(value))]);

  return [
    subnav({ title: "Review", onBack: goBack }),
    h("div", { class: "row" }, [
      h("div", { class: "review-head" }, [
        h("div", { class: "review-kind", text: title }),
        h("div", { class: "balance-amount", text: `${fmtLux(draftNeeds.toString())} DUSK` }),
        h("div", { class: "review-line", text: line }),
        visibleLine,
      ]),
      h("div", { class: "group" }, [
        isStake && draft.stDuskEstimate
          ? kv("You get about", `${draft.stDuskEstimate} stDUSK, worth ${fmtLux(draftNeeds.toString())} DUSK now`)
          : null,
        kv(isStake ? "From" : "To", [h("span", {}, [profileName, h("span", { class: "kv-muted", text: " · Public" })])]),
      ].filter(Boolean)),
      // Who holds the DUSK, and on whose terms it comes back.
      h("p", {
        class: "stake-cap",
        text: isStake
          ? "Sozu, not Dusk, holds this DUSK and returns it under Sozu's own rules."
          : "Sozu returns the DUSK under Sozu's own rules.",
      }),
      submitDisabledReason ? h("div", { class: "field-error", role: "alert", text: submitDisabledReason }) : null,
      gasEditor,
      h("p", { class: "stake-cap review-fee-note", text: CONTRACT_FEE_NOTE }),
      confirmError,
      h("div", { class: "btnrow" }, [confirmBtn]),
    ].filter(Boolean)),
  ];
}
