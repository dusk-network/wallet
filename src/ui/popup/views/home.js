import { formatDusk, formatDuskExact, formatLuxForInput, groupThousands, safeBigInt } from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { h } from "../../lib/dom.js";
import { assetsSectionsView } from "./assets.js";
import { activityView, recentActivitySection } from "./activityView.js";
import { activityRows } from "../activity.js";
import { networkForNode } from "../../../shared/nodeNetwork.js";
import { bracketTitle } from "../../components/BracketTitle.js";
import { actionIcon, iconSvg } from "../../components/ActionIcon.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { keptSendDraft } from "../../lib/sendDraft.js";
import { shortAddress } from "../../lib/strings.js";
import { contactNameText } from "../../lib/contactNames.js";
import { unsentOf, waitingOf } from "../../lib/waiting.js";
import { safeTextEl } from "../../components/SafeText.js";
import { ownProfileName } from "../../components/ProfileName.js";
import { NOT_SENT_TEXT } from "../../../shared/waitingSends.js";
import { whenAtText } from "./txRow.js";
import { UNCLEAR_TEXT, reasonText } from "./sent.js";

// In the wallet's words: what a node says of it is that node's to choose.
const BALANCE_UNREAD = "Couldn't read your balance from this node. Try again in a moment.";
// A balance read before, kept while it can't be read again, as the web wallet says it.
const BALANCE_STALE = "Your balance may be out of date.";
const BALANCE_OFFLINE = "Your balance may be out of date until you're back online.";
const SHIELDED_UNREAD = "Couldn't read your shielded balance from this node. Try again in a moment.";

export function homeView(ov, { state, actions } = {}) {
  const hidden = balancesHidden(ov);
  const hasBalance = Boolean(ov?.balance?.value);
  const pubLux = safeBigInt(ov?.balance?.value, 0n);
  const balFull = hasBalance ? formatDuskExact(pubLux) : "—";
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
  const shieldFull = hasShieldValue ? formatDuskExact(shieldLux) : "—";
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
  // What's staked, natively and with Sozu, read with the public balance: the
  // total counts it, and is the total only once it's read.
  const stakedLux = /^\d+$/.test(String(ov?.staked?.lux ?? "")) ? BigInt(ov.staked.lux) : null;
  const hasTotal = hasBalance && typeof shieldLuxBI === "bigint";
  const totalLux = hasTotal ? pubLux + shieldLuxBI + (stakedLux ?? 0n) : null;
  const totalFull = hasTotal ? formatDuskExact(totalLux) : null;
  const totalDusk = hasTotal ? formatDusk(totalLux) : null;

  // Shielded status suffix shown in Assets breakdown.
  // We only show a suffix when *not* fully healthy, to avoid "Shielded • Shielded".
  let shieldStatus = null;
  let shieldStatusTitle = shieldedError || shieldedSync?.lastError ? SHIELDED_UNREAD : undefined;
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

  // One read before stays, under the balance's own line: it isn't unavailable.
  if (shieldedError && shieldedSync?.state !== "syncing" && !ov?.shieldedStale) {
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
  const heroLabel = !hasTotal ? "Public balance" : stakedLux !== null ? "Total balance" : "Public and shielded";

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

  // "Public 1,484.92 DUSK · Shielded 0 DUSK · Staked 1.79 DUSK" under the total.
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
    // Staked natively and with Sozu, which the total counts.
    stakedLux !== null && stakedLux > 0n
      ? h("div", { class: "balance-split-item" }, [
          h("span", { class: "balance-split-label", text: "Staked" }),
          h("span", { class: "balance-split-value", title: hidden ? undefined : groupThousands(formatDuskExact(stakedLux)) }, [
            balance(hidden, formatDusk(stakedLux)),
            " DUSK",
          ]),
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
      // What was typed before, left with Back: there again.
      state.draft = keptSendDraft(ov);
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
          state.draft = keptSendDraft(ov);
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
    staleNote(ov, hasBalance),
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
    !stakedLux &&
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
      // Payments from Send waiting for the network, and those that weren't sent.
      waitingSection(ov, { state, actions }),
      // Activity first, then the assets, as on a bank app's home.
      recentActivitySection(ov, { state, actions }),
      ...(getStarted ? [getStarted] : assetsSectionsView(ov, { state, actions })),
    ]),
  ];
}

/**
 * What's said under the balances where they may be out of date: offline, as
 * the browser says at once; read before and kept while the node can't give
 * it or doesn't answer, with when it was read where the wallet kept that,
 * as after opening with no signal; or the parts the node couldn't give now,
 * by name; or not read at all.
 * @returns {HTMLElement | null}
 */
function staleNote(ov, hasBalance) {
  const at = Number(ov?.balanceReadAt);
  const read = Number.isFinite(at) && at > 0 ? ` Last read ${whenAtText(at)}.` : "";
  const note = (text) => h("div", { class: "muted balance-stale", role: "status", text });
  if (globalThis.navigator?.onLine === false) return note(`${BALANCE_OFFLINE}${read}`);
  if (ov?.balanceStale || (hasBalance && ov?.networkStatus?.nodeStatus === "offline")) return note(`${BALANCE_STALE}${read}`);
  const parts = [ov?.shieldedStale && "shielded balance", ov?.stakeStale && "stake"].filter(Boolean);
  if (parts.length) return note(`Your ${parts.join(" and ")} couldn't be read just now, so ${parts.length > 1 ? "they" : "it"} may be out of date.`);
  return ov?.balanceError ? h("div", { class: "muted", text: BALANCE_UNREAD }) : null;
}

