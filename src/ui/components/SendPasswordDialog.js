import { formatDuskExact } from "../../shared/amount.js";
import { fingerprintPassword, fingerprintStatus, showKeyboard, turnFingerprintOff } from "../../platform/fingerprint.js";
import { h } from "../lib/dom.js";
import { fieldError, fieldLabel, passwordInput } from "./FormControls.js";

/** Why the password is asked, for a send above the amount chosen, or one that can't be counted. */
export function sendPasswordWhy({ limit, always }) {
  return always ? "The wallet can't count this in DUSK, so it asks on any amount." : `This is above the ${formatDuskExact(limit)} DUSK you set in Settings.`;
}

/** What a refusal of the password says: its own words for a wait, in plain ones for a wrong one. */
export function sendPasswordRefusal(message) {
  const text = String(message ?? "");
  if (/^Incorrect password$/.test(text)) return "Wrong password.";
  return /^Too many attempts/.test(text) ? text : "Couldn't check the password. Try again.";
}

let closeOpen = null;

/** Ends a dialog still open, as nothing was given: a lock or a switch took it. */
export const cancelSendPassword = () => closeOpen?.(null);

/**
 * Asks for the password over whatever shows, in front of the screen's redraws:
 * Enter gives it, Escape cancels, and what's typed goes with the dialog. With
 * fingerprint unlock on (the app on a phone), a fingerprint answers it: its
 * prompt comes up as the dialog opens, Use fingerprint asks again, and the
 * password stays, the prompt's Use password bringing up the keyboard.
 *
 * @param {object} opts
 * @param {string} opts.limit - the amount chosen, in lux
 * @param {boolean} [opts.always] - it can't be counted in DUSK
 * @param {(password: string) => Promise<string>} opts.check - what the wallet
 *   gives for a right one; it throws for a wrong one, which stays to try again
 * @returns {Promise<string | null>} what `check` gave, or null when it wasn't given
 */
export function askSendPassword({ limit, always = false, check }) {
  cancelSendPassword();
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const input = passwordInput({ autocomplete: "current-password", onEnter: () => submit() });
    const error = fieldError(input);
    input.addEventListener("input", () => error.show(""));
    let busy = false;
    let closed = false;
    const finish = (answer) => {
      closed = true;
      closeOpen = null;
      input.value = "";
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      opener?.focus?.();
      resolve(answer);
    };
    const cancel = h("button", { class: "btn-outline", type: "button", text: "Cancel", "data-back": "", onclick: () => finish(null) });
    const confirmBtn = h("button", { class: "btn-primary", type: "button", text: "Confirm", onclick: () => submit() });
    // The password typed, or the one a fingerprint gave (`kept`).
    const submit = async (kept = "") => {
      if (busy) return;
      if (!kept && !input.value) {
        error.show("Enter your password.");
        input.focus();
        return;
      }
      busy = true;
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Checking…";
      try {
        finish(await check(kept || input.value));
      } catch (e) {
        input.value = "";
        // The password the fingerprint kept is an old one: it's off now.
        if (kept && /^Incorrect password$/.test(String(e?.message ?? ""))) {
          await turnFingerprintOff().catch(() => {});
          fingerBtn.hidden = true;
          error.show("Your password changed, so fingerprint unlock is off. Enter your password.");
        } else {
          error.show(sendPasswordRefusal(e?.message));
        }
        input.focus();
      } finally {
        busy = false;
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Confirm";
      }
    };
    const fingerBtn = h("button", { class: "btn-outline btn-full", type: "button", text: "Use fingerprint", hidden: true, onclick: () => byFingerprint() });
    const byFingerprint = async () => {
      if (busy || closed) return;
      const answer = await fingerprintPassword({ title: "Confirm this send" });
      if (closed) return;
      if (answer.ok && answer.secret) return submit(answer.secret);
      if (answer.reason === "invalidated" || answer.reason === "off") fingerBtn.hidden = true;
      input.focus();
      showKeyboard().catch(() => {});
    };
    const title = h("h2", { class: "send-password__title", id: "send-password-title", text: "Enter your password" });
    const modal = h("div", { class: "send-password", role: "dialog", "aria-modal": "true", "aria-labelledby": "send-password-title" }, [
      title,
      h("p", { class: "settings-note", text: sendPasswordWhy({ limit, always }) }),
      fieldLabel(input, "Password you unlock with"),
      input,
      error.el,
      fingerBtn,
      h("div", { class: "send-password__actions" }, [cancel, confirmBtn]),
    ]);
    const overlay = h("div", { class: "qrscan-overlay" }, [modal]);
    // Escape cancels wherever the focus is, and Tab stays in the dialog.
    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) finish(null);
      } else if (event.key === "Tab") {
        const stops = [input, fingerBtn, cancel, confirmBtn].filter((el) => !el.disabled && !el.hidden);
        const at = stops.indexOf(document.activeElement);
        const next = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at + 1) % stops.length;
        event.preventDefault();
        stops[next]?.focus();
      }
    }
    closeOpen = finish;
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    input.focus();
    fingerprintStatus()
      .then(({ on }) => {
        if (!on || closed) return;
        fingerBtn.hidden = false;
        byFingerprint();
      })
      .catch(() => {});
  });
}
