import { entropyToMnemonic, validateMnemonic } from "bip39";
import { bytesToHex } from "../../../shared/bytes.js";
import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { normalizeMnemonic } from "../../lib/strings.js";
import { bannerView } from "../../components/Banner.js";
import { createMnemonicInput } from "../../components/MnemonicInput.js";
import { subnav } from "../../components/Subnav.js";

function generateMnemonic12() {
  const entropy = new Uint8Array(16);
  crypto.getRandomValues(entropy);
  return entropyToMnemonic(bytesToHex(entropy));
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

export function onboardingWelcomeView({ state, actions } = {}) {
  const createBtn = h(
    "button",
    {
      class: "action-card",
      onclick: () => {
        state.onboard.mode = "create";
        state.onboard.mnemonic = null;
        state.onboard.password = "";
        state.onboard.reveal = false;
        state.route = "onboard_create_password";
        actions?.render?.().catch(() => {});
      },
    },
    [
      h("div", { class: "action-icon", text: "✨" }),
      h("div", { class: "action-title", text: "Create wallet" }),
    ]
  );

  const importBtn = h(
    "button",
    {
      class: "action-card",
      onclick: () => {
        state.onboard.mode = "import";
        state.onboard.mnemonic = null;
        state.onboard.password = "";
        state.onboard.reveal = false;
        state.route = "onboard_import";
        actions?.render?.().catch(() => {});
      },
    },
    [
      h("div", { class: "action-icon", text: "⤒" }),
      h("div", { class: "action-title", text: "Import wallet" }),
    ]
  );

  return [
    bannerView(state.banner),
    h("div", { class: "row" }, [
      h("div", { class: "hero-title", text: "Set up your Dusk Wallet" }),
      h("div", {
        class: "muted",
        text:
          "Create a new wallet or import an existing recovery phrase. Your recovery phrase is the ONLY way to restore your wallet.",
      }),
    ]),
    h("div", { class: "actions" }, [createBtn, importBtn]),
    h("div", {
      class: "muted",
      text: "Tip: If you're just testing, you can create a new wallet and request funds from a faucet.",
    }),
  ].filter(Boolean);
}

export function onboardingCreatePasswordView({ state, actions } = {}) {
  const pwd = h("input", { type: "password", placeholder: "Create password (min 8 chars)" });
  const pwd2 = h("input", { type: "password", placeholder: "Confirm password" });
  const agree = h("input", { type: "checkbox" });

  const err = h("div", { class: "err", style: "display:none" });
  const setErr = (txt) => {
    if (!txt) {
      err.style.display = "none";
      err.textContent = "";
    } else {
      err.style.display = "block";
      err.textContent = txt;
    }
  };

  const next = h("button", {
    class: "btn-primary btn-full",
    text: "Continue",
    onclick: async () => {
      try {
        setErr("");
        if ((pwd.value || "").length < 8) throw new Error("Password must be at least 8 characters");
        if (pwd.value !== pwd2.value) throw new Error("Passwords do not match");
        if (!agree.checked)
          throw new Error("Please confirm you understand the recovery phrase is required");

        state.onboard.password = pwd.value;
        state.onboard.mnemonic = generateMnemonic12();
        state.onboard.reveal = false;
        state.route = "onboard_create_phrase";
        await actions?.render?.();
      } catch (e) {
        setErr(e?.message ?? String(e));
      }
    },
  });

  return [
    subnav({
      title: "Create",
      onBack: () => {
        state.route = "onboard_welcome";
        actions?.render?.().catch(() => {});
      },
    }),
    bannerView(state.banner),
    h("div", { class: "row" }, [
      h("div", {
        class: "muted",
        text: "Create a password to encrypt your wallet on this device.",
      }),
      h("label", { text: "Password" }),
      pwd,
      h("label", { text: "Confirm password" }),
      pwd2,
      h("label", { class: "checkline" }, [
        agree,
        h("span", {
          class: "muted",
          text: "I understand that my recovery phrase is the only way to restore this wallet.",
        }),
      ]),
      err,
      h("div", { class: "btnrow" }, [next]),
    ]),
  ].filter(Boolean);
}

export function onboardingCreatePhraseView({ state, actions } = {}) {
  const mnemonic = state.onboard.mnemonic;
  if (!mnemonic) {
    state.route = "onboard_create_password";
    return onboardingCreatePasswordView({ state, actions });
  }

  const toggle = h("button", {
    class: "btn-outline",
    text: state.onboard.reveal ? "Hide" : "Reveal",
    onclick: () => {
      state.onboard.reveal = !state.onboard.reveal;
      actions?.render?.().catch(() => {});
    },
  });

  const copyBtn = h("button", {
    class: "btn-outline",
    text: "Copy",
    onclick: async () => {
      if (!state.onboard.reveal) {
        actions?.showToast?.("Reveal first");
        return;
      }
      const ok = await copyToClipboard(mnemonic);
      actions?.showToast?.(ok ? "Copied recovery phrase" : "Copy failed");
    },
  });

  const next = h("button", {
    class: "btn-primary",
    text: "I wrote it down",
    onclick: () => {
      state.route = "onboard_create_confirm";
      actions?.render?.().catch(() => {});
    },
  });

  return [
    subnav({
      title: "Secret phrase",
      onBack: () => {
        state.route = "onboard_create_password";
        actions?.render?.().catch(() => {});
      },
    }),
    bannerView(state.banner),
    h("div", { class: "row" }, [
      h("div", {
        class: "muted",
        text: "Write down these 12 words in order and keep them somewhere safe.",
      }),
      h("div", { class: "callout warn" }, [
        h("div", { class: "callout-title", text: "Never share your recovery phrase" }),
        h("div", { class: "muted", text: "Anyone with this phrase can take your funds." }),
      ]),
      srpGridEl(mnemonic, { blurred: !state.onboard.reveal }),
      h("div", { class: "btnrow" }, [toggle, copyBtn, next]),
    ]),
  ].filter(Boolean);
}

export function onboardingCreateConfirmView({ state, actions } = {}) {
  const mnemonic = state.onboard.mnemonic;
  if (!mnemonic) {
    state.route = "onboard_welcome";
    return onboardingWelcomeView({ state, actions });
  }

  const expectedWordCount = normalizeMnemonic(mnemonic).split(" ").filter(Boolean).length || 12;
  const confirmInput = createMnemonicInput({
    wordCount: expectedWordCount,
    allowWordCountToggle: false,
  });

  const err = h("div", { class: "err", style: "display:none" });
  const setErr = (txt) => {
    if (!txt) {
      err.style.display = "none";
      err.textContent = "";
    } else {
      err.style.display = "block";
      err.textContent = txt;
    }
  };

  const busyTitle = h("div", { class: "callout-title", text: "Securing your wallet…" });
  const busyBody = h("div", {
    class: "muted",
    text: "Deriving an encryption key and writing your vault. Keep this window open.",
  });
  const busyCallout = h("div", { class: "callout", style: "display:none" }, [busyTitle, busyBody]);

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
  let createBtn;
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
    busyCallout.style.display = busy ? "block" : "none";
  };

  createBtn = h("button", {
    class: "btn-primary btn-full",
    text: "Create wallet",
    onclick: async () => {
      try {
        if (busy) return;
        setErr("");

        setBusy(true);

        const typed = confirmInput.getMnemonic();
        const expected = normalizeMnemonic(mnemonic);
        if (typed !== expected) throw new Error("Recovery phrase does not match");

        const password = state.onboard.password;
        if (!password) throw new Error("Missing password");

        busyBody.textContent = "Writing encrypted vault…";
        const res = await actions?.send?.({
          type: "DUSK_UI_CREATE_WALLET",
          mnemonic: expected,
          password,
        });
        if (res?.error) throw new Error(res.error.message ?? "Failed to create wallet");

        // Auto-unlock to match MetaMask onboarding UX
        busyBody.textContent = "Unlocking wallet…";
        const unlockRes = await actions?.send?.({ type: "DUSK_UI_UNLOCK", password });
        if (unlockRes?.error) throw new Error(unlockRes.error.message ?? "Unlock failed");

        busyBody.textContent = "Finalizing…";
        state.banner = null;
        state.onboard = { mode: null, mnemonic: null, password: "", reveal: false };
        state.route = "home";
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      } catch (e) {
        setErr(e?.message ?? String(e));
        setBusy(false);
      }
    },
  });

  return [
    nav,
    bannerView(state.banner),
    h("div", { class: "row" }, [
      h("div", {
        class: "muted",
        text: "Confirm your recovery phrase to finish setting up your wallet.",
      }),
      h("label", { text: "Recovery phrase" }),
      confirmInput.el,
      busyCallout,
      err,
      h("div", { class: "btnrow" }, [createBtn]),
    ]),
  ].filter(Boolean);
}

