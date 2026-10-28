import { h } from "../lib/dom.js";
import { identiconEl } from "./Identicon.js";

/**
 * The header's account chip: one line with the profile's verified .dusk name
 * once `name` gives one, else its label (the one set on this device, or
 * "Profile N"), and a ▾. The line ends in one "…" when it has to shrink. The
 * account itself is in the tooltip and the profile switcher, not on the chip.
 * A click calls `onClick` with the chip, which the header uses to open the
 * profile switcher.
 *
 * @param {string} account
 * @param {object} [opts]
 * @param {(chip: HTMLElement) => void} [opts.onClick]
 * @param {boolean} [opts.connected] - whether the active site is connected
 * @param {string|null} [opts.host] - the active site, marked on the identicon
 * @param {Promise<string|null>} [opts.name] - a lookup of the account's .dusk name
 * @param {string} [opts.label] - the profile's label, shown until a name is known
 * @param {boolean} [opts.expanded] - whether the profile switcher is open
 * @returns {HTMLElement}
 */
export function accountChipEl(account, { onClick, connected, host, name, label: profileLabel = "", expanded = false } = {}) {
  const shown = String(profileLabel ?? "").trim() || "Profile";
  const label = h("span", { class: "chip-text", text: shown });

  const icon = identiconEl(account || "dusk");
  if (host) {
    icon.classList.add("identicon--badged");
    icon.appendChild(
      h("div", {
        class: [
          "identicon-badge",
          connected ? "identicon-badge--on" : "identicon-badge--off",
        ].join(" "),
      })
    );
  }

  const site = host ? `${connected ? "Connected" : "Site"}: ${host}` : "";
  const tooltip = (verified) => [verified || shown, account, site].filter(Boolean).join("\n");

  const chip = h(
    "button",
    {
      class: "account-chip",
      type: "button",
      title: tooltip(""),
      "aria-haspopup": "menu",
      "aria-expanded": String(Boolean(expanded)),
      onclick: () => onClick?.(chip),
    },
    [icon, label, h("span", { class: "chip-chev", "aria-hidden": "true", text: "▾" })]
  );

  name?.then((verified) => {
    if (!verified) return;
    label.textContent = verified;
    chip.title = tooltip(verified);
  });

  return chip;
}
