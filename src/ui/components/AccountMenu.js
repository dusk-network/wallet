import { h } from "../lib/dom.js";
import { copyToClipboard } from "../lib/clipboard.js";
import { lookupPrimaryName } from "../../shared/duskNames.js";
import { walletLabel } from "../../shared/wallets.js";
import { iconSvg } from "./ActionIcon.js";
import { shortAddressEl } from "./ShortAddress.js";
import { menuKeys } from "./MenuKeys.js";

/**
 * Small controller that renders the profile selection menu under an anchor.
 * Uses the same base classes as the network menu so ui.css styling applies.
 * Each profile's row also copies its public account, reporting through `onCopy`.
 * With the overview's wallets, the profiles are under their wallet's name, as
 * "Wallet 1" and "Wallet 2", and each is picked by its wallet's key
 * (`onSelectWalletProfile`): another wallet's opens that wallet, and the
 * open one's is picked in it, whichever wallet is open by then. Add wallet
 * adds one (`onAddWallet`).
 */
export function createAccountMenuController({
  onSelectAccountIndex,
  onSelectWalletProfile,
  onAddWallet,
  onOpenOptions,
  onCopy,
} = {}) {
  let menuEl = null;
  let cleanup = null;
  let anchor = null;

  function close() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    anchor?.setAttribute("aria-expanded", "false");
    anchor = null;
  }

  function open(anchorEl, ov) {
    close();
    if (!anchorEl) return;

    const accounts = Array.isArray(ov?.accounts) ? ov.accounts : [];
    const countRaw = Number(ov?.accountCount ?? accounts.length ?? 1);
    const count = Number.isFinite(countRaw) && countRaw >= 1 ? Math.floor(countRaw) : 1;
    const displayAccounts = accounts.length ? accounts : Array.from({ length: count }, () => "");

    const selIdxRaw = Number(ov?.selectedAccountIndex ?? 0);
    const selIdx = Number.isFinite(selIdxRaw) && selIdxRaw >= 0 ? Math.floor(selIdxRaw) : 0;

    const nameMap = ov?.accountNames && typeof ov.accountNames === "object" ? ov.accountNames : {};

    // One profile's row: it selects the profile, and copies its account beside.
    const profileRow = ({ acct, i, names, active, select }) => {
      const name = String(names?.[String(i)] ?? "").trim();
      const label = name || `Profile ${i + 1}`;

      // Two lines: the label, then the profile's short account, after its
      // verified .dusk name once the lookup when the menu opens gives one:
      // "alice.dusk · qxwSid…kQ2Bgr", as the connect window shows it.
      const lookup = acct ? lookupPrimaryName(String(acct), { nodeUrl: ov?.nodeUrl }) : null;
      const verifiedEl = h("span", { class: "dusk-name", hidden: true });
      const dot = h("span", { text: " · ", hidden: true });
      const hint = acct
        ? h("div", { class: "net-menu-item-hint" }, [verifiedEl, dot, shortAddressEl(String(acct), { tag: "span" })])
        : h("div");
      lookup?.then((verified) => {
        if (!verified) return;
        Object.assign(verifiedEl, { textContent: verified, title: verified, hidden: false });
        dot.hidden = false;
      });

      const left = h("div", { class: "net-menu-item-left" }, [h("div", { class: "net-menu-item-label", text: label }), hint]);

      const check = h("span", { class: "net-menu-check", "aria-hidden": "true", html: active ? iconSvg("check") : "" });

      const selectBtn = h(
        "button",
        {
          class: `net-menu-item ${active ? "net-menu-item--active" : ""}`,
          type: "button",
          role: "menuitemradio",
          "aria-checked": String(active),
          onclick: async () => {
            try {
              const from = anchor;
              close();
              from?.focus();
              await select();
            } catch (e) {
              alert(e?.message ?? String(e));
            }
          },
        },
        [left, check]
      );

      // Beside the row rather than in it: a button can't hold another button.
      const copy = acct
        ? h("button", {
            class: "acct-menu-copy",
            type: "button",
            role: "menuitem",
            html: iconSvg("copy"),
            title: "Copy public account",
            "aria-label": `Copy ${label}'s public account`,
            onclick: async () => {
              const ok = await copyToClipboard(String(acct));
              const from = anchor;
              close();
              from?.focus();
              onCopy?.(ok ? "Copied account" : "Copy failed");
            },
          })
        : null;

      return h("div", { class: "acct-menu-row", role: "none" }, [selectBtn, copy]);
    };

    // The open wallet's profiles: by its key when the menu lists wallets.
    const ownRows = (walletKey) =>
      displayAccounts.map((acct, i) =>
        profileRow({
          acct,
          i,
          names: nameMap,
          active: i === selIdx,
          select: () => (walletKey ? onSelectWalletProfile?.(walletKey, i, { ov }) : onSelectAccountIndex?.(i, { ov })),
        })
      );

    // Each wallet under its name: the unlocked one's profiles as the overview
    // has them, another's as they were last shown.
    const wallets = Array.isArray(ov?.wallets) && ov.wallets.length ? [...ov.wallets].sort((a, b) => a.n - b.n) : null;
    const items = !wallets
      ? ownRows()
      : wallets.map((w) => {
          const titleId = `acct-menu-wallet-${w.n}`;
          const rows = w.active
            ? ownRows(w.key)
            : (Array.isArray(w.accounts) && w.accounts.length ? w.accounts : Array.from({ length: count }, () => "")).map((acct, i) =>
                profileRow({ acct, i, names: w.accountNames, active: false, select: () => onSelectWalletProfile?.(w.key, i, { ov }) })
              );
          return h("div", { class: "acct-menu-wallet", role: "group", "aria-labelledby": titleId }, [
            h("div", { class: "acct-menu-wallet-title", id: titleId, role: "presentation", text: walletLabel(w) }),
            ...rows,
          ]);
        });

    const addWalletBtn =
      !wallets || typeof onAddWallet !== "function"
        ? null
        : h("button", {
            class: "net-menu-item",
            type: "button",
            role: "menuitem",
            onclick: async () => {
              try {
                close();
                await onAddWallet();
              } catch (e) {
                alert(e?.message ?? String(e));
              }
            },
          }, [
            h("div", { class: "net-menu-item-left" }, [h("div", { class: "net-menu-item-label", text: "Add wallet" })]),
            h("span", { class: "net-menu-check", "aria-hidden": "true", html: iconSvg("plus") }),
          ]);

    const manageAccountsBtn =
      typeof onOpenOptions !== "function"
        ? null
        : h("button", {
            class: "net-menu-item",
            type: "button",
            role: "menuitem",
            onclick: async () => {
              try {
                close();
                await onOpenOptions();
              } catch (e) {
                alert(e?.message ?? String(e));
              }
            },
          }, [
            h("div", { class: "net-menu-item-left" }, [
              h("div", { class: "net-menu-item-label", text: "Manage profiles" }),
              h("div", { class: "net-menu-item-hint", text: "Settings" }),
            ]),
            h("span", { class: "net-menu-check", "aria-hidden": "true", html: iconSvg("chev-r") }),
          ]);

    const menu = h("div", { class: "net-menu acct-menu" }, [
      h("div", { class: "net-menu-title", id: "acct-menu-title", text: "Select profile" }),
      h("div", { class: "net-menu-items", role: "menu", "aria-labelledby": "acct-menu-title" }, [
        ...items,
        addWalletBtn || manageAccountsBtn ? h("div", { class: "divider", role: "separator" }) : null,
        addWalletBtn,
        manageAccountsBtn,
      ].filter(Boolean)),
    ]);

    document.body.appendChild(menu);
    menuEl = menu;

    // Position near the anchor while keeping the menu inside the viewport.
    const r = anchorEl.getBoundingClientRect();
    const menuWidth = Math.max(260, menu.offsetWidth || 0);
    const menuHeight = menu.offsetHeight || 0;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - menuWidth - 8));
    const below = r.bottom + 8;
    const above = r.top - menuHeight - 8;
    const top = below + menuHeight <= window.innerHeight - 8
      ? below
      : Math.max(8, above);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const onDown = (e) => {
      const t = e.target;
      if (!menuEl) return;
      if (menuEl.contains(t)) return;
      if (anchorEl.contains(t)) return;
      close();
    };
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);

    cleanup = () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };

    anchor = anchorEl;
    anchor.setAttribute("aria-expanded", "true");
    menuKeys(menu.querySelector("[role=menu]"), { anchor: anchorEl, close });
  }

  return { open, close, get isOpen() { return Boolean(menuEl); } };
}
