// Settings' screens for the wallets here: removing one, a new password for all
// of them, and the password again on big sends. Each asks for the password, says
// under its field what's wrong, and goes back to Settings once done.

import { formatLuxForInput, parseDuskToLux, amountForInput } from "../../../shared/amount.js";
import { walletLabel } from "../../../shared/wallets.js";
import { h } from "../../lib/dom.js";
import { shortAddress } from "../../lib/strings.js";
import { decimalInput, fieldError, fieldLabel, newPasswordField, passwordForm, passwordInput, unlockPasswordField } from "../../components/FormControls.js";
import { srpGridEl } from "./onboarding.js";
import { subnav } from "../../components/Subnav.js";
import { isExtensionRuntime } from "../../../platform/runtime.js";
import { platform } from "../../../platform/index.js";
import { switchContext } from "../context.js";
import { fingerprintPassword, fingerprintStatus, showKeyboard, turnFingerprintOff, turnFingerprintOn } from "../../../platform/fingerprint.js";

// A wrong password, or one that has to wait, is said under the password.
const passwordRefusal = (message) => /^Incorrect password$|^Too many attempts/.test(String(message ?? ""));

function passwordField({ label, placeholder, autocomplete = "current-password", onEnter }) {
  const input = passwordInput({ placeholder, autocomplete, onEnter });
  const error = fieldError(input);
  input.addEventListener("input", () => error.show(""));
  return { input, error, els: [fieldLabel(input, label), input, error.el] };
}

function formError() {
  const el = h("div", { class: "field-error", role: "alert", hidden: true });
  return {
    el,
    show(text) {
      el.textContent = text || "";
      el.hidden = !text;
    },
  };
}

const backToSettings = (state, actions) => {
  state.route = "options";
  state.walletRemove = null;
  actions?.render?.()?.catch?.(() => {});
};

/**
 * Remove one wallet, as Settings chose it (state.walletRemove, its key): what
 * goes, and the password. The others stay as they are.
 */
export function removeWalletView(ov, { state, actions } = {}) {
  const wallets = Array.isArray(ov?.wallets) ? ov.wallets : [];
  const wallet = wallets.find((w) => w.key === state.walletRemove);
  if (!wallet || wallets.length < 2) {
    state.route = "options";
    state.walletRemove = null;
    return [];
  }
  const name = walletLabel(wallet);
  const account = String(wallet.accounts?.[0] ?? wallet.walletId ?? "");
  // The password the wallets share, named for what it is.
  const pwd = unlockPasswordField({ onEnter: () => btn.click() });
  const err = formError();

  let busy = false;
  const btn = h("button", {
    class: "btn-destructive btn-full",
    type: "button",
    text: "Remove wallet",
    onclick: async () => {
      if (busy) return;
      err.show("");
      pwd.error.show("");
      if (!pwd.input.value) {
        pwd.error.show("Enter your password.");
        pwd.input.focus();
        return;
      }
      busy = true;
      btn.disabled = true;
      pwd.input.disabled = true;
      btn.textContent = "Removing…";
      try {
        // The wallet open now may be the one going: whatever began on it is for nothing.
        if (wallet.active) switchContext(state);
        const res = await actions?.send?.({ type: "DUSK_UI_REMOVE_WALLET", walletKey: wallet.key, password: pwd.input.value });
        pwd.input.value = "";
        if (res?.error) throw new Error(res.error.message ?? "Couldn't remove the wallet");
        actions?.showToast?.(`${name} removed.`);
        state.needsRefresh = true;
        backToSettings(state, actions);
      } catch (e) {
        const message = e?.message ?? String(e);
        if (passwordRefusal(message)) pwd.error.show(message);
        else err.show(message);
        busy = false;
        btn.disabled = false;
        pwd.input.disabled = false;
        btn.textContent = "Remove wallet";
      }
    },
  });

  // `busy`: a removal under way, which the popup keeps the form through.
  return Object.assign([
    subnav({ title: "Remove wallet", onBack: () => backToSettings(state, actions) }),
    h("div", { class: "row onboard-form" }, [
      // Which wallet, by its first profile's account too: names can be alike.
      account ? h("p", { class: "settings-profile-line", text: `${name} · ${shortAddress(account)}` }) : null,
      h("p", {
        class: "auth-lead",
        text: `This removes ${name} from this device: its recovery phrase, contacts, activity and connected sites. Your other wallets stay as they are.`,
      }),
      h("p", { class: "settings-note", text: "Your funds stay on Dusk. The recovery phrase brings this wallet back." }),
      ...pwd.els,
      err.el,
      btn,
    ]),
  ], { busy: () => busy });
}

