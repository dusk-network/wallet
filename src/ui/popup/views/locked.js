import { h } from "../../lib/dom.js";
import { passwordInput } from "../../components/FormControls.js";
import { askConfirm } from "../../components/ConfirmDialog.js";
import { isPhone } from "../../lib/device.js";
import { fingerprintPassword, fingerprintStatus, turnFingerprintOff, turnFingerprintOn } from "../../../platform/fingerprint.js";

/** What the unlock screen says once the phone's fingerprints changed. */
export const FINGERPRINTS_CHANGED_TEXT = "Your fingerprints changed, so fingerprint unlock is off. Unlock with your password.";

// A wrong password says what to try: the password as typed, then the recovery phrase.
export const WRONG_PASSWORD_TEXT = "Wrong password. Check Caps Lock, or restore with your recovery phrase below.";
// A phone's keyboard has no Caps Lock.
const wrongPasswordText = () => (isPhone() ? "Wrong password. Try again, or restore with your recovery phrase below." : WRONG_PASSWORD_TEXT);
const unlockError = (message) => (/^Incorrect password$/.test(String(message ?? "")) ? wrongPasswordText() : message);

export function lockedView({ state, actions } = {}) {
  const pwd = passwordInput({
    id: "unlock-password",
    autocomplete: "current-password",
    placeholder: "Password",
    onEnter: () => btn.click(),
  });

  // A wrong password says so under the field, where the eyes are.
  const errLine = h("div", { id: "unlock-error", class: "field-error", role: "alert", hidden: true });
  const showError = (text) => {
    errLine.textContent = text || "";
    errLine.hidden = !text;
    if (text) {
      pwd.setAttribute("aria-invalid", "true");
      pwd.setAttribute("aria-describedby", "unlock-error");
    } else {
      pwd.removeAttribute("aria-invalid");
      pwd.removeAttribute("aria-describedby");
    }
  };
  pwd.addEventListener("input", () => showError(""));

  // The button says "Unlocking…" meanwhile.
  const busyCallout = h("p", { class: "auth-note", style: "display:none", text: "This can take a moment." });

  // Fingerprint unlock, where it's on (the app on Android): its prompt comes
  // up by itself as this screen opens, and Use fingerprint asks again. The
  // password stays: the prompt's Use password, or this field.
  const fingerNote = h("p", { class: "auth-note", hidden: true });
  const sayFinger = (text) => {
    fingerNote.textContent = text || "";
    fingerNote.hidden = !text;
  };
  // The phone's fingerprints changed: once unlocked with the password, offer it again.
  let offerAgain = false;
  const fingerBtn = h("button", {
    class: "btn-outline btn-full",
    type: "button",
    text: "Use fingerprint",
    hidden: true,
    onclick: () => byFingerprint(),
  });
  const byFingerprint = async () => {
    if (busy || !pwd.isConnected) return;
    sayFinger("");
    const answer = await fingerprintPassword();
    if (!pwd.isConnected) return;
    if (answer.ok && answer.secret) {
      await unlockWith(answer.secret, { fingerprint: true });
      return;
    }
    if (answer.reason === "invalidated" || answer.reason === "off") {
      fingerBtn.hidden = true;
      if (answer.reason === "invalidated") {
        offerAgain = true;
        sayFinger(FINGERPRINTS_CHANGED_TEXT);
      }
    } else if (answer.reason === "error" || answer.reason === "unavailable") {
      sayFinger("Your fingerprint can't be read now. Use your password.");
    }
    pwd.focus?.();
  };
  fingerprintStatus().then(({ on }) => {
    if (!on || !pwd.isConnected) return;
    fingerBtn.hidden = false;
    byFingerprint();
    // Back in front with the wallet still locked: asked again, as the app opens.
    const comeBack = () => {
      if (!pwd.isConnected) return document.removeEventListener("visibilitychange", comeBack);
      if (document.visibilityState === "visible" && !fingerBtn.hidden) byFingerprint();
    };
    document.addEventListener("visibilitychange", comeBack);
  });

  // A forgotten password: the wallet restored from its recovery phrase.
  const forgot = h("button", {
    class: "text-btn auth-forgot",
    type: "button",
    text: "Forgot your password?",
    onclick: () => {
      state.route = "restore";
      actions?.render?.()?.catch?.(() => {});
    },
  });

  let busy = false;
  // Unlocks with `password`, typed or kept for a fingerprint.
  const unlockWith = async (password, { fingerprint = false } = {}) => {
    if (busy || !pwd.isConnected) return;
    busy = true;
    btn.disabled = true;
    pwd.disabled = true;
    forgot.disabled = true;
    btn.textContent = "Unlocking…";
    busyCallout.style.display = "block";
    showError("");

    try {
      const res = await actions?.send?.({ type: "DUSK_UI_UNLOCK", password });
      if (res?.error) {
        // The password kept for the fingerprint is an old one: it's off now.
        if (fingerprint && /^Incorrect password$/.test(String(res.error.message ?? ""))) {
          await turnFingerprintOff();
          fingerBtn.hidden = true;
          throw new Error("Your password changed, so fingerprint unlock is off. Unlock with your password.");
        }
        throw new Error(res.error.message ?? "Unlock failed");
      }
      state.needsRefresh = true;
      // The phone's fingerprints changed: fingerprint unlock again, with the password just typed.
      if (offerAgain && !fingerprint) {
        offerAgain = false;
        askConfirm({ title: "Turn fingerprint unlock on again?", text: "Your fingerprints changed since you turned it on.", action: "Turn on" })
          .then((yes) => (yes ? turnFingerprintOn(password) : null))
          .catch(() => {});
      }
      // Refresh even a replacement unlock form, but leave other views alone.
      if (!document.getElementById("unlock-password")) return;
      pwd.value = "";
      await actions?.render?.({ forceRefresh: true });
    } catch (err) {
      if (pwd.isConnected) showError(unlockError(err?.message ?? String(err)));
    } finally {
      pwd.value = "";
      busy = false;
      btn.disabled = false;
      pwd.disabled = false;
      forgot.disabled = false;
      btn.textContent = "Unlock";
      busyCallout.style.display = "none";
    }
  };
  const btn = h("button", {
    class: "btn-primary btn-full",
    text: "Unlock",
    onclick: () => unlockWith(pwd.value),
  });
  return [
    h("div", { class: "auth-page" }, [
      h("h1", { class: "auth-title", text: "Unlock your wallet" }),
      h("div", { class: "row" }, [h("label", { for: "unlock-password", text: "Password" }), pwd, errLine]),
      btn,
      fingerBtn,
      busyCallout,
      fingerNote,
      forgot,
    ]),
  ];
}
