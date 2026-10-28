import { formatDusk, formatLuxToDusk, groupThousands, safeBigInt } from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { h } from "../../lib/dom.js";
import { assetsSectionsView } from "./assets.js";
import { activityView, recentActivitySection } from "./activityView.js";
import { activityRows } from "../activity.js";
import { networkForNode } from "../../../shared/nodeNetwork.js";
import { bracketTitle } from "../../components/BracketTitle.js";
import { actionIcon, iconSvg } from "../../components/ActionIcon.js";
import { balance, balancesHidden } from "../../components/Balance.js";

export function homeView(ov, { state, actions } = {}) {
  const hidden = balancesHidden(ov);
  const hasBalance = Boolean(ov?.balance?.value);
  const pubLux = safeBigInt(ov?.balance?.value, 0n);
  const balFull = hasBalance ? formatLuxToDusk(pubLux) : "—";
  const balDusk = hasBalance ? formatDusk(pubLux) : "—";

  // Shielded balance
  // If we can't compute it yet (sync in progress), we still show the row
  // and surface progress in the subtitle.
  const shieldedSync = ov?.shieldedSync || null;
  const shieldedError = ov?.shieldedError ? String(ov.shieldedError) : "";
  const shieldLux = ov?.shieldedBalance?.value ?? ov?.shieldedBalance;
  const hasShieldValue = shieldLux !== undefined && shieldLux !== null;
  // Always show the shielded row for Dusk. If values aren't available yet,
  // we show placeholders + sync state.
  const showShielded = true;
  const shieldFull = hasShieldValue ? formatLuxToDusk(shieldLux) : "—";
  const shieldDusk = hasShieldValue ? formatDusk(shieldLux) : "—";

  // Total (public + shielded) is only meaningful once shielded value is known.
  const shieldLuxBI = hasShieldValue ? safeBigInt(shieldLux, 0n) : null;

  // When a shielded tx is pending we reserve notes locally to prevent
  // double-spends. That can make the *available* shielded balance drop to 0
  // until the change note is discovered. We keep the hero/asset amount based
  // on the total (value), and show a small "Pending" hint when applicable.
  const shieldSpendLux = ov?.shieldedBalance?.spendable;
  const hasShieldSpendable = shieldSpendLux !== undefined && shieldSpendLux !== null;
  const shieldSpendBI = hasShieldSpendable ? safeBigInt(shieldSpendLux, 0n) : null;
  const reservedLux =
    typeof shieldLuxBI === "bigint" && typeof shieldSpendBI === "bigint"
      ? shieldLuxBI > shieldSpendBI
        ? shieldLuxBI - shieldSpendBI
        : 0n
      : 0n;
  const hasTotal = hasBalance && typeof shieldLuxBI === "bigint";
  const totalLux = hasTotal ? pubLux + shieldLuxBI : null;
  const totalFull = hasTotal ? formatLuxToDusk(totalLux) : null;
  const totalDusk = hasTotal ? formatDusk(totalLux) : null;

  // Shielded status suffix shown in Assets breakdown.
  // We only show a suffix when *not* fully healthy, to avoid "Shielded • Shielded".
  let shieldStatus = null;
  let shieldStatusTitle = shieldedError || shieldedSync?.lastError || undefined;
  if (shieldedSync?.state === "idle") {
    const n = Number(shieldedSync?.notes ?? 0);
    if (n <= 0) shieldStatus = "Not synced";
  } else if (shieldedSync?.state === "syncing") {
    const p = Number(shieldedSync.progress ?? 0);
    const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
    // Avoid the UX trap where we show a hard "0%" for a long time.
    // If progress is >0 but rounds to 0, display "<1%" instead.
    shieldStatus = pct === 0 && p > 0 ? "Syncing <1%" : `Syncing ${pct}%`;
  } else if (shieldedSync?.state === "error") {
    shieldStatus = "Sync failed";
  }

  if (shieldedError && shieldedSync?.state !== "syncing") {
    shieldStatus = "Unavailable";
  }

  // If everything is synced and error-free but we have locally reserved notes,
  // show a small hint.
  if (!shieldStatus && reservedLux > 0n) {
    shieldStatus = "Pending";
    shieldStatusTitle = hidden ? undefined : `Reserved ${formatDusk(reservedLux)} DUSK`;
  }

  // Home hero shows the total once shielded is available.
  const heroAmt = hasTotal ? totalDusk : balDusk;
  const heroAmtTitle = hasTotal ? totalFull : balFull;
  const heroLabel = hasTotal ? "Total balance" : "Public balance";

  // Refresh, moved here from the header, sits with the balance it reloads.
  const refreshBtn = h("button", {
    class: "balance-refresh",
    type: "button",
    html: iconSvg("refresh"),
    title: "Refresh",
    "aria-label": "Refresh",
    onclick: () => actions?.refresh?.()?.catch?.(() => {}),
  });
  // Hide balances: every balance shows as •••• until it's pressed again. It's
  // named for what pressing it does: Show balances while they're hidden.
  const eyeLabel = hidden ? "Show balances" : "Hide balances";
  const eyeBtn = h("button", {
    class: "balance-eye",
    type: "button",
    html: iconSvg(hidden ? "eye-off" : "eye"),
    title: eyeLabel,
    "aria-label": eyeLabel,
    onclick: async () => {
      // At once and for the rest of this popup, then saved for the next one.
      state.hideBalances = !hidden;
      if (state.overview) state.overview.hideBalances = !hidden;
      // The page redraws, the eye with it: the focus stays on the eye.
      actions
        ?.render?.()
        ?.then?.(() => document.querySelector("button.balance-eye")?.focus?.())
        ?.catch?.(() => {});
      try {
        const res = await actions?.send?.({ type: "DUSK_UI_SET_HIDE_BALANCES", hideBalances: !hidden });
        if (res?.error) throw new Error(res.error.message);
      } catch (e) {
        actions?.showToast?.(e?.message || "Couldn't save Hide balances.", 2500);
      }
    },
  });
  // "Total balance", then the eye and Refresh.
  const balanceLabel = h("div", { class: "balance-label" }, [
    h("span", { class: "balance-label__text", text: heroLabel }),
    eyeBtn,
    refreshBtn,
  ]);

  // "Public 1,484.92 DUSK · Shielded 0 DUSK" under the total.
  const unit = (amount) => (amount === "—" ? null : " DUSK");
  const balanceSplit = h("div", { class: "balance-split" }, [
    h("div", { class: "balance-split-item" }, [
      h("span", { class: "balance-split-label", text: "Public" }),
      h("span", { class: "balance-split-value", title: hidden ? undefined : groupThousands(balFull) }, [
        balance(hidden, balDusk),
        unit(balDusk),
      ].filter(Boolean)),
    ]),
    showShielded
      ? h("div", { class: "balance-split-item" }, [
          h("span", {
            class: "balance-split-label",
            text: shieldStatus ? `Shielded · ${shieldStatus}` : "Shielded",
            title: shieldStatusTitle,
          }),
          h("span", { class: "balance-split-value", title: hidden ? undefined : groupThousands(shieldFull) }, [
            balance(hidden, shieldDusk),
            unit(shieldDusk),
          ].filter(Boolean)),
        ])
      : null,
  ].filter(Boolean));

  const actionBtn = (label, icon, onClick) =>
    h(
      "button",
      {
        class: "action-btn",
        onclick: onClick,
      },
      [
        actionIcon(icon),
        h("div", { class: "action-btn-label", text: label }),
      ]
    );

  const actionBar = h("div", { class: "action-bar" }, [
    actionBtn("Send", "send", () => {
      state.route = "send";
      state.draft = null;
      actions?.render?.().catch(() => {});
    }),
    actionBtn("Receive", "receive", () => {
      state.route = "receive";
      actions?.render?.().catch(() => {});
    }),
    actionBtn("Shield", "shield", () => {
      state.route = "convert";
      state.draft = { kind: TX_KIND.SHIELD, amountDusk: "", amountLux: "" };
      actions?.render?.().catch(() => {});
    }),
    actionBtn("Stake", "stake", () => {
      state.route = "stake";
      // Staking opens on its overview.
      if (state.staking) state.staking.screen = "overview";
      actions?.render?.().catch(() => {});
    }),
  ]);

  const dashboardTopbar = h("div", { class: "dashboard-topbar" }, [
    bracketTitle({ class: "dashboard-title", text: "Dashboard" }),
    h("div", { class: "dashboard-top-actions" }, [
      h("button", {
        class: "btn-outline dashboard-top-action",
        text: "Receive",
        onclick: () => {
          state.route = "receive";
          actions?.render?.().catch(() => {});
        },
      }),
      h("button", {
        class: "btn-primary dashboard-top-action",
        text: "Send",
        onclick: () => {
          state.route = "send";
          state.draft = null;
          actions?.render?.().catch(() => {});
        },
      }),
    ]),
  ]);

  // The balance sits on the page, the amount large with a muted unit; the
  // round actions follow it.
  const heroText = heroAmt;
  const hero = h("div", { class: "home-balance home-hero" }, [
    balanceLabel,
    h(
      "div",
      {
        class: !hidden && heroText.length > 11 ? "balance-amount is-long" : "balance-amount",
        title: hidden ? undefined : groupThousands(heroAmtTitle),
      },
      [balance(hidden, heroText), heroAmt === "—" ? null : h("span", { class: "balance-unit", text: " DUSK" })].filter(Boolean)
    ),
    balanceSplit,
    ov?.balanceError
      ? h("div", { class: "muted", text: `Balance error: ${ov.balanceError}` })
      : null,
  ].filter(Boolean));

  // Activity: the newest rows, the full list behind See all.
  if (state?.route === "activity") return activityView(ov, { state, actions });

  // A wallet with nothing in it yet: how to get DUSK, in place of empty
  // Tokens and NFTs. Both balances must be known: shielded DUSK still
  // syncing isn't nothing.
  const assets = state?.assets;
  const empty =
    hasBalance &&
    pubLux === 0n &&
    shieldLuxBI === 0n &&
    shieldedSync?.state !== "syncing" &&
    !activityRows(ov, state).length &&
    !(assets?.tokens?.length || assets?.nfts?.length);
  const getStarted = empty ? getStartedSection(ov, { state, actions }) : null;

  // Full mode should feel like an app dashboard, while popup remains a compact
  // single-column wallet. CSS handles the responsive collapse.
  return [
    h("div", { class: "wallet-dashboard" }, [
      h("h1", { class: "sr-only", text: "Dusk Wallet" }),
      dashboardTopbar,
      hero,
      h("div", { class: "dashboard-actions" }, [
        bracketTitle({ class: "dashboard-section-label", text: "Actions" }),
        actionBar,
      ]),
      // Activity first, then the assets, as on a bank app's home.
      recentActivitySection(ov, { state, actions }),
      ...(getStarted ? [getStarted] : assetsSectionsView(ov, { state, actions })),
    ]),
  ];
}

/**
 * How to get DUSK, for a wallet with nothing in it yet: Receive, and where
 * DUSK comes from.
 * @returns {HTMLElement}
 */
function getStartedSection(ov, { state, actions } = {}) {
  const testnet = networkForNode(String(ov?.nodeUrl ?? ""))?.name === "testnet";
  return h("section", { class: "box home-get-started" }, [
    bracketTitle({ text: "Get your first DUSK" }),
    h("div", { class: "group get-started-card" }, [
      h("p", {
        text: testnet
          ? "Ask someone to send you test DUSK. They need your account, from Receive."
          : "Withdraw DUSK from an exchange, or ask someone to send you some. Both start with your account, from Receive.",
      }),
      h("button", {
        class: "btn-primary",
        type: "button",
        text: "Receive",
        onclick: () => {
          state.route = "receive";
          actions?.render?.()?.catch?.(() => {});
        },
      }),
    ]),
  ]);
}