/** What a reset takes with the wallets: the app has no connected sites. */
export const resetKeptText = () => (platform.capabilities.dapp ? "contacts, names, activity and connected sites" : "contacts, names and activity");

/**
 * Reset, as Settings chose it: every wallet here goes, so the password first,
 * as for removing one, or in the app with fingerprint unlock on, a
 * fingerprint. Locked or not: the wallet checks it against the vault.
 */
export function resetWalletView(ov, { state, actions } = {}) {
  const pwd = unlockPasswordField({ onEnter: () => btn.click() });
  const err = formError();
  let busy = false;

  const reset = async (password) => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    fingerBtn.disabled = true;
    pwd.input.disabled = true;
    btn.textContent = "Resetting…";
    try {
      switchContext(state);
      const res = await actions?.send?.({ type: "DUSK_UI_RESET_WALLET", password });
      pwd.input.value = "";
      if (res?.error) throw new Error(res.error.message ?? "Wallet reset failed");
      // No wallet, no password to keep for a fingerprint.
      await turnFingerprintOff();
      actions?.showToast?.("Wallet reset. Import again to continue.", 2500);
      state.route = "home";
      state.needsRefresh = true;
      await actions?.render?.({ forceRefresh: true });
    } catch (e) {
      const message = e?.message ?? String(e);
      if (passwordRefusal(message)) pwd.error.show(message);
      else err.show(message);
      busy = false;
      btn.disabled = false;
      fingerBtn.disabled = false;
      pwd.input.disabled = false;
      btn.textContent = "Reset wallet";
    }
  };

  const btn = h("button", {
    class: "btn-destructive btn-full",
    type: "button",
    text: "Reset wallet",
    onclick: () => {
      err.show("");
      pwd.error.show("");
      if (!pwd.input.value) {
        pwd.error.show("Enter your password.");
        pwd.input.focus();
        return;
      }
      reset(pwd.input.value);
    },
  });
  // The fingerprint in place of the password, where it's on: the password it kept.
  const fingerBtn = h("button", {
    class: "btn-outline btn-full",
    type: "button",
    text: "Use fingerprint",
    hidden: true,
    onclick: async () => {
      if (busy) return;
      err.show("");
      const answer = await fingerprintPassword({ title: "Reset wallet" });
      if (!pwd.input.isConnected) return;
      if (answer.ok && answer.secret) return reset(answer.secret);
      if (answer.reason === "invalidated" || answer.reason === "off") fingerBtn.hidden = true;
      pwd.input.focus();
      showKeyboard().catch(() => {});
    },
  });
  fingerprintStatus()
    .then(({ on }) => {
      if (on && pwd.input.isConnected) fingerBtn.hidden = false;
    })
    .catch(() => {});

  return Object.assign([
    subnav({ title: "Reset wallet", onBack: () => backToSettings(state, actions) }),
    h("div", { class: "row onboard-form" }, [
      h("p", {
        class: "auth-lead",
        text: `This removes every wallet here, with its ${resetKeptText()}. Your funds stay on Dusk. You need each recovery phrase to use them again.`,
      }),
      ...pwd.els,
      err.el,
      btn,
      fingerBtn,
    ]),
  ], { busy: () => busy });
}

/**
 * The open wallet's recovery phrase, again, in the app's Settings: the
 * password first, or a fingerprint where it's on; then its words, till the
 * screen is left. Nothing of them is kept.
 */
