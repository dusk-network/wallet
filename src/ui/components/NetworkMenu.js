import { NETWORK_PRESETS } from "../../shared/networkPresets.js";
import { detectPresetIdFromNodeUrl } from "../../shared/network.js";
import { h } from "../lib/dom.js";
import { iconSvg } from "./ActionIcon.js";
import { menuKeys } from "./MenuKeys.js";

/**
 * Marks the network pill busy while the wallet moves to `label`'s network,
 * with a spinner in place of its status dot, or clears it with null.
 * @param {HTMLElement} pill
 * @param {string|null} label
 */
export function setNetworkSwitching(pill, label) {
  if (!pill) return;
  pill.classList.toggle("is-switching", Boolean(label));
  if (label) {
    pill.setAttribute("aria-busy", "true");
    pill.setAttribute("aria-label", `Switching to ${label}`);
    const text = pill.querySelector(".network-pill__label");
    if (text) text.textContent = label;
  } else {
    pill.removeAttribute("aria-busy");
    pill.removeAttribute("aria-label");
  }
}

/**
 * Small controller that renders the network selection menu under an anchor.
 * This intentionally keeps the original markup/classes so ui.css keeps working.
 */
export function createNetworkMenuController({
  onSelectPreset,
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
    const pill = document.getElementById("network-pill");
    if (pill) pill.setAttribute("aria-expanded", "false");
  }

  function open(anchorEl, ov) {
    close();
    // One switch at a time.
    if (!anchorEl || anchorEl.classList.contains("is-switching")) return;

    const currentPresetId = detectPresetIdFromNodeUrl(ov?.nodeUrl);

    const items = NETWORK_PRESETS.map((p) => {
      const active = p.id === currentPresetId;

      const left = h("div", { class: "net-menu-item-left" }, [
        h("div", { class: "net-menu-item-label", text: p.label }),
        p.hint
          ? h("div", { class: "net-menu-item-hint", text: p.hint })
          : h("div"),
      ]);

      const check = h("span", { class: "net-menu-check", "aria-hidden": "true", html: active ? iconSvg("check") : "" });

      return h(
        "button",
        {
          class: `net-menu-item ${active ? "net-menu-item--active" : ""}`,
          type: "button",
          role: "menuitemradio",
          "aria-checked": String(active),
          onclick: async () => {
            close();
            anchorEl.focus();
            // The pill spins until the wallet is on the new network.
            const switching = p.id !== "custom" && !active;
            if (switching) setNetworkSwitching(anchorEl, p.label);
            try {
              await onSelectPreset?.(p, { ov });
            } catch (e) {
              // Let caller decide how to surface errors, fall back to alert.
              alert(e?.message ?? String(e));
            } finally {
              if (switching) setNetworkSwitching(anchorEl, null);
            }
          },
        },
        [left, check]
      );
    });

    const menu = h("div", { class: "net-menu" }, [
      h("div", { class: "net-menu-title", id: "net-menu-title", text: "Select network" }),
      h("div", { class: "net-menu-items", role: "menu", "aria-labelledby": "net-menu-title" }, items),
    ]);

    document.body.appendChild(menu);
    menuEl = menu;

    // Position menu near the pill while keeping it inside the viewport.
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

    // Close on outside click / escape
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

    anchorEl.setAttribute("aria-expanded", "true");
    menuKeys(menu.querySelector("[role=menu]"), { anchor: anchorEl, close });
  }

  return { open, close, get isOpen() { return Boolean(menuEl); } };
}
