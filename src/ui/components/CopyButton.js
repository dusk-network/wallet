import { h } from "../lib/dom.js";
import { copyToClipboard } from "../lib/clipboard.js";
import { iconSvg } from "./ActionIcon.js";

/** How long a Copy button says Copied, in ms. */
export const COPIED_MS = 1500;

// Screen readers hear "Copied" once, from one polite live region per page,
// made with the first Copy button so it's there before anything is said.
let region = null;

function liveRegion() {
  if (!region?.isConnected || region.ownerDocument !== document) {
    region = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
    document.body.appendChild(region);
  }
  return region;
}

const timers = new WeakMap();

function showCopied(button, label) {
  clearTimeout(timers.get(button));
  button.setAttribute("data-copied", "");
  button.setAttribute("aria-label", "Copied");
  const said = liveRegion();
  said.textContent = "Copied";
  timers.set(
    button,
    setTimeout(() => {
      button.removeAttribute("data-copied");
      button.setAttribute("aria-label", label);
      // Cleared, so the next copy is said again.
      if (said.textContent === "Copied") said.textContent = "";
    }, COPIED_MS)
  );
}

/**
 * A Copy button that says it copied on itself: for COPIED_MS its icon is a
 * check, or its words say "Copied", crossfading (ui.css), and its name is
 * "Copied". A copy that fails says `failText` through `onFail`, as a toast,
 * and the button stays as it is.
 *
 * @param {object} opts
 * @param {string|(() => string)} opts.value - what it copies; a function is asked on each press
 * @param {string} opts.label - its name, e.g. "Copy address"
 * @param {string} [opts.text] - its words, e.g. "Copy"; without them it shows the copy icon
 * @param {string} [opts.className]
 * @param {string} [opts.failText]
 * @param {(text: string) => void} [opts.onFail]
 * @param {boolean} [opts.stopPropagation] - a press doesn't reach the row it sits in
 * @param {object} [opts.attrs] - more attributes: title, disabled, role
 * @returns {HTMLButtonElement}
 */
export function copyButton({
  value,
  label,
  text = "",
  className = "copy-ico",
  failText = "Couldn't copy",
  onFail,
  stopPropagation = false,
  attrs = {},
}) {
  liveRegion();
  const face = (part, words) =>
    text ? h("span", { class: part, text: words }) : h("span", { class: part, html: iconSvg(words) });
  const button = h(
    "button",
    {
      class: className,
      type: "button",
      title: text ? undefined : label,
      ...attrs,
      "aria-label": label,
      // Its name while it says Copied, so a redraw keeps the focus on it (popup/app.js).
      "data-label": label,
      onclick: async (event) => {
        if (stopPropagation) event?.stopPropagation?.();
        const copied = String((typeof value === "function" ? value() : value) ?? "");
        if (!copied) return;
        if (!(await copyToClipboard(copied))) {
          onFail?.(failText);
          return;
        }
        showCopied(button, label);
      },
    },
    [
      h("span", { class: "copy-swap", "aria-hidden": "true" }, [
        face("copy-swap__from", text || "copy"),
        face("copy-swap__to", text ? "Copied" : "check"),
      ]),
    ]
  );
  return button;
}
