import { NETWORK_PRESETS } from "../../shared/networkPresets.js";
import { detectPresetIdFromNodeUrl } from "../../shared/network.js";
import { h } from "../lib/dom.js";

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
    if (!anchorEl) return;

    const currentPresetId = detectPresetIdFromNodeUrl(ov?.nodeUrl);

    const items = NETWORK_PRESETS.map((p) => {
      const active = p.id === currentPresetId;

      const left = h("div", { class: "net-menu-item-left" }, [
        h("div", { class: "net-menu-item-label", text: p.label }),
        p.hint
          ? h("div", { class: "net-menu-item-hint", text: p.hint })
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
              await onSelectPreset?.(p, { ov });
            } catch (e) {
              // Let caller decide how to surface errors, fall back to alert.
              alert(e?.message ?? String(e));
            }
          },
        },
        [left, check]
      );
    });

    const menu = h("div", { class: "net-menu", role: "menu" }, [
      h("div", { class: "net-menu-title", text: "Select network" }),
      ...items,
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
  }

  return { open, close, get isOpen() { return Boolean(menuEl); } };
}
