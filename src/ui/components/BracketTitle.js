import { h } from "../lib/dom.js";

// A section's head in the ledger's type, as [ ACTIVITY ]: the brackets are
// drawn, in the muted text colour, and a screen reader reads the title
// alone. `action`, a small control such as Refresh, or a list of them, sits
// after the text. A sub-page's title (Subnav) stays plain.
export function bracketTitle({ class: className = "", text, action = null } = {}) {
  const bracket = (glyph) => h("span", { class: "bracket-title__bracket", "aria-hidden": "true", text: glyph });
  return h("h2", { class: ["bracket-title", className].filter(Boolean).join(" ") }, [
    h("span", { class: "bracket-title__text" }, [bracket("["), text || "", bracket("]")]),
    ...[action].flat(),
  ]);
}
