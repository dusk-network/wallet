import { clampDecimals, formatLuxToDusk } from "../../../shared/amount.js";
import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { truncateMiddle } from "../../lib/strings.js";
import { bannerView } from "../../components/Banner.js";
import { connectionPill } from "../../components/ConnectionPill.js";
import { identiconEl } from "../../components/Identicon.js";

export function homeView(ov, { state, actions } = {}) {
  const account = ov?.accounts?.[0] ?? "";
  const hasBalance = Boolean(ov?.balance?.value);
  const balFull = hasBalance ? formatLuxToDusk(ov.balance.value) : "—";
  const balDusk = hasBalance ? clampDecimals(balFull, 4) : "—";

  const accountCard = h("div", { class: "account-card" }, [
    h("div", { class: "account-line" }, [
      h("div", { class: "account-left" }, [
        identiconEl(account || "dusk"),
        h("div", { class: "account-meta" }, [
          h("div", { class: "muted", text: "Account" }),
          h("code", { text: truncateMiddle(account, 12, 10) || "(none)" }),
        ]),
      ]),
      h("button", {
        class: "icon-btn icon-only",
        text: "⧉",
        title: "Copy account",
        onclick: async () => {
          if (!account) return;
          const ok = await copyToClipboard(account);
          actions?.showToast?.(ok ? "Copied account" : "Copy failed");
        },
      }),
    ]),

    h("div", { class: "account-foot" }, [connectionPill(ov)]),
  ]);

  const balanceBox = h("div", { class: "home-balance" }, [
    h("div", { class: "balance-amount", text: balDusk, title: balFull }),
    h("div", { class: "balance-sub", text: "DUSK (public)" }),
    ov?.balanceError
      ? h("div", { class: "muted", text: `Balance error: ${ov.balanceError}` })
      : h("div"),
  ]);

  const actionsRow = h("div", { class: "actions" }, [
    h(
      "button",
      {
        class: "action-card",
        onclick: () => {
          state.route = "send";
          state.banner = null;
          state.draft = null;
          actions?.render?.().catch(() => {});
        },
      },
      [
        h("div", { class: "action-icon", text: "↗" }),
        h("div", { class: "action-title", text: "Send" }),
      ]
    ),
    h(
      "button",
      {
        class: "action-card",
        onclick: () => {
          state.route = "receive";
          state.banner = null;
          actions?.render?.().catch(() => {});
        },
      },
      [
        h("div", { class: "action-icon", text: "⤓" }),
        h("div", { class: "action-title", text: "Receive" }),
      ]
    ),
  ]);

  const footerBtns = h("div", { class: "btnrow" }, [
    h("button", {
      class: "btn-outline",
      text: "Lock",
      onclick: async () => {
        await actions?.send?.({ type: "DUSK_UI_LOCK" });
        state.route = "home";
        state.banner = null;
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      },
    }),
  ]);

  return [bannerView(state.banner), accountCard, balanceBox, actionsRow, footerBtns].filter(Boolean);
}