export function onboardingImportView({ state, actions } = {}) {
  const mnemonicInput = createMnemonicInput({
    wordCount: 12,
    allowWordCountToggle: true,
  });
  const pwd = h("input", { type: "password", placeholder: "Create password (min 8 chars)" });
  const pwd2 = h("input", { type: "password", placeholder: "Confirm password" });

  const err = h("div", { class: "err", style: "display:none" });
  const setErr = (txt) => {
    if (!txt) {
      err.style.display = "none";
      err.textContent = "";
    } else {
      err.style.display = "block";
      err.textContent = txt;
    }
  };

  const busyTitle = h("div", { class: "callout-title", text: "Securing your wallet…" });
  const busyBody = h("div", {
    class: "muted",
    text: "Deriving an encryption key and writing your vault. Keep this window open.",
  });
  const busyCallout = h("div", { class: "callout", style: "display:none" }, [busyTitle, busyBody]);

  const nav = subnav({
    title: "Import",
    onBack: () => {
      state.route = "onboard_welcome";
      actions?.render?.().catch(() => {});
    },
  });
  const backBtn = nav.querySelector("button");

  let busy = false;
  let btn;
  const setBusy = (isBusy, msg) => {
    busy = Boolean(isBusy);
    if (msg) busyBody.textContent = String(msg);
    mnemonicInput.setDisabled(busy);
    pwd.disabled = busy;
    pwd2.disabled = busy;
    if (backBtn) backBtn.disabled = busy;
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? "Importing…" : "Import wallet";
    }
    busyCallout.style.display = busy ? "block" : "none";
  };

  btn = h("button", {
    class: "btn-primary btn-full",
    text: "Import wallet",
    onclick: async () => {
      try {
        if (busy) return;
        setErr("");

        setBusy(true);

        const m = mnemonicInput.getMnemonic();
        const words = m.split(" ").filter(Boolean);
        if (!m || words.length === 0) throw new Error("Mnemonic is required");
        if (words.length !== 12 && words.length !== 24)
          throw new Error("Mnemonic must be 12 or 24 words");
        if (!validateMnemonic(m)) throw new Error("Invalid mnemonic");
        if ((pwd.value || "").length < 8) throw new Error("Password must be at least 8 characters");
        if (pwd.value !== pwd2.value) throw new Error("Passwords do not match");

        busyBody.textContent = "Writing encrypted vault…";
        const res = await actions?.send?.({
          type: "DUSK_UI_CREATE_WALLET",
          mnemonic: m,
          password: pwd.value,
        });
        if (res?.error) throw new Error(res.error.message ?? "Failed to import wallet");

        busyBody.textContent = "Unlocking wallet…";
        const unlockRes = await actions?.send?.({ type: "DUSK_UI_UNLOCK", password: pwd.value });
        if (unlockRes?.error) throw new Error(unlockRes.error.message ?? "Unlock failed");

        busyBody.textContent = "Finalizing…";
        state.banner = null;
        state.onboard = { mode: null, mnemonic: null, password: "", reveal: false };
        state.route = "home";
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      } catch (e) {
        setErr(e?.message ?? String(e));
        setBusy(false);
      }
    },
  });

  return [
    nav,
    bannerView(state.banner),
    h("div", { class: "row" }, [
      h("div", {
        class: "muted",
        text: "Import an existing recovery phrase to restore your wallet.",
      }),
      h("label", { text: "Mnemonic" }),
      mnemonicInput.el,
      h("label", { text: "Password" }),
      pwd,
      h("label", { text: "Confirm password" }),
      pwd2,
      busyCallout,
      err,
      h("div", { class: "btnrow" }, [btn]),
    ]),
  ].filter(Boolean);
}
