import { h } from "../lib/dom.js";
import { copyToClipboard } from "../lib/clipboard.js";
import { iconSvg } from "./ActionIcon.js";

/**
 * A contract as a row's value: its name, then "· 2257e5…a1b31d" and what
 * follows it (Copy), kept together, so a narrow row breaks between the name
 * and the ID, never inside the ID or after the "·".
 * @param {string|null} name - what the network calls it, if anything
 * @param {Node} idEl - its short ID
 * @param {Node|null} [after]
 * @returns {HTMLElement}
 */
export function contractValueEl(name, idEl, after = null) {
  return h("span", { class: "contract-value" }, [
    name ? h("span", { class: "contract-name", text: name }) : null,
    name ? " " : null,
    h("span", { class: "contract-id" }, [name ? "· " : null, idEl, after].filter(Boolean)),
  ].filter(Boolean));
}

/**
 * Copy beside a contract's ID, as an icon.
 * @param {string} id - the whole ID, as it's copied
 * @param {(text: string) => void} [showToast]
 */
export function copyContractButton(id, showToast) {
  return h("button", {
    class: "copy-ico",
    type: "button",
    title: "Copy contract ID",
    "aria-label": "Copy contract ID",
    html: iconSvg("copy"),
    onclick: async () => {
      const ok = await copyToClipboard(id);
      showToast?.(ok ? "Contract ID copied" : "Couldn't copy the contract ID");
    },
  });
}
