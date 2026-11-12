import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { h } from "../../lib/dom.js";
import { normalizeMnemonic } from "../../lib/strings.js";
import { nextWalletNumber, walletLabel } from "../../../shared/wallets.js";
import { checkboxInput, fieldError, groupLabel, newPasswordField, passwordForm, stepActions, unlockPasswordField } from "../../components/FormControls.js";
import { createMnemonicInput } from "../../components/MnemonicInput.js";
import { subnav } from "../../components/Subnav.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { copyButton } from "../../components/CopyButton.js";
import { askConfirm } from "../../components/ConfirmDialog.js";
import { fingerprintStatus, turnFingerprintOff, turnFingerprintOn } from "../../../platform/fingerprint.js";

function generateMnemonic12() {
  const entropy = new Uint8Array(16);
  crypto.getRandomValues(entropy);
  return entropyToMnemonic(entropy, wordlist);
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

/** A recovery phrase's words in their numbered places, blurred till Reveal where it's asked. */
export function srpGridEl(mnemonic, { blurred = false } = {}) {
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

// A new password and its repeat, each with its error under it, in a form of
// their own: none of them a sign-up's to Firefox for Android, which offers
// one of its own for that, over the field, and fills in a password nobody
// wrote down (FormControls.js).
function newPasswordFields({ onDone, label = "Password" }) {
  const first = newPasswordField({ caption: label, placeholder: "At least 8 characters", onEnter: () => pwd2.focus() });
  const again = newPasswordField({ caption: "Confirm password", placeholder: "The same password again", onEnter: () => onDone?.() });
  const { input: pwd, error: pwdError } = first;
  const { input: pwd2, error: pwd2Error } = again;
  return {
    pwd,
    pwd2,
    els: [passwordForm([...first.els, ...again.els])],
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

// The password that unlocks the wallets here, for adding another: one field,
// a line under it, and its error under that.
function currentPasswordField({ onDone }) {
  const { input: pwd, error, els } = unlockPasswordField({ onEnter: () => onDone?.() });
  return {
    pwd,
    els,
    show: (text) => error.show(text),
    // The password, or null after saying it's missing.
    read() {
      error.show("");
      if (!pwd.value) {
        error.show("Enter your password.");
        pwd.focus();
        return null;
      }
      return pwd.value;
    },
  };
}

// Under Create's and Import's titles in Add wallet: the wallet the phrase
// becomes, by the number the wallets here give the next one ("This becomes
// Wallet 3."), and `update` to say it again for the wallets here now.
function walletLanding(ov) {
  const el = h("p", { class: "auth-lead wallet-landing" });
  const update = (next) => {
    const wallets = Array.isArray(next?.wallets) ? next.wallets : [];
    el.textContent = wallets.length ? `This becomes ${walletLabel({ n: nextWalletNumber(wallets) })}.` : "";
    el.hidden = !wallets.length;
  };
  update(ov);
  return { el, update };
}

// A wallet couldn't be added: a wrong password, or one that has to wait, says
// so under the password; a phrase that's here already, under the phrase.
const passwordRefusal = (message) => /^Incorrect password$|^Too many attempts/.test(String(message ?? ""));
const phraseRefusal = (message) => /already in your wallet|isn't a valid recovery phrase/.test(String(message ?? ""));

// After a wallet is added: home, on the new wallet, with a toast.
async function addedWallet(state, actions) {
  state.onboard = { mode: null, mnemonic: null, password: "", reveal: false };
  state.route = "home";
  state.needsRefresh = true;
  actions?.showToast?.("Wallet added.");
  await actions?.render?.({ forceRefresh: true });
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

/**
 * Set up a wallet, or with `adding`, add another to the ones here: create or
 * import, as the same rows. Creating one beside others skips the password,
 * the one they share.
 */
export function onboardingWelcomeView({ state, actions, adding = false } = {}) {
  const choice = (icon, title, sub, route, mode) =>
    h(
      "button",
      {
        class: "list-row onboard-choice",
        type: "button",
        onclick: () => {
          state.onboard.mode = mode;
          state.onboard.adding = adding;
          // A new phrase keeps its words through Back and forward, for this
          // flow's whole length: someone may have written them down already.
          state.onboard.mnemonic = mode === "create" ? state.onboard.mnemonic || (adding ? generateMnemonic12() : null) : null;
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

  if (adding) {
    return [
      subnav({
        title: "Add wallet",
        onBack: () => {
          // Out of the flow, back where it was opened from: its words go.
          const from = state.onboard?.from;
          state.onboard = { mode: null, mnemonic: null, password: "", reveal: false };
          state.route = from || "home";
          actions?.render?.().catch(() => {});
        },
      }),
      h("div", { class: "row onboard-form" }, [
        h("p", { class: "auth-lead", text: "Your password unlocks every wallet here." }),
        h("div", { class: "group onboard-choices" }, [
          choice("create", "Create wallet", "Get a new recovery phrase", "wallet_add_phrase", "create"),
          choice("import", "Import wallet", "Use a recovery phrase you have", "wallet_add_import", "import"),
        ]),
      ]),
    ];
  }

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

// Unlock with fingerprint, offered beside the password where the phone can
// guard it with one (the app on Android): on, the fingerprint is asked once
// the wallet is made (fingerOnWith).
function fingerprintOffer(state) {
  const onboard = (state.onboard ??= {});
  const box = checkboxInput({ id: "onboard-fingerprint" });
  box.checked = onboard.fingerprint === true;
  box.addEventListener("change", () => {
    onboard.fingerprint = box.checked;
  });
  const el = h("label", { class: "checkline", hidden: true }, [box, h("span", { text: "Unlock with fingerprint" })]);
  fingerprintStatus().then(({ available }) => {
    if (available) el.hidden = false;
  });
  return { el, wanted: () => !el.hidden && box.checked };
}

// Turns fingerprint unlock on with the new wallet's password, where it was asked for.
function fingerOnWith(password, actions) {
  turnFingerprintOn(password)
    .then((on) => {
      if (on.ok) actions?.showToast?.("Fingerprint unlock is on.");
    })
    .catch(() => {});
}

export function onboardingCreatePasswordView({ state, actions } = {}) {
  const fields = newPasswordFields({ onDone: () => (agree.checked ? next.click() : agree.focus()) });
  const finger = fingerprintOffer(state);
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
        // The same words when this is Back and forward again.
        state.onboard.mnemonic ||= generateMnemonic12();
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
      finger.el,
      err.el,
      next,
    ]),
  ];
}

export function onboardingCreatePhraseView({ state, actions, adding = false, ov } = {}) {
  const mnemonic = state.onboard.mnemonic;
  if (!mnemonic) {
    if (adding) {
      state.route = "wallet_add";
      return onboardingWelcomeView({ state, actions, adding });
    }
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

  // Copy waits for Reveal: it can't be pressed before. It says Copied on itself.
  const copyBtn = copyButton({
    value: () => (state.onboard.reveal ? mnemonic : ""),
    label: "Copy",
    text: "Copy",
    className: "mini-btn",
    failText: "Copy failed",
    onFail: actions?.showToast,
    attrs: { disabled: !state.onboard.reveal, title: state.onboard.reveal ? undefined : "Reveal the phrase first" },
  });

  const next = h("button", {
    class: "btn-primary btn-full",
    type: "button",
    text: "I wrote it down",
    onclick: () => {
      state.route = adding ? "wallet_add_confirm" : "onboard_create_confirm";
      actions?.render?.().catch(() => {});
    },
  });

  return [
    subnav({
      title: "Recovery phrase",
      onBack: () => {
        state.route = adding ? "wallet_add" : "onboard_create_password";
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row onboard-form" }, [
      adding ? walletLanding(ov).el : null,
      h("p", { class: "auth-lead", text: "Write down these 12 words in order and keep them somewhere safe." }),
      h("p", { class: "phrase-warning", text: "Never share your recovery phrase. Anyone with it can take your funds." }),
      srpGridEl(mnemonic, { blurred: !state.onboard.reveal }),
      h("div", { class: "phrase-tools" }, [toggle, copyBtn]),
      // In view at the bottom however small the window, as Confirm is on a Review.
      stepActions(next),
    ].filter(Boolean)),
  ];
}

export function onboardingCreateConfirmView({ state, actions, adding = false } = {}) {
  const mnemonic = state.onboard.mnemonic;
  if (!mnemonic) {
    state.route = adding ? "wallet_add" : "onboard_welcome";
    return onboardingWelcomeView({ state, actions, adding });
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
  // Beside other wallets, the password they share, in place of a new one.
  const current = adding ? currentPasswordField({ onDone: () => createBtn?.click() }) : null;
  const verb = adding ? "Add wallet" : "Create wallet";

  // While the wallet is made: one line that says what happens.
  const busyBody = h("p", { class: "auth-note", style: "display:none", text: "Encrypting your wallet. Keep this window open." });

  const nav = subnav({
    title: "Confirm",
    onBack: () => {
      // Back is disabled while the vault is being created,
      // as vault creation continues in the background.
      state.route = adding ? "wallet_add_phrase" : "onboard_create_phrase";
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
    if (current) current.pwd.disabled = busy;
    if (backBtn) backBtn.disabled = busy;
    if (createBtn) {
      createBtn.disabled = busy;
      createBtn.textContent = busy ? (adding ? "Adding…" : "Creating…") : verb;
    }
    busyBody.style.display = busy ? "block" : "none";
  };

  createBtn = h("button", {
    class: "btn-primary btn-full",
    type: "button",
    text: verb,
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

        const password = adding ? current.read() : state.onboard.password;
        if (adding && password == null) return;
        if (!password) throw new Error("Go back and set your password again.");

        setBusy(true, "Encrypting your wallet. Keep this window open.");
        // A phrase made here (`fresh`): the wallet sets its shielded
        // checkpoint to now as it makes it, so it syncs no notes from genesis.
        const res = await actions?.send?.({
          type: adding ? "DUSK_UI_ADD_WALLET" : "DUSK_UI_CREATE_WALLET",
          mnemonic: expected,
          password,
          fresh: true,
        });
        if (adding) current.pwd.value = "";
        if (res?.error) throw new Error(res.error.message ?? "Failed to create wallet");

        if (adding) {
          await addedWallet(state, actions);
          return;
        }
        const finger = state.onboard?.fingerprint === true;
        state.onboard = { mode: null, mnemonic: null, password: "", reveal: false };
        state.route = "home";
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
        if (finger) fingerOnWith(password, actions);
      } catch (e) {
        const message = e?.message ?? String(e);
        if (adding) {
          if (passwordRefusal(message)) current.show(message);
          else if (phraseRefusal(message)) phraseError.show(message);
          else err.show(message);
          setBusy(false);
          return;
        }
        if (await showPersistedVault(state, actions)) return;
        err.show(message);
        setBusy(false);
      }
    },
  });

  // `busy`: the wallet being made, which the popup keeps the form through.
  return Object.assign([
    nav,
    h("div", { class: "row onboard-form" }, [
      h("p", { class: "auth-lead", text: "Enter the words you wrote down." }),
      groupLabel(confirmInput.el, "Recovery phrase"),
      confirmInput.el,
      phraseError.el,
      ...(current ? current.els : []),
      err.el,
      createBtn,
      busyBody,
    ]),
  ], { busy: () => busy });
}

// A recovery phrase and a new password, for Import wallet and for a restore
// in place of the wallet here: what's wrong with the phrase under it, with
// the password under each field, then one message to the wallet. `landing`:
// in Add wallet, the line that says which wallet the phrase becomes.
function phraseForm({ state, actions, title, lead = "", landing = null, passwordLabel, verb, busyVerb, type, onBack, adding = false }) {
  const mnemonicInput = createMnemonicInput({
    wordCount: 12,
    allowWordCountToggle: true,
    hint: "Paste the whole phrase into any box.",
    onComplete: () => fields.pwd.focus(),
    // After a paste, and as the focus leaves the words: what's wrong with them.
    // Typing again takes back what the button said of them too.
    onCheck: (text) => {
      phraseError.show(text);
      if (!text && phraseSaidAtButton) {
        phraseSaidAtButton = false;
        err.show("");
      }
    },
  });
  // Whether the button's line says what's wrong with the words.
  let phraseSaidAtButton = false;
  const phraseError = fieldError(mnemonicInput.el, { markInvalid: false });
  // Beside other wallets, the password they share; else a new one, twice.
  const fields = adding
    ? currentPasswordField({ onDone: () => btn.click() })
    : newPasswordFields({ onDone: () => btn.click(), label: passwordLabel });
  // A new password, a new wallet's or a restored one's: fingerprint unlock offered with it.
  const finger = adding ? null : fingerprintOffer(state);
  const err = formError();

  const busyBody = h("p", { class: "auth-note", style: "display:none", text: "Encrypting your wallet. Keep this window open." });

  // Back with words or a password typed asks first: leaving clears them.
  const typed = () => Boolean(mnemonicInput.getMnemonic() || fields.pwd.value || fields.pwd2?.value);
  const leave = async () => {
    if (typed() && !(await askConfirm({ title: "Go back?", text: "This clears the recovery phrase and password you typed.", action: "Go back", destructive: true }))) return;
    onBack();
  };
  const nav = subnav({ title, onBack: leave });
  const backBtn = nav.querySelector("button");
  // Its Back asks while something's typed: a phone's Back keeps an entry for
  // the question's own Back, which keeps what's typed (systemBack.js).
  const markAsks = () => (typed() ? backBtn?.setAttribute("data-back-asks", "") : backBtn?.removeAttribute("data-back-asks"));

  let busy = false;
  let btn;
  const setBusy = (isBusy) => {
    busy = Boolean(isBusy);
    mnemonicInput.setDisabled(busy);
    fields.pwd.disabled = busy;
    if (fields.pwd2) fields.pwd2.disabled = busy;
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
    const problem = m ? mnemonicInput.problem() : "Enter your recovery phrase.";
    if (problem) {
      phraseError.show(problem);
      // Said by the button too: on a phone the words are far above it.
      err.show(problem);
      phraseSaidAtButton = true;
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
        if (adding) fields.pwd.value = "";
        if (res?.error) throw new Error(res.error.message ?? `Couldn't ${verb.toLowerCase()}`);

        if (adding) {
          await addedWallet(state, actions);
          return;
        }
        state.onboard = { mode: null, mnemonic: null, password: "", reveal: false };
        state.route = "home";
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
        // A new password: fingerprint unlock with it where asked, and the old one's gone.
        if (finger?.wanted()) fingerOnWith(password, actions);
        else if (type === "DUSK_UI_RESTORE_WALLET") turnFingerprintOff().catch(() => {});
      } catch (e) {
        const message = e?.message ?? String(e);
        if (adding) {
          if (passwordRefusal(message)) fields.show(message);
          else if (phraseRefusal(message)) phraseError.show(message);
          else err.show(message);
          setBusy(false);
          return;
        }
        // An import that made its vault before it failed opens that wallet; a
        // restore keeps one either way, so it says what went wrong.
        if (type === "DUSK_UI_CREATE_WALLET" && (await showPersistedVault(state, actions))) return;
        err.show(message);
        setBusy(false);
      }
    },
  });
  // `busy`: the wallet being made, which the popup keeps the form through;
  // `landing`, to say again which wallet it becomes, as the form is kept.
  const form = h("div", { class: "row onboard-form" }, [
    landing?.el,
    lead ? h("p", { class: "auth-lead", text: lead }) : null,
    groupLabel(mnemonicInput.el, "Recovery phrase"),
    mnemonicInput.el,
    phraseError.el,
    ...fields.els,
    finger?.el,
    err.el,
    btn,
    busyBody,
  ].filter(Boolean));
  for (const type of ["input", "change"]) form.addEventListener(type, markAsks, true);
  // A phrase pasted whole goes into its boxes a moment on.
  form.addEventListener("paste", () => setTimeout(markAsks, 0), true);
  return Object.assign([nav, form], { busy: () => busy, landing: (ov) => landing?.update(ov) });
}

export function onboardingImportView({ state, actions, adding = false, ov } = {}) {
  return phraseForm({
    state,
    actions,
    adding,
    landing: adding ? walletLanding(ov) : null,
    title: "Import wallet",
    verb: "Import wallet",
    busyVerb: "Importing…",
    type: adding ? "DUSK_UI_ADD_WALLET" : "DUSK_UI_CREATE_WALLET",
    onBack: () => {
      state.route = adding ? "wallet_add" : "onboard_welcome";
      actions?.render?.().catch(() => {});
    },
  });
}

/**
 * A forgotten password: the wallet restored from its recovery phrase in
 * place of every one here, with a new password. It says first what that
 * does; Back returns to the unlock form.
 */
export function restoreWalletView({ state, actions } = {}) {
  return phraseForm({
    state,
    actions,
    title: "Restore wallet",
    lead: "This removes every recovery phrase on this device, then sets up this one with a new password. If it was here before, its contacts and profile names stay.",
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
