import { h } from "../lib/dom.js";

export function bracketTitle({ class: className = "", text } = {}) {
  return h("div", { class: ["bracket-title", className].filter(Boolean).join(" ") }, [
    h("span", { class: "bracket-title__bracket", text: "[" }),
    h("span", { class: "bracket-title__text", text: text || "" }),
    h("span", { class: "bracket-title__bracket", text: "]" }),
  ]);
}
