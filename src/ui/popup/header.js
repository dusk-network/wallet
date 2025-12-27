import { h, setChildren } from "../lib/dom.js";
import { accountChipEl } from "../components/AccountChip.js";
import { isFullView, isPopupView } from "./env.js";
import { isExtensionRuntime } from "../../platform/runtime.js";
import { platform } from "../../platform/index.js";

export function createHeaderRenderer({
  headerActionsHost,
  netMenu,
  onRefresh,
  onOpenOptions,
  onExpand,
  showToast,
} = {}) {
  return function renderHeader(ov) {
    const hasVault = Boolean(ov?.hasVault);
    const isUnlocked = Boolean(ov?.isUnlocked);
    // Only show/enable wallet actions when we actually have a wallet loaded.
    // In setup/locked states, switching networks and refreshing balances is
    // either meaningless or confusing.
    const walletReady = hasVault && isUnlocked;

    // Update network pill label in header
    const networkPill = document.getElementById("network-pill");
    const networkLabel = networkPill?.querySelector(".network-pill__label");
    if (networkLabel) {
      networkLabel.textContent = ov?.networkName ?? "Network";
    }
    if (networkPill) {
      // Disable the pill (and close any open menu) until the wallet is unlocked.
      networkPill.disabled = !walletReady;
      networkPill.classList.toggle("is-disabled", !walletReady);
      if (!walletReady && netMenu?.isOpen) netMenu.close();

      networkPill.onclick = walletReady
        ? () => {
            if (netMenu?.isOpen) netMenu.close();
            else netMenu?.open(networkPill, ov);
          }
        : null;
    }

    const refreshBtn = h("button", {
      class: "icon-btn icon-only",
      text: "⟳",
      title: "Refresh",
      onclick: onRefresh,
    });

    const optionsBtn = h("button", {
      class: "icon-btn icon-only",
      text: "⚙",
      title: "Options",
      onclick: onOpenOptions,
    });

    const canExpand = !isFullView && isExtensionRuntime() && isPopupView;
    const expandBtn = !canExpand
      ? null
      : h("button", {
          class: "icon-btn icon-only",
          text: "⤢",
          title: "Expand view",
          onclick: onExpand,
        });

    const actions = [];

    const account = ov?.accounts?.[0];
    if (ov?.isUnlocked && typeof account === "string" && account.length) {
      let host = null;
      let connected = false;
      if (platform.capabilities.dapp) {
        const origin = ov?.activeOrigin;
        connected = Boolean(origin && ov?.activeConnected);
        if (origin) {
          try {
            host = new URL(origin).hostname;
          } catch {
            host = String(origin);
          }
        }
      }

      actions.push(accountChipEl(account, { onCopy: showToast, connected, host }));
    }

    if (expandBtn) actions.push(expandBtn);
    // Refresh is shown in full/app modes, but only when the wallet is unlocked.
    if (isFullView && walletReady) actions.push(refreshBtn);
    actions.push(optionsBtn);

    setChildren(headerActionsHost, actions);
  };
}