export function recoveryPhraseView(ov, { state, actions } = {}) {
  const pwd = unlockPasswordField({ onEnter: () => btn.click() });
  const err = formError();
  const wallets = Array.isArray(ov?.wallets) ? ov.wallets : [];
  const open = wallets.length > 1 ? wallets.find((w) => w.key === ov?.walletKey) : null;
  const page = h("div", { class: "row onboard-form" });
  // Read under way, in the popup's context then (`asked`): the form stays
  // through redraws meanwhile, not through another wallet opening, and what
  // comes after one did isn't shown. Shown, the words go with the next.
  let busy = false;
  let asked = null;

  const words = (mnemonic) => [
    open ? h("p", { class: "settings-profile-line", text: walletLabel(open) }) : null,
    h("p", { class: "auth-lead", text: `These are this wallet's ${mnemonic.trim().split(/\s+/).length} words, in order. Check them against the ones you wrote down.` }),
    h("p", { class: "phrase-warning", text: "Never share your recovery phrase. Anyone with it can take your funds." }),
    srpGridEl(mnemonic),
    h("button", { class: "btn-primary btn-full", type: "button", text: "Done", onclick: () => backToSettings(state, actions) }),
  ];

  const show = async (password) => {
    if (busy) return;
    busy = true;
    asked = state.context;
    btn.disabled = true;
    fingerBtn.disabled = true;
    pwd.input.disabled = true;
    btn.textContent = "Checking…";
    try {
      const res = await actions?.send?.({ type: "DUSK_UI_RECOVERY_PHRASE", password });
      pwd.input.value = "";
      if (res?.error) throw new Error(res.error.message ?? "Couldn't read the recovery phrase");
      busy = false;
      if (!page.isConnected || state.context !== asked) return;
      page.replaceChildren(...words(String(res?.result ?? "")).filter(Boolean));
    } catch (e) {
      const message = e?.message ?? String(e);
      if (passwordRefusal(message)) pwd.error.show(message);
      else err.show(message);
      busy = false;
      btn.disabled = false;
      fingerBtn.disabled = false;
      pwd.input.disabled = false;
      btn.textContent = "Show recovery phrase";
    }
  };

  const btn = h("button", {
    class: "btn-primary btn-full",
    type: "button",
    text: "Show recovery phrase",
    onclick: () => {
      err.show("");
      pwd.error.show("");
      if (!pwd.input.value) {
        pwd.error.show("Enter your password.");
        pwd.input.focus();
        return;
      }
      show(pwd.input.value);
    },
  });
  const fingerBtn = h("button", {
    class: "btn-outline btn-full",
    type: "button",
    text: "Use fingerprint",
    hidden: true,
    onclick: async () => {
      if (busy) return;
      err.show("");
      const answer = await fingerprintPassword({ title: "Show recovery phrase" });
      if (!pwd.input.isConnected) return;
      if (answer.ok && answer.secret) return show(answer.secret);
      if (answer.reason === "invalidated" || answer.reason === "off") fingerBtn.hidden = true;
      pwd.input.focus();
      showKeyboard().catch(() => {});
    },
  });
  fingerprintStatus()
    .then(({ on }) => {
      if (on && pwd.input.isConnected) fingerBtn.hidden = false;
    })
    .catch(() => {});

  page.replaceChildren(
    ...[
      open ? h("p", { class: "settings-profile-line", text: walletLabel(open) }) : null,
      h("p", { class: "auth-lead", text: "Your password, to see this wallet's recovery phrase." }),
      ...pwd.els,
      err.el,
      btn,
      fingerBtn,
    ].filter(Boolean)
  );
  return Object.assign([subnav({ title: "Recovery phrase", onBack: () => backToSettings(state, actions) }), page], { busy: () => busy && state.context === asked });
}

/** A new password for every wallet here: the current one, then the new one twice. */
export function changePasswordView(ov, { state, actions } = {}) {
  const current = passwordField({ label: "Current password", placeholder: "The password you unlock with", onEnter: () => next.input.focus() });
  // The new one, twice, apart from the current one (FormControls.js).
  const next = newPasswordField({ caption: "New password", placeholder: "At least 8 characters", onEnter: () => again.input.focus() });
  const again = newPasswordField({ caption: "Confirm password", placeholder: "The same password again", onEnter: () => btn.click() });
  const err = formError();
  const fields = [current, next, again];

  let busy = false;
  const btn = h("button", {
    class: "btn-primary btn-full",
    type: "button",
    text: "Change password",
    onclick: async () => {
      if (busy) return;
      err.show("");
      for (const f of fields) f.error.show("");
      if (!current.input.value) {
        current.error.show("Enter your password.");
        current.input.focus();
        return;
      }
      if (next.input.value.length < 8) {
        next.error.show("Use at least 8 characters.");
        next.input.focus();
        return;
      }
      if (next.input.value !== again.input.value) {
        again.error.show("The passwords don't match.");
        again.input.focus();
        return;
      }
      if (next.input.value === current.input.value) {
        next.error.show("Use a different password from the current one.");
        next.input.focus();
        return;
      }
      busy = true;
      btn.disabled = true;
      for (const f of fields) f.input.disabled = true;
      btn.textContent = "Changing…";
      try {
        const newPassword = next.input.value;
        const res = await actions?.send?.({ type: "DUSK_UI_CHANGE_PASSWORD", password: current.input.value, newPassword });
        if (res?.error) throw new Error(res.error.message ?? "Couldn't change the password");
        for (const f of fields) f.input.value = "";
        actions?.showToast?.("Password changed.");
        backToSettings(state, actions);
        // Fingerprint unlock kept the old password: it keeps the new one, after a fingerprint, or it's off.
        if ((await fingerprintStatus()).on) {
          const on = await turnFingerprintOn(newPassword);
          if (!on.ok) actions?.showToast?.("Fingerprint unlock is off. Turn it on again in Settings.", 3000);
        }
      } catch (e) {
        const message = e?.message ?? String(e);
        if (passwordRefusal(message)) current.error.show(message);
        else err.show(message);
        busy = false;
        btn.disabled = false;
        for (const f of fields) f.input.disabled = false;
        btn.textContent = "Change password";
      }
    },
  });

  return Object.assign([
    subnav({ title: "Change password", onBack: () => backToSettings(state, actions) }),
    h("div", { class: "row onboard-form" }, [
      h("p", { class: "auth-lead", text: "Every recovery phrase here is encrypted again with the new password." }),
      passwordForm(current.els),
      passwordForm([...next.els, ...again.els]),
      err.el,
      btn,
    ]),
  ], { busy: () => busy });
}

