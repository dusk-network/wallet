import "../../../shared/bufferGlobal.js";
import { entropyToMnemonic, validateMnemonic } from "bip39";
import { bytesToHex } from "../../../shared/bytes.js";
import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { normalizeMnemonic } from "../../lib/strings.js";
import { checkboxInput, fieldError, fieldLabel, groupLabel, passwordInput } from "../../components/FormControls.js";
import { createMnemonicInput } from "../../components/MnemonicInput.js";
import { subnav } from "../../components/Subnav.js";
import { iconSvg } from "../../components/ActionIcon.js";

function generateMnemonic12() {
  const entropy = new Uint8Array(16);
  crypto.getRandomValues(entropy);
  return entropyToMnemonic(bytesToHex(entropy));
}

async function showPersistedVault(state, actions) {
  const status = await actions?.send?.({ type: "DUSK_UI_STATUS" }).catch(() => null);
  if (!status?.hasVault) return false;
  state.onboard = { mode: null, mnemonic: null, password: "", reveal: false };
  state.route = "home";
  state.needsRefresh = true;
  await actions?.render?.({ forceRefresh: true });
  return true;
}

function srpGridEl(mnemonic, { blurred = false } = {}) {
  const words = normalizeMnemonic(mnemonic)
    .split(" ")
    .filter(Boolean);

  const grid = h(
    "div",
    { class: `srp-grid ${blurred ? "srp-grid--blur" : ""}`.trim() },
    words.map((w, i) =>
      h("div", { class: "srp-word" }, [
        h("div", { class: "srp-word-index", text: String(i + 1) }),
        h("div", { class: "srp-word-text", text: w }),
      ])
    )
  );

  return h("div", { class: "box srp-box" }, [grid]);
}

// A new password and its repeat, each with its error under it.
function newPasswordFields({ onDone, label = "Password" }) {
  const pwd = passwordInput({
    placeholder: "At least 8 characters",
    autocomplete: "new-password",
    onEnter: () => pwd2.focus(),
  });
  const pwd2 = passwordInput({
    placeholder: "The same password again",
    autocomplete: "new-password",
    onEnter: () => onDone?.(),
  });
  const pwdError = fieldError(pwd);
  const pwd2Error = fieldError(pwd2);
  pwd.addEventListener("input", () => pwdError.show(""));
  pwd2.addEventListener("input", () => pwd2Error.show(""));
  return {
    pwd,
    pwd2,
    els: [fieldLabel(pwd, label), pwd, pwdError.el, fieldLabel(pwd2, "Confirm password"), pwd2, pwd2Error.el],
    // The password, or null after saying what's wrong with it.
    read() {
      pwdError.show("");
      pwd2Error.show("");
      if ((pwd.value || "").length < 8) {
        pwdError.show("Use at least 8 characters.");
        pwd.focus();
        return null;
      }
      if (pwd.value !== pwd2.value) {
        pwd2Error.show("The passwords don't match.");
        pwd2.focus();
        return null;
      }
      return pwd.value;
    },
  };
}

// An error for the whole form, above its button.
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

export function onboardingWelcomeView({ state, actions } = {}) {
  const choice = (icon, title, sub, route, mode) =>
    h(
      "button",
      {
        class: "list-row onboard-choice",
        type: "button",
        onclick: () => {
          state.onboard.mode = mode;
          state.onboard.mnemonic = null;
          state.onboard.password = "";
          state.onboard.reveal = false;
          state.route = route;
          actions?.render?.().catch(() => {});
        },
      },
      [
        h("span", { class: "row-icon", "aria-hidden": "true", html: iconSvg(icon) }),
        h("span", { class: "row-main" }, [
          h("span", { class: "row-title", text: title }),
          h("span", { class: "row-sub", text: sub }),
        ]),
        h("span", { class: "row-chev", "aria-hidden": "true", html: iconSvg("chev-r") }),
      ]
    );

  return [
    h("div", { class: "auth-page" }, [
      h("h1", { class: "auth-title", text: "Set up your Dusk Wallet" }),
      h("p", {
        class: "auth-lead",
        text: "Your recovery phrase is the only way to restore your wallet. Keep it safe.",
      }),
      h("div", { class: "group onboard-choices" }, [
        choice("create", "Create wallet", "Get a new recovery phrase", "onboard_create_password", "create"),
        choice("import", "Import wallet", "Use a recovery phrase you have", "onboard_import", "import"),
      ]),
    ]),
  ];
}

