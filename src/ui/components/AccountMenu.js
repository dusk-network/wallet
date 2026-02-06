import { h } from "../lib/dom.js";
import { truncateMiddle } from "../lib/strings.js";
import { MAX_ACCOUNT_COUNT } from "../../shared/constants.js";

/**
 * Small controller that renders the account selection menu under an anchor.
 * Uses the same base classes as the network menu so ui.css styling applies.
 */
export function createAccountMenuController({
  onSelectAccountIndex,
  onAddAccount,
  onOpenOptions,
} = {}) {
  let menuEl = null;
  let cleanup = null;

  function close() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
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

    const items = displayAccounts.map((acct, i) => {
      const active = i === selIdx;
      const name = String(nameMap?.[String(i)] ?? "").trim();
      const label = name || `Account ${i + 1}`;
      const hint = acct ? truncateMiddle(String(acct), 12, 10) : "";

      const left = h("div", { class: "net-menu-item-left" }, [
        h("div", { class: "net-menu-item-label", text: label }),
        hint
          ? h("div", { class: "net-menu-item-hint", text: hint })
          : h("div"),
      ]);

      const check = active
        ? h("div", { class: "net-menu-check", text: "✓" })
        : h("div", { class: "net-menu-check", text: "" });

      return h(
        "button",
        {
          class: `net-menu-item ${active ? "net-menu-item--active" : ""}`,
          type: "button",
          onclick: async () => {
            try {
              close();
              await onSelectAccountIndex?.(i, { ov });
            } catch (e) {
              alert(e?.message ?? String(e));
            }
          },
        },
        [left, check]
      );
    });

    const canAddAccount = typeof onAddAccount === "function" && count < MAX_ACCOUNT_COUNT;
    const addAccountBtn = !canAddAccount
      ? null
      : h("button", {
          class: "net-menu-item",
          type: "button",
          onclick: async () => {
            try {
              close();
              await onAddAccount?.();
            } catch (e) {
              alert(e?.message ?? String(e));
            }
          },
        }, [
          h("div", { class: "net-menu-item-left" }, [
            h("div", { class: "net-menu-item-label", text: "Add account" }),
            h("div", { class: "net-menu-item-hint", text: `Derive profile ${count + 1} of ${MAX_ACCOUNT_COUNT}` }),
          ]),
          h("div", { class: "net-menu-check", text: "+" }),
        ]);

    const manageAccountsBtn =
      typeof onOpenOptions !== "function"
        ? null
        : h("button", {
            class: "net-menu-item",
            type: "button",
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
              h("div", { class: "net-menu-item-label", text: "Manage accounts" }),
              h("div", { class: "net-menu-item-hint", text: "Settings" }),
            ]),
            h("div", { class: "net-menu-check", text: "›" }),
          ]);

    const menu = h("div", { class: "net-menu acct-menu", role: "menu" }, [
      h("div", { class: "net-menu-title", text: "Select account" }),
      ...items,
      addAccountBtn || manageAccountsBtn ? h("div", { class: "divider" }) : null,
      addAccountBtn,
      manageAccountsBtn,
    ].filter(Boolean));

    document.body.appendChild(menu);
    menuEl = menu;

    // Position under the anchor
    const r = anchorEl.getBoundingClientRect();
    const menuWidth = 260;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - menuWidth - 8));
    const top = Math.min(window.innerHeight - 8, r.bottom + 8);
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
  }

  return { open, close, get isOpen() { return Boolean(menuEl); } };
}
