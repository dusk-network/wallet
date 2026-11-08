import { h } from "../lib/dom.js";

let ids = 0;

/**
 * Asks before something that can't be undone, over whatever shows, in the
 * wallet's own words and look rather than the browser's grey box: Cancel
 * (Escape too, and a phone's Back) or the action. Cancel has the focus.
 *
 * @param {{ title: string, text: string, action: string, destructive?: boolean }} opts
 * @returns {Promise<boolean>} true once the action is pressed
 */
export function askConfirm({ title, text, action, destructive = false }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const finish = (answer) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      opener?.focus?.();
      resolve(answer);
    };
    const cancel = h("button", { class: "btn-outline", type: "button", text: "Cancel", "data-back": "", onclick: () => finish(false) });
    const go = h("button", { class: destructive ? "btn-destructive" : "btn-primary", type: "button", text: action, onclick: () => finish(true) });
    const id = `wallet-dialog-${++ids}`;
    const dialog = h("div", { class: "wallet-dialog", role: "alertdialog", "aria-modal": "true", "aria-labelledby": id, "aria-describedby": `${id}-text` }, [
      h("h2", { class: "wallet-dialog__title", id, text: title }),
      h("p", { class: "settings-note", id: `${id}-text`, text }),
      h("div", { class: "wallet-dialog__actions" }, [cancel, go]),
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
