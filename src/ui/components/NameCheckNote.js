import { nameCheckNote } from "../../shared/nodeNetwork.js";
import { h } from "../lib/dom.js";

/**
 * Under a .dusk name read through a node the wallet doesn't know: whose word it is.
 * Null on a network's own node.
 *
 * @param {string} nodeUrl - the node it was read through
 * @param {{ className?: string, hidden?: boolean }} [opts]
 * @returns {HTMLElement | null}
 */
export function nameCheckNoteEl(nodeUrl, { className = "send-self-note", hidden = false } = {}) {
  const text = nameCheckNote(nodeUrl);
  return text ? h("div", { class: className, role: "note", text, hidden }) : null;
}
