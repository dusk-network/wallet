import { h, setChildren } from "../lib/dom.js";
import { truncateMiddle } from "../lib/strings.js";
import { identiconEl } from "./Identicon.js";

// The chip's one line: the name, cut at its end when it has to shrink, or the
// short account (6…4), which then gives up characters before the "…" and
// keeps its last four.
function chipLabel(text, tail = "") {
  return [
    h("span", { class: "chip-text__head", text }),
    tail ? h("span", { class: "chip-text__tail", text: tail }) : null,
  ];
}

/**
 * The header's account chip: one line with the profile's verified .dusk name
 * once `name` gives one, else its short account, and a ▾. A click calls
 * `onClick` with the chip, which the header uses to open the profile switcher.
 * The tooltip has the full name and account.
 *
 * @param {string} account
 * @param {object} [opts]
 * @param {(chip: HTMLElement) => void} [opts.onClick]
 * @param {boolean} [opts.connected] - whether the active site is connected
 * @param {string|null} [opts.host] - the active site, marked on the identicon
 * @param {Promise<string|null>} [opts.name] - a lookup of the account's .dusk name
 * @param {boolean} [opts.expanded] - whether the profile switcher is open
 * @returns {HTMLElement}
 */
export function accountChipEl(account, { onClick, connected, host, name, expanded = false } = {}) {
  const short = account ? truncateMiddle(account, 6, 4) : "—";
  const cut = short === account ? -1 : short.indexOf("…");
  const label = h(
    "span",
    { class: "chip-text" },
    cut < 0 ? chipLabel(short) : chipLabel(short.slice(0, cut + 1), short.slice(cut + 1))
  );

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
  const tooltip = (verified) => [verified, account, site].filter(Boolean).join("\n");

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
    setChildren(label, chipLabel(verified));
    chip.title = tooltip(verified);
  });

  return chip;
}