/**
 * The payments from Send that wait for the network, each with what it pays,
 * to whom, its memo and when it was made, to tell them apart, and Cancel; and
 * those that stopped waiting without going out, said plainly, with Send it
 * now, which takes it to Review again, and Drop. None goes out by itself once
 * it's said not sent.
 * @returns {HTMLElement | null}
 */
function waitingSection(ov, { state, actions } = {}) {
  const waiting = waitingOf(ov);
  const unsent = unsentOf(ov);
  if (!waiting.length && !unsent.length) return null;
  const hidden = balancesHidden(ov);
  const contacts = Array.isArray(state?.addressBook?.items) ? state.addressBook.items : [];
  // To whom: a contact's name, your own profile's, the .dusk name it was sent to, or the address.
  const toText = (send) => {
    const key = String(send.to ?? "").toLowerCase();
    const contact = contactNameText(contacts.find((c) => String(c?.address ?? "").toLowerCase() === key)?.name);
    const own = ownProfileName(ov, send.to);
    return contact || (own ? `your ${own}` : "") || String(send.toName ?? "") || shortAddress(String(send.to ?? ""));
  };
  // "0.01 DUSK to Lucas", its amount hidden with the balances.
  const what = (send) => [balance(hidden, formatDuskExact(send.lux)), ` DUSK to ${toText(send)}`];
  // Its memo and when it was made: "“Hors ligne un” · made at 02:34".
  const madeLine = (send) =>
    h("div", { class: "muted home-waiting__made" }, [
      ...(String(send.memo ?? "").trim() ? ["“", safeTextEl(send.memo), "” · "] : []),
      `made ${whenAtText(Number(send.at) || Date.now())}`,
    ]);
  const refresh = () => {
    state.needsRefresh = true;
    actions?.render?.({ forceRefresh: true })?.catch?.(() => {});
  };
  const said = (send) => `${hidden ? "••••" : formatDuskExact(send.lux)} DUSK to ${toText(send)}`;
  const button = (text, onclick, className = "btn-outline") =>
    h("button", {
      class: `${className} home-waiting__btn`,
      type: "button",
      text,
      onclick: async (event) => {
        if (event?.currentTarget) event.currentTarget.disabled = true;
        await onclick();
      },
    });

  // One handed over without a clear answer may have gone out: it's looked up,
  // and has no Cancel.
  const waitingNote = (send) =>
    send.unclear && send.checks
      ? "It may have gone out already. The wallet checks once the network answers."
      : send.unclear && send.waits
        ? UNCLEAR_TEXT
        : send.waits
          ? "It goes out once the network answers."
          : "It's being sent.";
  const waitingBox = (send) =>
    h("div", { class: "callout home-waiting", role: "status" }, [
      h("div", { class: "callout-title" }, [send.unclear ? "Not confirmed: " : "Not sent yet: ", ...what(send)]),
      madeLine(send),
      h("p", { class: "muted home-waiting__note", text: waitingNote(send) }),
      send.unclear ? null : h("div", { class: "home-waiting__actions" }, [
        button("Cancel", async () => {
          const res = await Promise.resolve(actions?.send?.({ type: "DUSK_UI_CANCEL_SEND", sendId: send.sendId })).catch(() => null);
          actions?.showToast?.(
            res?.result?.cancelled
              ? { text: `Not sent: ${said(send)}. Nothing was sent and no fee was charged.`, tone: "ok" }
              : res?.error
                ? "Couldn't cancel it. Try again."
                : "It went out already, so it can't be cancelled."
          );
          refresh();
        }),
      ]),
    ].filter(Boolean));

  const unsentBox = (send) =>
    h("div", { class: "callout warn home-waiting home-waiting--unsent", role: "status" }, [
      h("div", { class: "callout-title" }, ["Not sent: ", ...what(send)]),
      madeLine(send),
      h("p", {
        class: "muted home-waiting__note",
        text: NOT_SENT_TEXT[send.ended] ?? [reasonText(send.error), "Nothing was sent and no fee was charged."].filter(Boolean).join(" "),
      }),
      h("div", { class: "home-waiting__actions" }, [
        // To Review again, through Send, with what it paid filled in.
        button(
          "Send it now",
          async () => {
            await Promise.resolve(actions?.send?.({ type: "DUSK_UI_DROP_UNSENT", sendId: send.sendId })).catch(() => {});
            state.route = "send";
            state.draft = { to: String(send.to ?? ""), amountDusk: formatLuxForInput(safeBigInt(send.lux, 0n)), amountMasked: hidden, memo: String(send.memo ?? "") };
            actions?.render?.()?.catch?.(() => {});
          },
          "btn-primary"
        ),
        button("Drop", async () => {
          await Promise.resolve(actions?.send?.({ type: "DUSK_UI_DROP_UNSENT", sendId: send.sendId })).catch(() => {});
          refresh();
        }),
      ]),
    ]);

  return h("div", { class: "home-waiting-list" }, [...waiting.map(waitingBox), ...unsent.map(unsentBox)]);
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
