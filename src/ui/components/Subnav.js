import { h } from "../lib/dom.js";

// A sub-page's top bar: "← Back" on the left, the page's title in the middle,
// and any actions on the right.
export function subnav({ actions = [], backText = "← Back", onBack, title } = {}) {
  const actionItems = (Array.isArray(actions) ? actions : [actions]).filter(Boolean);
  return h("div", { class: "subnav" }, [
    h("div", { class: "subnav-left" }, [
      onBack ? h("button", { class: "subnav-back", type: "button", text: backText, onclick: onBack }) : null,
    ]),
    h("h1", { class: "subnav-title", text: title || "" }),
    h("div", { class: "subnav-actions" }, actionItems),
  ]);
}
