// Settings' screens for the wallets here: removing one, and a new password
// for all of them. Each asks for the password, says under its field what's
// wrong, and goes back to Settings once done.

import { walletLabel } from "../../../shared/wallets.js";
import { h } from "../../lib/dom.js";
import { shortAddress } from "../../lib/strings.js";
import { fieldError, fieldLabel, passwordInput } from "../../components/FormControls.js";
import { subnav } from "../../components/Subnav.js";
import { switchContext } from "../context.js";

// A wrong password, or one that has to wait, is said under the password.
const passwordRefusal = (message) => /^Incorrect password$|^Too many attempts/.test(String(message ?? ""));

function passwordField({ label = "Password", placeholder = "Your current password", autocomplete = "current-password", onEnter }) {
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
  const pwd = passwordField({ onEnter: () => btn.click() });
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

/** A new password for every wallet here: the current one, then the new one twice. */
export function changePasswordView(ov, { state, actions } = {}) {
  const current = passwordField({ label: "Current password", placeholder: "The password you unlock with", onEnter: () => next.input.focus() });
  const next = passwordField({ label: "New password", placeholder: "At least 8 characters", autocomplete: "new-password", onEnter: () => again.input.focus() });
  const again = passwordField({ label: "Confirm password", placeholder: "The same password again", autocomplete: "new-password", onEnter: () => btn.click() });
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
      busy = true;
      btn.disabled = true;
      for (const f of fields) f.input.disabled = true;
      btn.textContent = "Changing…";
      try {
        const res = await actions?.send?.({ type: "DUSK_UI_CHANGE_PASSWORD", password: current.input.value, newPassword: next.input.value });
        if (res?.error) throw new Error(res.error.message ?? "Couldn't change the password");
        for (const f of fields) f.input.value = "";
        actions?.showToast?.("Password changed.");
        backToSettings(state, actions);
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
      ...fields.flatMap((f) => f.els),
      err.el,
      btn,
    ]),
  ], { busy: () => busy });
}
