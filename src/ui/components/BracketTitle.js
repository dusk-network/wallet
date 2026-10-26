import { h } from "../lib/dom.js";

// A section title in sentence case. It was drawn between [ brackets ] once;
// the name stays for its callers. `action`, a small control such as Refresh,
// or a list of them, sits after the text.
export function bracketTitle({ class: className = "", text, action = null } = {}) {
  return h("h2", { class: ["bracket-title", className].filter(Boolean).join(" ") }, [
    h("span", { class: "bracket-title__text", text: text || "" }),
    ...[action].flat(),
  ]);
}
