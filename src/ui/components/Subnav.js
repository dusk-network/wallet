import { h } from "../lib/dom.js";

export function subnav({ backText = "← Back", onBack, title } = {}) {
  return h("div", { class: "subnav" }, [
    h("button", { class: "btn-outline", text: backText, onclick: onBack }),
    h("div", { class: "pill", text: title || "" }),
  ]);
}
