import { h } from "../lib/dom.js";
import { copyButton } from "./CopyButton.js";

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
 * Copy beside a contract's ID, as an icon that says Copied; a copy that
 * fails says so in a toast.
 * @param {string} id - the whole ID, as it's copied
 * @param {(text: string) => void} [showToast]
 */
export function copyContractButton(id, showToast) {
  return copyButton({ value: id, label: "Copy contract ID", failText: "Couldn't copy the contract ID", onFail: showToast });
}