export function onboardingCreatePasswordView({ state, actions } = {}) {
  const fields = newPasswordFields({ onDone: () => (agree.checked ? next.click() : agree.focus()) });
  const agree = checkboxInput({ onEnter: () => next.click() });
  const agreeError = fieldError(agree);
  agree.addEventListener("change", () => agreeError.show(""));
  const err = formError();

  const next = h("button", {
    class: "btn-primary btn-full",
    type: "button",
    text: "Continue",
    onclick: async () => {
      try {
        err.show("");
        agreeError.show("");
        const password = fields.read();
        if (password == null) return;
        if (!agree.checked) {
          agreeError.show("Tick this to go on.");
          agree.focus();
          return;
        }

        state.onboard.password = password;
        state.onboard.mnemonic = generateMnemonic12();
        state.onboard.reveal = false;
        state.route = "onboard_create_phrase";
        await actions?.render?.();
      } catch (e) {
        err.show(e?.message ?? String(e));
      }
    },
  });
  return [
    subnav({
      title: "Create wallet",
      onBack: () => {
        state.route = "onboard_welcome";
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row onboard-form" }, [
      h("p", { class: "auth-lead", text: "The password unlocks your wallet on this device." }),
      ...fields.els,
      h("label", { class: "checkline" }, [
        agree,
        h("span", { text: "I understand that my recovery phrase is the only way to restore this wallet." }),
      ]),
      agreeError.el,
      err.el,
      next,
    ]),
  ];
}

export function onboardingCreatePhraseView({ state, actions } = {}) {
  const mnemonic = state.onboard.mnemonic;
  if (!mnemonic) {
    state.route = "onboard_create_password";
    return onboardingCreatePasswordView({ state, actions });
  }

  const toggle = h("button", {
    class: "mini-btn",
    type: "button",
    text: state.onboard.reveal ? "Hide" : "Reveal",
    onclick: () => {
      state.onboard.reveal = !state.onboard.reveal;
      actions?.render?.().catch(() => {});
    },
  });

  // Copy waits for Reveal: it can't be pressed before.
  const copyBtn = h("button", {
    class: "mini-btn",
    type: "button",
    text: "Copy",
    disabled: !state.onboard.reveal,
    title: state.onboard.reveal ? undefined : "Reveal the phrase first",
    onclick: async () => {
      if (!state.onboard.reveal) return;
      const ok = await copyToClipboard(mnemonic);
      actions?.showToast?.(ok ? "Copied recovery phrase" : "Copy failed");
    },
  });

  const next = h("button", {
    class: "btn-primary btn-full",
    type: "button",
    text: "I wrote it down",
    onclick: () => {
      state.route = "onboard_create_confirm";
      actions?.render?.().catch(() => {});
    },
  });

  return [
    subnav({
      title: "Recovery phrase",
      onBack: () => {
        state.route = "onboard_create_password";
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row onboard-form" }, [
      h("p", { class: "auth-lead", text: "Write down these 12 words in order and keep them somewhere safe." }),
      h("p", { class: "phrase-warning", text: "Never share your recovery phrase. Anyone with it can take your funds." }),
      srpGridEl(mnemonic, { blurred: !state.onboard.reveal }),
      h("div", { class: "phrase-tools" }, [toggle, copyBtn]),
      next,
    ]),
  ];
}

export function onboardingCreateConfirmView({ state, actions } = {}) {
  const mnemonic = state.onboard.mnemonic;
  if (!mnemonic) {
    state.route = "onboard_welcome";
    return onboardingWelcomeView({ state, actions });
  }

  const expectedWordCount = normalizeMnemonic(mnemonic).split(" ").filter(Boolean).length || 12;
  let createBtn;
  const confirmInput = createMnemonicInput({
    wordCount: expectedWordCount,
    allowWordCountToggle: false,
    onComplete: () => createBtn?.click(),
  });
  const phraseError = fieldError(confirmInput.el, { markInvalid: false });
  const err = formError();

  // While the wallet is made: one line that says what happens.
  const busyBody = h("p", { class: "auth-note", style: "display:none", text: "Encrypting your wallet. Keep this window open." });

  const nav = subnav({
    title: "Confirm",
    onBack: () => {
      // Back is disabled while the vault is being created,
      // as vault creation continues in the background.
      state.route = "onboard_create_phrase";
      actions?.render?.().catch(() => {});
    },
  });
  const backBtn = nav.querySelector("button");

  let busy = false;
  const setBusy = (isBusy, msg) => {
    busy = Boolean(isBusy);
    if (msg) busyBody.textContent = String(msg);

    // Disable interactions to prevent multiple Stronghold writes.
    // These are very system heavy.
    confirmInput.setDisabled(busy);
    if (backBtn) backBtn.disabled = busy;
    if (createBtn) {
      createBtn.disabled = busy;
      createBtn.textContent = busy ? "Creating…" : "Create wallet";
    }
    busyBody.style.display = busy ? "block" : "none";
  };

  createBtn = h("button", {
    class: "btn-primary btn-full",
    type: "button",
    text: "Create wallet",
    onclick: async () => {
      try {
        if (busy) return;
        err.show("");
        phraseError.show("");

        const typed = confirmInput.getMnemonic();
        const expected = normalizeMnemonic(mnemonic);
        if (typed !== expected) {
          phraseError.show(typed ? "The words don't match your recovery phrase." : "Enter your recovery phrase.");
          return;
        }

        const password = state.onboard.password;
        if (!password) throw new Error("Go back and set your password again.");

        setBusy(true, "Encrypting your wallet. Keep this window open.");
        const res = await actions?.send?.({
          type: "DUSK_UI_CREATE_WALLET",
          mnemonic: expected,
          password,
        });
        if (res?.error) throw new Error(res.error.message ?? "Failed to create wallet");

        // Fresh wallet: set a shielded checkpoint to "now" so we don't have to
        // sync shielded notes from genesis. This is best-effort.
        try {
          await actions?.send?.({ type: "DUSK_UI_SET_SHIELDED_CHECKPOINT_NOW" });
        } catch {
          // ignore
        }

        state.onboard = { mode: null, mnemonic: null, password: "", reveal: false };
        state.route = "home";
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      } catch (e) {
        if (await showPersistedVault(state, actions)) return;
        err.show(e?.message ?? String(e));
        setBusy(false);
      }
    },
  });

  return [
    nav,
    h("div", { class: "row onboard-form" }, [
      h("p", { class: "auth-lead", text: "Enter the words you wrote down." }),
      groupLabel(confirmInput.el, "Recovery phrase"),
      confirmInput.el,
      phraseError.el,
      err.el,
      createBtn,
      busyBody,
    ]),
  ];
}

// A recovery phrase and a new password, for Import wallet and for a restore
// in place of the wallet here: what's wrong with the phrase under it, with
// the password under each field, then one message to the wallet.
function phraseForm({ state, actions, title, lead = "", passwordLabel, verb, busyVerb, type, onBack }) {
  const mnemonicInput = createMnemonicInput({
    wordCount: 12,
    allowWordCountToggle: true,
    onComplete: () => fields.pwd.focus(),
  });
  const phraseError = fieldError(mnemonicInput.el, { markInvalid: false });
  const fields = newPasswordFields({ onDone: () => btn.click(), label: passwordLabel });
  const err = formError();

  const busyBody = h("p", { class: "auth-note", style: "display:none", text: "Encrypting your wallet. Keep this window open." });

  const nav = subnav({ title, onBack });
  const backBtn = nav.querySelector("button");

  let busy = false;
  let btn;
  const setBusy = (isBusy) => {
    busy = Boolean(isBusy);
    mnemonicInput.setDisabled(busy);
    fields.pwd.disabled = busy;
    fields.pwd2.disabled = busy;
    if (backBtn) backBtn.disabled = busy;
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? busyVerb : verb;
    }
    busyBody.style.display = busy ? "block" : "none";
  };

  // The phrase, or null after saying what's wrong with it.
  const readPhrase = () => {
    phraseError.show("");
    const m = mnemonicInput.getMnemonic();
    const words = m.split(" ").filter(Boolean);
    const problem = !m || words.length === 0
      ? "Enter your recovery phrase."
      : words.length !== 12 && words.length !== 24
      ? "A recovery phrase has 12 or 24 words."
      : !validateMnemonic(m)
      ? "That isn't a valid recovery phrase. Check each word."
      : "";
    if (problem) {
      phraseError.show(problem);
      return null;
    }
    return m;
  };

  btn = h("button", {
    class: "btn-primary btn-full",
    type: "button",
    text: verb,
    onclick: async () => {
      try {
        if (busy) return;
        err.show("");
        const m = readPhrase();
        if (m == null) return;
        const password = fields.read();
        if (password == null) return;

        setBusy(true);
        const res = await actions?.send?.({ type, mnemonic: m, password });
        if (res?.error) throw new Error(res.error.message ?? `Couldn't ${verb.toLowerCase()}`);

        state.onboard = { mode: null, mnemonic: null, password: "", reveal: false };
        state.route = "home";
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      } catch (e) {
        // An import that made its vault before it failed opens that wallet; a
        // restore keeps one either way, so it says what went wrong.
        if (type === "DUSK_UI_CREATE_WALLET" && (await showPersistedVault(state, actions))) return;
        err.show(e?.message ?? String(e));
        setBusy(false);
      }
    },
  });
  return [
    nav,
    h("div", { class: "row onboard-form" }, [
      lead ? h("p", { class: "auth-lead", text: lead }) : null,
      groupLabel(mnemonicInput.el, "Recovery phrase"),
      mnemonicInput.el,
      phraseError.el,
      ...fields.els,
      err.el,
      btn,
      busyBody,
    ].filter(Boolean)),
  ];
}

export function onboardingImportView({ state, actions } = {}) {
  return phraseForm({
    state,
    actions,
    title: "Import wallet",
    verb: "Import wallet",
    busyVerb: "Importing…",
    type: "DUSK_UI_CREATE_WALLET",
    onBack: () => {
      state.route = "onboard_welcome";
      actions?.render?.().catch(() => {});
    },
  });
}

/**
 * A forgotten password: the wallet restored from its recovery phrase in
 * place of the one here, with a new password. It says first what that does;
 * Back returns to the unlock form.
 */
export function restoreWalletView({ state, actions } = {}) {
  return phraseForm({
    state,
    actions,
    title: "Restore wallet",
    lead: "This removes the wallet from this browser and sets it up again with a new password. Contacts stay if it's the same wallet.",
    passwordLabel: "New password",
    verb: "Restore wallet",
    busyVerb: "Restoring…",
    type: "DUSK_UI_RESTORE_WALLET",
    onBack: () => {
      state.route = "home";
      actions?.render?.().catch(() => {});
    },
  });
}
