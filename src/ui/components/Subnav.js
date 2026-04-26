import { h } from "../lib/dom.js";

export function subnav({ actions = [], backText = "← Back", onBack, title } = {}) {
  return h("div", { class: "subnav" }, [
    h("div", { class: "subnav-title", text: title || "" }),
    h("div", { class: "subnav-actions" }, [
      ...(Array.isArray(actions) ? actions : [actions]).filter(Boolean),
      h("button", { class: "btn-outline", text: backText, onclick: onBack }),
    ]),
  ]);
}
