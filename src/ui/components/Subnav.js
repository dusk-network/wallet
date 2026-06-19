import { h } from "../lib/dom.js";
import { bracketTitle } from "./BracketTitle.js";

export function subnav({ actions = [], backText = "← Back", onBack, title } = {}) {
  const actionItems = (Array.isArray(actions) ? actions : [actions]).filter(Boolean);
  return h("div", { class: "subnav" }, [
    h("div", { class: "subnav-left" }, [
      onBack ? h("button", { class: "btn-outline subnav-back", text: backText, onclick: onBack }) : null,
    ]),
    bracketTitle({ class: "subnav-title", text: title || "" }),
    h("div", { class: "subnav-actions" }, actionItems),
  ]);
}
