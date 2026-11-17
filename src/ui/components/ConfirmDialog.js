import { h } from "../lib/dom.js";

let ids = 0;

/**
 * Asks before something that can't be undone, over whatever shows, in the
 * wallet's own words and look rather than the browser's grey box: Cancel
 * (Escape too, and a phone's Back) or the action. Cancel has the focus.
 * Where the action throws away what's filled in (`destructive`: Leave, Go
 * back), Cancel is the main button too, the wide one under the thumb, and the
 * action the quiet one before it (Amélie's and Chen's: on Leave this
 * payment?, after a Back pressed by mistake, the wide pink button under the
 * thumb was Leave).
 *
 * @param {{ title: string, text: string, action: string, cancel?: string, destructive?: boolean }} opts -
 *   `cancel`: what Cancel is named, where another word says it better (Stay)
 * @returns {Promise<boolean>} true once the action is pressed
 */
export function askConfirm({ title, text, action, cancel: cancelText = "Cancel", destructive = false }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const finish = (answer) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      opener?.focus?.();
      resolve(answer);
    };
    const cancel = h("button", { class: destructive ? "btn-primary" : "btn-outline", type: "button", text: cancelText, "data-back": "", onclick: () => finish(false) });
    const go = h("button", { class: destructive ? "btn-outline" : "btn-primary", type: "button", text: action, onclick: () => finish(true) });
    const id = `wallet-dialog-${++ids}`;
    const dialog = h("div", { class: "wallet-dialog", role: "alertdialog", "aria-modal": "true", "aria-labelledby": id, "aria-describedby": `${id}-text` }, [
      h("h2", { class: "wallet-dialog__title", id, text: title }),
      h("p", { class: "settings-note", id: `${id}-text`, text }),
      // The main button second: the wide one (ui.css).
      h("div", { class: "wallet-dialog__actions" }, destructive ? [go, cancel] : [cancel, go]),
    ]);
    const overlay = h("div", { class: "qrscan-overlay" }, [dialog]);
    // Escape cancels wherever the focus is, and Tab stays in the dialog.
    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      } else if (event.key === "Tab") {
        event.preventDefault();
        (document.activeElement === cancel ? go : cancel).focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    cancel.focus();
  });
}
