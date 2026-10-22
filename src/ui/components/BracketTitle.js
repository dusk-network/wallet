import { h } from "../lib/dom.js";

// `action`, a small control such as Refresh, sits after the text inside the brackets.
export function bracketTitle({ class: className = "", text, action = null } = {}) {
  return h("div", { class: ["bracket-title", className].filter(Boolean).join(" ") }, [
    h("span", { class: "bracket-title__bracket", text: "[" }),
    h("span", { class: "bracket-title__text", text: text || "" }),
    action,
    h("span", { class: "bracket-title__bracket", text: "]" }),
  ]);
}
