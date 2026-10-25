import { h } from "../lib/dom.js";
import { copyToClipboard } from "../lib/clipboard.js";
import { lookupPrimaryName } from "../../shared/duskNames.js";
import { iconSvg } from "./ActionIcon.js";
import { duskNameEl } from "./DuskName.js";
import { shortAddressEl } from "./ShortAddress.js";

/**
 * Small controller that renders the profile selection menu under an anchor.
 * Uses the same base classes as the network menu so ui.css styling applies.
 * Each profile's row also copies its public account, reporting through `onCopy`.
 */
export function createAccountMenuController({
  onSelectAccountIndex,
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

    const items = displayAccounts.map((acct, i) => {
      const active = i === selIdx;
      const name = String(nameMap?.[String(i)] ?? "").trim();
      const label = name || `Profile ${i + 1}`;

      // Two lines: the label, then the profile's verified .dusk name, looked
      // up when the menu opens, or its short account until it has one.
      const lookup = acct ? lookupPrimaryName(String(acct), { nodeUrl: ov?.nodeUrl }) : null;
      const hint = acct
        ? h("div", { class: "net-menu-item-hint" }, [shortAddressEl(String(acct), { tag: "span" })])
        : h("div");
      lookup?.then((verified) => {
        if (verified) hint.hidden = true;
      });

      const left = h("div", { class: "net-menu-item-left" }, [
        h("div", { class: "net-menu-item-label", text: label }),
        lookup ? duskNameEl(lookup) : null,
        hint,
      ]);

      const check = active
        ? h("div", { class: "net-menu-check", text: "✓" })
        : h("div", { class: "net-menu-check", text: "" });

      const select = h(
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

      // Beside the row rather than in it: a button can't hold another button.
      const copy = acct
        ? h("button", {
            class: "acct-menu-copy",
            type: "button",
            html: iconSvg("copy"),
            title: "Copy public account",
            "aria-label": "Copy public account",
            onclick: async () => {
              const ok = await copyToClipboard(String(acct));
              close();
              onCopy?.(ok ? "Copied account" : "Copy failed");
            },
          })
        : null;

      return h("div", { class: "acct-menu-row" }, [select, copy]);
    });

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
              h("div", { class: "net-menu-item-label", text: "Manage profiles" }),
              h("div", { class: "net-menu-item-hint", text: "Settings" }),
            ]),
            h("div", { class: "net-menu-check", text: "›" }),
          ]);

    const menu = h("div", { class: "net-menu acct-menu", role: "menu" }, [
      h("div", { class: "net-menu-title", text: "Select profile" }),
      ...items,
      manageAccountsBtn ? h("div", { class: "divider" }) : null,
      manageAccountsBtn,
    ].filter(Boolean));

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
  }

  return { open, close, get isOpen() { return Boolean(menuEl); } };
}
