// Boxes for "Check your recovery words": one for each word asked, named by
// its place (Word 4), as Import's boxes are made: no password manager, no
// keyboard learning, hidden on a phone till Show words. Enter goes on to the
// next box, and on the last, to the check (`onDone`).

import { isTauriRuntime } from "../../platform/runtime.js";
import { h } from "../lib/dom.js";
import { isPhone } from "../lib/device.js";

/**
 * @param {{ places: number[], masked?: boolean, passwordBoxes?: boolean, onDone?: () => void }} opts
 */
export function createWordCheck({ places, masked = isPhone(), passwordBoxes = masked && isTauriRuntime(), onDone }) {
  const inputs = places.map((place, i) =>
    h("input", {
      type: passwordBoxes ? "password" : "text",
      inputmode: "text",
      autocomplete: passwordBoxes ? "one-time-code" : "off",
      autocorrect: "off",
      autocapitalize: "none",
      spellcheck: "false",
      enterkeyhint: i === places.length - 1 ? "done" : "next",
      "aria-label": `Word ${place}`,
    })
  );
  inputs.forEach((input, i) =>
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault?.();
      if (i < inputs.length - 1) inputs[i + 1].focus?.();
      else onDone?.();
    })
  );
  const grid = h(
    "div",
    { class: ["srp-grid srp-grid--input", masked ? "srp-grid--masked is-hidden" : ""].filter(Boolean).join(" ") },
    places.map((place, i) => h("div", { class: "srp-word" }, [h("div", { class: "srp-word-index", text: String(place) }), h("div", { class: "srp-word-input" }, [inputs[i]])]))
  );
  let shown = false;
  const showBtn = masked
    ? h("button", {
        class: "text-btn srp-show",
        type: "button",
        text: "Show words",
        "aria-pressed": "false",
        onclick: () => {
          shown = !shown;
          grid.classList.toggle("is-hidden", !shown);
          if (passwordBoxes) for (const input of inputs) input.setAttribute("type", shown ? "text" : "password");
          showBtn.textContent = shown ? "Hide words" : "Show words";
          showBtn.setAttribute("aria-pressed", String(shown));
        },
      })
    : null;
  const el = h("form", { class: "mnemonic-input", novalidate: "" }, [h("div", { class: "box srp-box" }, [grid]), showBtn].filter(Boolean));
  el.addEventListener("submit", (e) => e.preventDefault?.());
  return {
    el,
    /** Each word typed, by its place. */
    typed: () => places.map((place, i) => [place, inputs[i].value]),
    filled: () => inputs.every((input) => input.value.trim() !== ""),
    clear: () => inputs.forEach((input) => (input.value = "")),
    focus: () => inputs[0]?.focus?.(),
    setDisabled: (on) => inputs.forEach((input) => (input.disabled = Boolean(on))),
  };
}