/**
 * The password again on any send above an amount chosen, off until it's turned
 * on. Every change takes the password, as turning it off in a wallet left
 * unlocked would otherwise undo it: the wallet checks it against the vault.
 */
export function sendPasswordView(ov, { state, actions } = {}) {
  const limit = ov?.sendPasswordLimit ?? null;
  const on = h("input", { type: "checkbox", id: "send-password-on", checked: limit !== null });
  const amount = decimalInput({ id: "send-password-amount", value: limit === null ? "" : formatLuxForInput(limit), onEnter: () => btn.click() });
  const amountError = fieldError(amount);
  amount.addEventListener("input", () => amountError.show(""));
  const pwd = unlockPasswordField({ onEnter: () => btn.click() });
  const err = formError();
  const amountRow = h("div", { class: "onboard-form send-password-amount" }, [fieldLabel(amount, "Above this amount, in DUSK"), amount, amountError.el]);
  const passwordRow = h("div", { class: "onboard-form" }, pwd.els);
  let busy = false;
  const btn = h("button", { class: "btn-primary btn-full", type: "button" });
  const drawChoice = () => {
    amountRow.hidden = !on.checked;
    btn.textContent = on.checked ? "Save" : "Turn off";
    // Off, and it was off: there's nothing to save.
    btn.hidden = !on.checked && limit === null;
    passwordRow.hidden = btn.hidden;
  };
  on.addEventListener("change", drawChoice);
  btn.addEventListener("click", async () => {
    if (busy) return;
    err.show("");
    amountError.show("");
    pwd.error.show("");
    let limitLux = null;
    if (on.checked) {
      try {
        limitLux = parseDuskToLux(String(amount.value ?? "").trim());
      } catch {
        limitLux = "";
      }
      if (!String(amount.value ?? "").trim() || !limitLux) {
        amountError.show(`Enter an amount such as 100 or ${amountForInput("100.5")}. 0 asks on every send.`);
        amount.focus();
        return;
      }
    }
    if (!pwd.input.value) {
      pwd.error.show("Enter your password.");
      pwd.input.focus();
      return;
    }
    busy = true;
    btn.disabled = true;
    pwd.input.disabled = true;
    const text = btn.textContent;
    btn.textContent = "Checking…";
    try {
      const res = await actions?.send?.({ type: "DUSK_UI_SET_SEND_PASSWORD", password: pwd.input.value, limitLux });
      pwd.input.value = "";
      if (res?.error) throw new Error(res.error.message ?? "Couldn't save it");
      // Shown at once: the overview read again says the same.
      for (const shown of [state.overview, ov]) if (shown) shown.sendPasswordLimit = limitLux;
      actions?.showToast?.("Saved.");
      state.needsRefresh = true;
      backToSettings(state, actions);
    } catch (e) {
      const message = e?.message ?? String(e);
      if (passwordRefusal(message)) pwd.error.show(/^Incorrect/.test(message) ? "Wrong password." : message);
      else err.show(message);
      busy = false;
      btn.disabled = false;
      pwd.input.disabled = false;
      btn.textContent = text;
    }
  });
  drawChoice();
  return Object.assign([
    subnav({ title: "Password on big sends", onBack: () => backToSettings(state, actions) }),
    h("div", { class: "row onboard-form" }, [
      h("label", { class: "settings-switch", for: "send-password-on" }, [on, h("span", { text: "Ask for the password on big sends" })]),
      h("p", {
        class: "settings-note",
        // In the app no site asks for anything.
        text: `On sends, stakes${isExtensionRuntime() ? ", shielding and what sites ask" : " and shielding"}, network fee included. A token's transfer, or a contract the wallet doesn't know, asks on any amount.`,
      }),
      amountRow,
      passwordRow,
      err.el,
      btn,
    ]),
  ], { busy: () => busy });
}
