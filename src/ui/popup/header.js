import { h, setChildren } from "../lib/dom.js";
import { siteName } from "../lib/strings.js";
import { iconSvg } from "../components/ActionIcon.js";
import { accountChipEl } from "../components/AccountChip.js";
import { isFullView, isPopupView } from "./env.js";
import { isExtensionRuntime } from "../../platform/runtime.js";
import { platform } from "../../platform/index.js";
import { lookupPrimaryName } from "../../shared/duskNames.js";
import { profileLabelOf, walletNameOf } from "../components/ProfileName.js";
import { syncTestnetStrip } from "../components/TestnetStrip.js";

/**
 * Get a CSS class for network status indicator.
 * @param {"online"|"offline"|"checking"|"unknown"} status
 * @returns {string}
 */
function networkStatusClass(status) {
  switch (status) {
    case "online":
      return "net-status--online";
    case "offline":
      return "net-status--offline";
    case "checking":
      return "net-status--checking";
    default:
      return "net-status--unknown";
  }
}

export function createHeaderRenderer({
  headerActionsHost,
  netMenu,
  acctMenu,
  onOpenOptions,
  onExpand,
} = {}) {
  // The account chip opens the profile switcher. Renders while the switcher
  // is open keep the chip it hangs from, so a click on the chip still closes it.
  let chip = null;
  let chipFor = "";
  let latest = null;
  let refocusChip = false;

  return function renderHeader(ov) {
    latest = ov;
    const hasVault = Boolean(ov?.hasVault);
    const isUnlocked = Boolean(ov?.isUnlocked);
    // Only show/enable wallet actions when we actually have a wallet loaded.
    // In setup/locked states, switching networks and refreshing balances is
    // either meaningless or confusing.
    const walletReady = hasVault && isUnlocked;

    // Update network pill label in header
    const networkPill = document.getElementById("network-pill");
    const networkLabel = networkPill?.querySelector(".network-pill__label");
    // While a switch runs, the pill names the network it goes to.
    if (networkLabel && !networkPill.classList.contains("is-switching")) {
      networkLabel.textContent = ov?.networkName ?? "Network";
    }

    // A test network says so above the header: its DUSK has no value.
    syncTestnetStrip(document.querySelector(".panel"), ov?.networkName);

    // Update network status indicator
    const nodeStatus = ov?.networkStatus?.nodeStatus ?? "unknown";
    let statusDot = networkPill?.querySelector(".net-status-dot");
    if (networkPill && !statusDot) {
      // Create status dot if it doesn't exist
      statusDot = document.createElement("span");
      statusDot.className = "net-status-dot";
      networkPill.insertBefore(statusDot, networkPill.firstChild);
    }
    if (statusDot) {
      // Remove old status classes
      statusDot.classList.remove(
        "net-status--online",
        "net-status--offline",
        "net-status--checking",
        "net-status--unknown"
      );
      statusDot.classList.add(networkStatusClass(nodeStatus));

      // Set title for tooltip
      const statusTitles = {
        online: "Network online",
        offline: ov?.networkStatus?.nodeError
          ? `Network offline: ${ov.networkStatus.nodeError}`
          : "Network offline",
        checking: "Checking network…",
        unknown: "Network status unknown",
      };
      statusDot.title = statusTitles[nodeStatus] ?? statusTitles.unknown;
    }

    if (networkPill) {
      // Disable the pill (and close any open menu) until the wallet is unlocked.
      networkPill.disabled = !walletReady;
      networkPill.classList.toggle("is-disabled", !walletReady);
      if (!walletReady && netMenu?.isOpen) netMenu.close();
      if (!walletReady && acctMenu?.isOpen) acctMenu.close();

      networkPill.onclick = walletReady
        ? () => {
            if (netMenu?.isOpen) netMenu.close();
            else netMenu?.open(networkPill, ov);
          }
        : null;
    }

    // Named as the page it opens.
    const optionsBtn = h("button", {
      class: "icon-btn icon-only",
      type: "button",
      html: iconSvg("settings"),
      title: "Settings",
      "aria-label": "Settings",
      onclick: onOpenOptions,
    });

    const canExpand = !isFullView && isExtensionRuntime() && isPopupView;
    const expandBtn = !canExpand
      ? null
      : h("button", {
          class: "icon-btn icon-only",
          type: "button",
          html: iconSvg("expand"),
          title: "Expand view",
          "aria-label": "Expand view",
          onclick: onExpand,
        });

    const actions = [];

    const accounts = Array.isArray(ov?.accounts) ? ov.accounts : [];
    const idxRaw = Number(ov?.selectedAccountIndex ?? 0);
    const idx = Number.isFinite(idxRaw) && idxRaw >= 0 ? Math.floor(idxRaw) : 0;
    const account = accounts[idx] ?? accounts[0];
    if (ov?.isUnlocked && typeof account === "string" && account.length) {
      let host = null;
      let connected = false;
      if (platform.capabilities.dapp) {
        const origin = ov?.activeOrigin;
        connected = Boolean(origin && ov?.activeConnected);
        if (origin) host = siteName(origin);
      }

      // The switcher's rows copy each account.
      const canOpenProfiles = Boolean(walletReady && acctMenu);
      // The profile's verified name, else its label; with more than one
      // wallet, the wallet's name under it.
      const label = profileLabelOf(ov, idx);
      const wallet = walletNameOf(ov);
      const key = [account, label, wallet, host, connected, ov?.nodeUrl, canOpenProfiles].join("\n");
      if (!chip || chipFor !== key || !acctMenu?.isOpen) {
        // A redrawn chip keeps the keyboard where it was.
        refocusChip = Boolean(chip) && document.activeElement === chip;
        chipFor = key;
        chip = accountChipEl(account, {
          connected,
          host,
          // The chip only shows the name, so it keeps the last one while it is looked up again.
          name: lookupPrimaryName(account, { nodeUrl: ov?.nodeUrl, stale: true }),
          label,
          wallet,
          expanded: canOpenProfiles && acctMenu.isOpen,
          onClick: canOpenProfiles
            ? (el) => {
                try {
                  if (acctMenu.isOpen) acctMenu.close();
                  else acctMenu.open(el, latest);
                } catch {
                  // ignore
                }
              }
            : undefined,
        });
      }
      actions.push(chip);
    }

    if (expandBtn) actions.push(expandBtn);
    // Refresh sits next to the balance on the dashboard.
    actions.push(optionsBtn);

    setChildren(headerActionsHost, actions);
    if (refocusChip) {
      refocusChip = false;
      chip?.focus();
    }
  };
}
