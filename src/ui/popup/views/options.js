import { NAME_SAVE_YES, profileNameCheck } from "@dusk-network/app-core/names";
import { networks } from "@dusk-network/networks";

import { formatDuskExact, formatFee } from "../../../shared/amount.js";
import { NETWORK_PRESETS } from "../../../shared/networkPresets.js";
import { detectPresetId, detectPresetIdFromNodeUrl } from "../../../shared/network.js";
import { endpointProblem } from "../../../shared/securityPolicy.js";
import { AUTO_LOCK_OPTIONS, SITE_LASTS_OPTIONS, normalizeCustomGas, normalizeSiteLasts } from "../../../shared/settings.js";
import { MAX_ACCOUNT_COUNT } from "../../../shared/constants.js";
import { setAccountName } from "../../../shared/accountNames.js";
import { siteLastSeen } from "../../../shared/siteRecords.js";
import { normalizeWalletName, walletLabel } from "../../../shared/wallets.js";
import { clearAddressBook, listAddressBook } from "../../../shared/addressBook.js";
import { duskNamesNetwork, lookupPrimaryName } from "../../../shared/duskNames.js";
import { networkForNode, networkTextOf } from "../../../shared/nodeNetwork.js";
import { openUrl, platform } from "../../../platform/index.js";
import { getExtensionApi } from "../../../platform/extensionApi.js";
import { isPhone, thisDevice } from "../../lib/device.js";
import { isTauriRuntime } from "../../../platform/runtime.js";
import { h } from "../../lib/dom.js";
import { shortAddress, siteName } from "../../lib/strings.js";
import { dateText } from "../../lib/time.js";
import { subnav } from "../../components/Subnav.js";
import { bracketTitle } from "../../components/BracketTitle.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { setNetworkSwitching } from "../../components/NetworkMenu.js";
import { fieldLabel, integerInput, passwordInput, textInput, urlInput } from "../../components/FormControls.js";
import { profileLabelOf } from "../../components/ProfileName.js";
import { fingerprintStatus, turnFingerprintOff, turnFingerprintOn } from "../../../platform/fingerprint.js";
import { switchContext } from "../context.js";
import { siteDetailsEl, siteLastUsedEl } from "./siteRecord.js";
import { resetKeptText } from "./wallets.js";

// Settings: the wallets, the profile, security, connected sites, contacts and
// the network, then Advanced (custom gas, Delete all contacts), Reset wallet
// on its own, and About: the version, and the terms of use and privacy policy.

const autoLockLabel = (minutes) =>
  AUTO_LOCK_OPTIONS.find((o) => o.value === minutes)?.label ?? `${minutes} minutes`;

// Settings' Unlock with fingerprint: the switch, and while it's being turned
// on, the password, checked against the vault, then the fingerprint.
function fingerprintRow({ actions }) {
  const fingerSwitch = h("input", { id: "fingerprint-unlock", type: "checkbox" });
  // A phone without a fingerprint yet: what to do first.
  const enrollNote = h("p", { class: "settings-note", id: "fingerprint-enroll", text: "Add a fingerprint in your phone's settings first.", hidden: true });
  const row = h("div", { class: "settings-fingerprint", hidden: true }, [
    h("label", { class: "settings-switch", for: "fingerprint-unlock" }, [fingerSwitch, h("span", { text: "Unlock with fingerprint" })]),
    enrollNote,
  ]);
  let ask = null;
  // A turning on under way, for the row: no switching nor another Turn on till it ends.
  let busy = false;
  const closeAsk = () => {
    ask?.remove();
    ask = null;
  };
  const openAsk = () => {
    const pwd = passwordInput({ id: "fingerprint-password", autocomplete: "current-password", onEnter: () => turnOn.click() });
    const error = h("div", { class: "field-error", id: "fingerprint-error", role: "alert", hidden: true });
    const sayError = (text) => {
      error.textContent = text || "";
      error.hidden = !text;
    };
    pwd.addEventListener("input", () => sayError(""));
    const turnOn = h("button", {
      class: "btn-outline",
      type: "button",
      text: "Turn on",
      onclick: async () => {
        if (busy) return;
        sayError("");
        const password = pwd.value;
        if (!password) return sayError("Enter your password.");
        busy = true;
        turnOn.disabled = true;
        fingerSwitch.disabled = true;
        try {
          const res = await actions?.send?.({ type: "DUSK_UI_CHECK_PASSWORD", password });
          if (res?.error) throw new Error(/^Incorrect password$/.test(String(res.error.message ?? "")) ? "Wrong password." : res.error.message);
          const on = await turnFingerprintOn(password);
          pwd.value = "";
          closeAsk();
          if (on.ok) return actions?.showToast?.("Fingerprint unlock is on.");
          fingerSwitch.checked = false;
          if (on.reason !== "password") actions?.showToast?.("Fingerprint unlock couldn't be turned on.", 2500);
        } catch (e) {
          sayError(e?.message ?? String(e));
        } finally {
          busy = false;
          turnOn.disabled = false;
          fingerSwitch.disabled = false;
        }
      },
    });
    ask = h("div", { class: "settings-fingerprint-ask" }, [fieldLabel(pwd, "Your password, to turn it on"), pwd, error, turnOn]);
    row.append(ask);
    pwd.focus?.();
  };
  fingerSwitch.addEventListener("change", async () => {
    // Turning on: it stays as it is till that ends.
    if (busy) {
      fingerSwitch.checked = true;
      return;
    }
    if (fingerSwitch.checked) return openAsk();
    closeAsk();
    await turnFingerprintOff();
    actions?.showToast?.("Fingerprint unlock is off.");
  });
  return row;
}

export function optionsView(ov, { state, actions } = {}) {
  const currentNodeUrl = String(ov?.nodeUrl ?? "").trim();
  const currentProverUrl = String(ov?.proverUrl ?? "").trim();
  const currentArchiverUrl = String(ov?.archiverUrl ?? "").trim();
  const currentAutoLock = Number(ov?.autoLockTimeoutMinutes ?? 15);
  const installedVersion = String(getExtensionApi()?.runtime?.getManifest?.()?.version ?? "").trim();
  const rerender = (opts) => actions?.render?.(opts)?.catch?.(() => {});
  // More than one wallet open: each connected site is named by its wallet.
  const several = ov?.isUnlocked && Array.isArray(ov?.wallets) && ov.wallets.length > 1;
  // More than one wallet in the vault, those another password opens too:
  // Lock and auto-lock lock them all, and say so.
  const lockAll = several || (ov?.isUnlocked && Number(ov?.walletsHere) > 1);

  const lockBtn = ov?.isUnlocked
    ? h("button", {
        class: "btn-outline",
        type: "button",
        text: lockAll ? "Lock" : "Lock wallet",
        onclick: async () => {
          switchContext(state, "lock");
          await actions?.send?.({ type: "DUSK_UI_LOCK" });
          state.route = "home";
          state.needsRefresh = true;
          await actions?.render?.({ forceRefresh: true });
        },
      })
    : null;

  // Each profile by its name as the header shows it: the verified .dusk name
  // once looked up, else its label on this device, with its short account.
  const accounts = Array.isArray(ov?.accounts) ? ov.accounts : [];
  const selectedAccountIndex = Number(ov?.selectedAccountIndex ?? 0) || 0;
  const accountCount = Math.min(MAX_ACCOUNT_COUNT, Math.max(1, Number(ov?.accountCount ?? (accounts.length || 1)) || 1));
  const displayAccounts = accounts.length ? accounts : Array.from({ length: accountCount }, () => "");
  const verified = new Map();
  const profileText = (i) => {
    const acct = String(displayAccounts[i] ?? "");
    const name = verified.get(i) || profileLabelOf(ov, i);
    return acct ? `${name} · ${shortAddress(acct)}` : name;
  };
  // Elements that name profile i, redrawn in place once its name is known.
  const namers = [];
  const named = (i, el, render = () => profileText(i)) => {
    namers.push({ i, el, render });
    el.textContent = render();
    return el;
  };
  if (duskNamesNetwork(ov?.nodeUrl)) {
    displayAccounts.forEach((acct, i) => {
      if (!acct) return;
      lookupPrimaryName(String(acct), { nodeUrl: ov?.nodeUrl, stale: true })
        ?.then?.((name) => {
          if (!name) return;
          verified.set(i, name);
          for (const n of namers) if (n.i === i) n.el.textContent = n.render();
        })
        ?.catch?.(() => {});
    });
  }

  const accountSelect = h(
    "select",
    { id: "account" },
    displayAccounts.map((_acct, i) => named(i, h("option", { value: String(i) })))
  );
  accountSelect.value = String(Math.max(0, Math.min(selectedAccountIndex, displayAccounts.length - 1)));
  accountSelect.addEventListener("change", async () => {
    try {
      switchContext(state);
      await actions?.send?.({ type: "DUSK_UI_SET_ACCOUNT_INDEX", index: Number(accountSelect.value) });
      actions?.showToast?.("Profile selected.");
      state.needsRefresh = true;
      await actions?.render?.({ forceRefresh: true });
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 2500);
    }
  });

  // Names only this device knows, one per profile. A name being typed
  // survives a redraw (a sync's status, another name saved): its field
  // starts from what was typed, and saves when it's left. A saved name
  // shows at once in the header's pill; Settings doesn't redraw for it.
  const walletId = ov?.isUnlocked && accounts.length ? String(accounts[0] ?? "").trim() : "";
  const nameMap = ov?.accountNames && typeof ov.accountNames === "object" ? ov.accountNames : {};
  // Each wallet's own: another wallet's fields start from its saved labels.
  const drafts = ((state.labelDrafts ??= {})[walletId] ??= {});
  const labelOf = (s) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, 32);
  // A profile's name can't be, or look like, another profile's or a contact's:
  // History would show the one as the other. Each profile by the name the header
  // shows; the contacts read once, when a name is first saved.
  let contactsRead = null;
  const contactsNow = () => {
    const ab = state?.addressBook;
    const own = ab?.loaded && Array.isArray(ab.items) && (!state?.contactsWallet || state.contactsWallet === walletId);
    contactsRead ??= own ? Promise.resolve(ab.items) : listAddressBook({ walletId }).catch(() => []);
    return contactsRead;
  };
  const labelsEditor =
    ov?.isUnlocked && walletId
      ? h("div", { class: "settings-labels" }, [
          h("h3", { class: "settings-subtitle", text: "Names on this device" }),
          ...displayAccounts.map((acct, i) => {
            let saved = labelOf(nameMap?.[String(i)]);
            const input = textInput({
              placeholder: "Name, only on this device",
              "aria-label": `Profile ${i + 1} name`,
              value: drafts[i] ?? saved,
            });
            // A name with what can't be seen in it could read as another's: it's refused, and said under its field.
            const error = h("div", { class: "field-error", id: `profile-name-error-${i}`, role: "alert", hidden: true });
            const showError = (text) => {
              error.textContent = text;
              error.hidden = !text;
              if (text) {
                input.setAttribute("aria-invalid", "true");
                input.setAttribute("aria-describedby", error.id);
              } else {
                input.removeAttribute("aria-invalid");
                input.removeAttribute("aria-describedby");
              }
            };
            // A .dusk name it is or starts as, a contact's, another profile's or any other,
            // or a contact's name it starts as, word for word, is asked about: the name is
            // saved only once the question is answered, with Yes, save it.
            const words = h("span", { class: "contact-note__words" });
            const yes = h("button", { class: "mini-btn contact-note__yes", type: "button", text: NAME_SAVE_YES });
            const question = h("div", { class: "send-self-note contact-note", role: "status", hidden: true }, [words, yes]);
            // The name the question shown is about.
            let asked = "";
            const ask = (text, label = "") => {
              words.textContent = text;
              question.hidden = !text;
              asked = text ? label : "";
            };
            input.addEventListener("input", () => {
              drafts[i] = input.value;
              showError("");
              ask("");
            });
            // A change and a blur as the field is left: one save.
            let saving = null;
            const save = () => (saving ??= saveName().finally(() => (saving = null)));
            const saveName = async () => {
              const value = input.value;
              const label = labelOf(value);
              if (label === saved) {
                if (drafts[i] === value) delete drafts[i];
                return;
              }
              // Asked already, as Yes is pressed and the field left: the answer saves it.
              if (label && label === asked) return;
              // The one check both wallets make at Save (app-core): refused, said under the
              // field; asked, said under it with Yes, save it, and saved only then. Each
              // profile by its label and its verified .dusk name; each contact by its name and
              // the .dusk name it was saved from.
              if (label) {
                const profiles = displayAccounts.map((account, j) => ({ account: String(account ?? ""), address: String(ov?.addresses?.[j] ?? ""), name: profileLabelOf(ov, j), duskName: verified.get(j) || undefined }));
                const said = profileNameCheck(label, { profiles, contacts: await contactsNow(), self: String(acct ?? "") });
                // Typed again meanwhile: what's said is of the name as it is now.
                if (input.value !== value) return;
                if (said?.refused) {
                  showError(said.words);
                  return;
                }
                if (said) {
                  ask(said.words, label);
                  return;
                }
              }
              await keep(value, label);
            };
            yes.addEventListener("click", () => {
              const value = input.value;
              if (!asked || labelOf(value) !== asked) return;
              ask("");
              keep(value, labelOf(value)).catch(() => {});
            });
            // The name kept on this device, with "Name saved.".
            const keep = async (value, label) => {
              const before = saved;
              saved = label;
              try {
                const map = await setAccountName(walletId, i, value);
                if (drafts[i] === value) delete drafts[i];
                const names =
                  map && typeof map === "object" ? { ...map } : { ...(state.overview?.accountNames ?? {}), [String(i)]: label };
                if (!label && !(map && typeof map === "object")) delete names[String(i)];
                // On the wallet they were typed for: another opened meanwhile keeps its own.
                if (state.overview?.accounts?.[0] === walletId) state.overview.accountNames = names;
                if (ov && ov !== state.overview) ov.accountNames = names;
                actions?.showToast?.("Name saved.");
                actions?.renderHeader?.();
              } catch (e) {
                saved = before;
                actions?.showToast?.(e?.message ?? String(e), 2500);
              }
            };
            // Left with Tab or a click, or Enter: whichever comes first saves.
            input.addEventListener("change", save);
            input.addEventListener("blur", save);
            const line = named(i, h("span", { class: "settings-profile-line" }), () =>
              [verified.get(i) || `Profile ${i + 1}`, acct ? shortAddress(String(acct)) : ""].filter(Boolean).join(" · ")
            );
            return h("div", { class: "settings-label" }, [line, input, error, question]);
          }),
        ])
      : null;

  // The wallets here, each by its name only this device knows, as the
  // switcher shows them, with Rename and, while there's another, Remove.
  // Rename opens a field for the name, with Save and Cancel (Enter and
  // Escape): what's typed survives a redraw (state.walletRename).
  const wallets = ov?.isUnlocked && Array.isArray(ov?.wallets) ? ov.wallets : [];
  const renaming = wallets.some((w) => w.key === state.walletRename?.key) ? state.walletRename : null;
  const focusLater = (id) => setTimeout(() => document.getElementById(id)?.focus?.(), 0);
  const walletRows = wallets.map((w) => {
    const label = walletLabel(w);
    if (renaming?.key !== w.key) {
      const rename = h("button", {
        class: "mini-btn",
        type: "button",
        id: `wallet-rename-${w.n}`,
        text: "Rename",
        "aria-label": `Rename ${label}`,
        onclick: async () => {
          state.walletRename = { key: w.key, draft: normalizeWalletName(w.name) };
          await actions?.render?.();
          focusLater(`wallet-name-${w.n}`);
        },
      });
      const remove =
        wallets.length > 1
          ? h("button", {
              class: "mini-btn",
              type: "button",
              text: "Remove",
              "aria-label": `Remove ${label}`,
              onclick: async () => {
                state.walletRemove = w.key;
                state.route = "wallet_remove";
                await actions?.render?.();
              },
            })
          : null;
      return h("div", { class: "settings-label settings-wallet" }, [
        h("div", { class: "settings-wallet__head" }, [
          h("span", { class: "settings-profile-line", text: label }),
          h("span", { class: "settings-wallet__actions" }, [rename, remove]),
        ]),
      ]);
    }

    const hintId = `wallet-name-hint-${w.n}`;
    const input = textInput({
      id: `wallet-name-${w.n}`,
      placeholder: `Wallet ${w.n}`,
      "aria-label": `${label} name`,
      "aria-describedby": hintId,
      value: renaming.draft ?? "",
    });
    input.addEventListener("input", () => {
      if (state.walletRename?.key === w.key) state.walletRename.draft = input.value;
    });
    const close = async () => {
      state.walletRename = null;
      await actions?.render?.();
      focusLater(`wallet-rename-${w.n}`);
    };
    let busy = false;
    const save = async () => {
      if (busy) return;
      busy = true;
      const name = normalizeWalletName(input.value);
      try {
        if (name !== normalizeWalletName(w.name)) {
          const res = await actions?.send?.({ type: "DUSK_UI_RENAME_WALLET", walletKey: w.key, name });
          if (res?.error) throw new Error(res.error.message ?? "Couldn't save the name");
          for (const shown of [state.overview, ov]) {
            const kept = shown?.wallets?.find?.((x) => x.key === w.key);
            if (kept) kept.name = name;
          }
          actions?.showToast?.("Name saved.");
          actions?.renderHeader?.();
        }
        await close();
      } catch (e) {
        busy = false;
        actions?.showToast?.(e?.message ?? String(e), 2500);
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault?.();
        save();
      } else if (e.key === "Escape") {
        e.preventDefault?.();
        e.stopPropagation?.();
        close();
      }
    });
    return h("div", { class: "settings-label settings-wallet settings-wallet--renaming" }, [
      fieldLabel(input, "Name"),
      h("div", { class: "settings-wallet__edit" }, [
        input,
        h("button", { class: "mini-btn", type: "button", text: "Save", "aria-label": `Save ${label}'s name`, onclick: save }),
        h("button", { class: "mini-btn", type: "button", text: "Cancel", onclick: close }),
      ]),
      h("p", { class: "settings-note", id: hintId, text: "Only on this device." }),
    ]);
  });
  const addWalletRow = h(
    "button",
    {
      class: "list-row settings-row",
      type: "button",
      onclick: async () => {
        state.onboard = { mode: null, mnemonic: null, password: "", reveal: false, adding: true, from: "options" };
        state.route = "wallet_add";
        await actions?.render?.();
      },
    },
    [
      h("span", { class: "row-icon", "aria-hidden": "true", html: iconSvg("plus") }),
      h("span", { class: "row-main" }, [h("span", { class: "row-title", text: "Add wallet" })]),
      h("span", { class: "row-chev", "aria-hidden": "true", html: iconSvg("chev-r") }),
    ]
  );

  // A new password for every wallet.
  const changePasswordBtn =
    ov?.isUnlocked
      ? h("button", {
          class: "btn-outline settings-change-password",
          type: "button",
          text: "Change password",
          onclick: async () => {
            state.route = "change_password";
            await actions?.render?.();
          },
        })
      : null;

  // The open wallet's recovery phrase again, behind the password, in the app.
  const phraseRow =
    ov?.isUnlocked && platform.isTauri
      ? h(
          "button",
          {
            class: "list-row settings-row",
            type: "button",
            onclick: async () => {
              state.route = "recovery_phrase";
              await actions?.render?.();
            },
          },
          [
            h("span", { class: "row-icon", "aria-hidden": "true", html: iconSvg("eye") }),
            h("span", { class: "row-main" }, [h("span", { class: "row-title", text: "Recovery phrase" })]),
            h("span", { class: "row-chev", "aria-hidden": "true", html: iconSvg("chev-r") }),
          ]
        )
      : null;

  // The password again on big sends, on a screen of its own.
  const sendLimit = ov?.sendPasswordLimit ?? null;
  const sendPasswordRow = ov?.isUnlocked
    ? h(
        "button",
        {
          class: "list-row settings-row",
          type: "button",
          onclick: async () => {
            state.route = "send_password";
            await actions?.render?.();
          },
        },
        [
          h("span", { class: "row-icon", "aria-hidden": "true", html: iconSvg("lock") }),
          h("span", { class: "row-main" }, [
            h("span", { class: "row-title", text: "Password on big sends" }),
            h("span", { class: "row-sub", text: sendLimit === null ? "Off" : BigInt(sendLimit) === 0n ? "On every send" : `Above ${formatDuskExact(sendLimit)} DUSK` }),
          ]),
          h("span", { class: "row-chev", "aria-hidden": "true", html: iconSvg("chev-r") }),
        ]
      )
    : null;

  // Auto-lock. The choice shows at once: a redraw before the overview has it
  // doesn't put the old one back. The app on a phone locks Immediately too,
  // as the person leaves it, as phone wallets do.
  const inApp = isTauriRuntime() && isPhone();
  const leaving = inApp && ov?.lockOnLeave === true;
  const lockChoices = [
    ...(inApp ? [{ value: "leave", label: "Immediately" }] : []),
    ...(AUTO_LOCK_OPTIONS.some((o) => o.value === currentAutoLock) ? AUTO_LOCK_OPTIONS : [...AUTO_LOCK_OPTIONS, { value: currentAutoLock, label: autoLockLabel(currentAutoLock) }]),
  ];
  const autoLockSelect = h(
    "select",
    { id: "auto-lock" },
    lockChoices.map((opt) => h("option", { value: String(opt.value), text: opt.label }))
  );
  autoLockSelect.value = leaving ? "leave" : String(currentAutoLock);
  const lockNote = h("p", { class: "settings-note" });
  const sayLock = (onLeave) => {
    lockNote.textContent = onLeave
      ? "Locks the wallet as you leave the app."
      : lockAll
        ? "Locks every wallet after this long without use."
        : "Locks the wallet after this long without use.";
  };
  autoLockSelect.addEventListener("change", async () => {
    const onLeave = autoLockSelect.value === "leave";
    const timeout = onLeave ? currentAutoLock || 5 : Number(autoLockSelect.value);
    for (const o of new Set([state.overview, ov].filter(Boolean))) Object.assign(o, { autoLockTimeoutMinutes: timeout }, inApp ? { lockOnLeave: onLeave } : {});
    sayLock(onLeave);
    try {
      if (inApp) {
        const left = await actions?.send?.({ type: "DUSK_UI_SET_LOCK_ON_LEAVE", lockOnLeave: onLeave });
        if (left?.error) throw new Error(left.error.message ?? "Couldn't save auto-lock");
      }
      const res = await actions?.send?.({ type: "DUSK_UI_SET_AUTO_LOCK", autoLockTimeoutMinutes: timeout });
      if (res?.error) throw new Error(res.error.message ?? "Couldn't save auto-lock");
      actions?.showToast?.(onLeave ? "Locks as you leave the app." : timeout > 0 ? `Locks after ${autoLockLabel(timeout)} without use.` : "Auto-lock is off.");
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 2500);
    }
  });

  // Fingerprint unlock, in the app on a phone that can guard the password with
  // one (platform/fingerprint.js): turned on with the password, then a
  // fingerprint; off at once. Shown once the phone says it can, and on one
  // that could with a fingerprint, off, with what to do first; the password's
  // field is there only while it's being turned on.
  const fingerRow = inApp && ov?.isUnlocked ? fingerprintRow({ actions }) : null;
  if (fingerRow) {
    fingerprintStatus().then(({ available, enroll, on }) => {
      if (!available && !on && !enroll) return;
      const fingerSwitch = fingerRow.querySelector("#fingerprint-unlock");
      fingerSwitch.checked = on;
      const first = !available && !on;
      fingerSwitch.disabled = first;
      fingerRow.querySelector("#fingerprint-enroll").hidden = !first;
      fingerRow.hidden = false;
    });
  }

  // Connected sites, each with its profile and Disconnect; Disconnect all asks first.
  // Connected sites, each with its wallet: with more than one wallet here,
  // every wallet's, named. A site's Disconnect is for the wallet it's
  // connected to; its profile changes on the wallet open now.
  const connectedSites = Array.isArray(ov?.permissions) ? ov.permissions : [];
  const changeSite = async (message, done, failed = "Couldn't save that") => {
    try {
      const response = await actions?.send?.(message);
      if (response?.error) throw new Error(response.error.message ?? failed);
      actions?.showToast?.(done);
      state.needsRefresh = true;
      await actions?.render?.({ forceRefresh: true });
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 2500);
    }
  };
  const disconnect = (message, done) => changeSite(message, done, "Couldn't disconnect");
  // What each site asked, and how long each stays connected, under its Details.
  const sitesState = (state.settings ??= {});
  const detailsOpen = (sitesState.siteDetailsOpen ??= {});
  const siteDetails = (key, record, host, lasts = null) =>
    siteDetailsEl(record, host, {
      lasts,
      open: Boolean(detailsOpen[key]),
      onToggle: (open) => {
        detailsOpen[key] = open;
      },
    });
  const records = ov?.siteRecords ?? {};
  const lastsLabel = (lastsMs) => SITE_LASTS_OPTIONS.find((o) => o.value === lastsMs)?.label ?? "";
  // How long a connection lasts, a site's or new sites', as a choice.
  const lastsField = (label, value, ariaLabel, onChange) => {
    const select = h(
      "select",
      { "aria-label": ariaLabel },
      SITE_LASTS_OPTIONS.map((o) => h("option", { value: String(o.value), text: o.label }))
    );
    select.value = String(normalizeSiteLasts(value));
    select.addEventListener("change", () => onChange(Number(select.value)));
    return h("div", { class: "settings-field" }, [
      h("span", { class: "settings-site__note", text: label }),
      h("div", { class: "select-wrap" }, [select]),
    ]);
  };
  const siteRows = connectedSites.map((p) => {
    const origin = String(p?.origin ?? "");
    const host = siteName(origin);
    const idx = Number(p?.accountIndex ?? 0) || 0;
    const siteWallet = String(p?.walletId ?? "");
    const key = `${siteWallet || walletId} ${origin}`;
    const record = records[siteWallet || walletId]?.[origin];
    const endsAt = Number(p?.expiresAt ?? 0);
    const endsLine = endsAt > 0 ? h("span", { class: "settings-site__note", text: `Connected until ${dateText(endsAt)}` }) : null;
    const details = siteDetails(
      key,
      record,
      host,
      lastsField("Stays connected", p?.lastsMs, `How long ${host} stays connected`, (lastsMs) =>
        changeSite(
          { type: "DUSK_UI_SET_SITE_LASTS", origin, ...(siteWallet ? { siteWallet } : {}), lastsMs },
          lastsMs > 0 ? `${host} stays connected for ${lastsLabel(lastsMs)}.` : `${host} stays connected until you disconnect it.`
        )
      )
    );
    const own = !siteWallet || siteWallet === walletId;
    const wallet = several ? wallets.find((w) => w.walletId === siteWallet) : null;
    const walletLine = wallet
      ? h("span", {
          class: "settings-site__wallet",
          text: own ? walletLabel(wallet) : `${walletLabel(wallet)} · ${String(wallet.accountNames?.[String(idx)] ?? "").trim() || `Profile ${idx + 1}`}`,
        })
      : null;
    const disconnectBtn = h("button", {
      class: "mini-btn",
      type: "button",
      text: "Disconnect",
      "aria-label": wallet ? `Disconnect ${host} from ${walletLabel(wallet)}` : `Disconnect ${host}`,
      onclick: () =>
        disconnect({ type: "DUSK_UI_DISCONNECT_ORIGIN", origin, ...(own ? {} : { siteWallet }) }, `Disconnected ${host}.`),
    });
    if (!own) {
      return h("div", { class: "settings-site" }, [
        h("div", { class: "settings-site__head" }, [h("span", { class: "settings-site__host", title: origin, text: host }), disconnectBtn]),
        walletLine,
        siteLastUsedEl(record),
        endsLine,
        details,
      ].filter(Boolean));
    }
    const sel = h(
      "select",
      { "aria-label": `Profile for ${host}` },
      displayAccounts.map((_acct, i) => named(i, h("option", { value: String(i) })))
    );
    sel.value = String(Math.max(0, Math.min(idx, displayAccounts.length - 1)));
    sel.addEventListener("change", async () => {
      try {
        await actions?.send?.({ type: "DUSK_UI_SET_ORIGIN_ACCOUNT", origin, accountIndex: Number(sel.value) });
        actions?.showToast?.(`${host} now sees ${verified.get(Number(sel.value)) || profileLabelOf(ov, Number(sel.value))}.`);
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      } catch (e) {
        actions?.showToast?.(e?.message ?? String(e), 2500);
      }
    });
    return h("div", { class: "settings-site" }, [
      h("div", { class: "settings-site__head" }, [h("span", { class: "settings-site__host", title: origin, text: host }), disconnectBtn]),
      walletLine,
      siteLastUsedEl(record),
      endsLine,
      h("div", { class: "select-wrap" }, [sel]),
      details,
    ].filter(Boolean));
  });
  // Sites that asked or were connected, and aren't now: last heard of first, each with Forget.
  const connectedKeys = new Set(connectedSites.map((p) => `${String(p?.walletId ?? "") || walletId} ${String(p?.origin ?? "")}`));
  const earlierRows = Object.entries(records)
    .flatMap(([owner, sites]) => Object.entries(sites ?? {}).map(([origin, record]) => ({ owner, origin, record })))
    .filter(({ owner, origin, record }) => siteLastSeen(record) > 0 && !connectedKeys.has(`${owner} ${origin}`))
    .sort((a, b) => siteLastSeen(b.record) - siteLastSeen(a.record))
    .map(({ owner, origin, record }) => {
      const host = siteName(origin);
      const wallet = several ? wallets.find((w) => w.walletId === owner) : null;
      return h("div", { class: "settings-site" }, [
        h("div", { class: "settings-site__head" }, [
          h("span", { class: "settings-site__host", title: origin, text: host }),
          h("button", {
            class: "mini-btn",
            type: "button",
            text: "Forget",
            "aria-label": wallet ? `Forget ${host} in ${walletLabel(wallet)}` : `Forget ${host}`,
            onclick: () => changeSite({ type: "DUSK_UI_FORGET_SITE_RECORD", origin, siteWallet: owner }, `Forgot ${host}.`),
          }),
        ]),
        wallet ? h("span", { class: "settings-site__wallet", text: walletLabel(wallet) }) : null,
        siteLastUsedEl(record),
        siteDetails(`${owner} ${origin}`, record, host),
      ].filter(Boolean));
    });
  // Every listed site's wallet, for Disconnect all.
  const siteWallets = [...new Set(connectedSites.map((p) => String(p?.walletId ?? "")).filter(Boolean))];
  const sitesSection = platform.capabilities.dapp
    ? [
        siteRows.length
          ? h("div", { class: "group settings-sites" }, siteRows)
          : h("p", { class: "settings-empty", text: "No sites are connected." }),
        lastsField("New sites stay connected", ov?.newSiteLastsMs, "How long new sites stay connected", (lastsMs) =>
          changeSite(
            { type: "DUSK_UI_SET_NEW_SITE_LASTS", lastsMs },
            lastsMs > 0 ? `New sites stay connected for ${lastsLabel(lastsMs)}.` : "New sites stay connected until you disconnect them."
          )
        ),
        earlierRows.length
          ? h("details", { class: "advanced settings-sites-earlier" }, [
              h("summary", { text: `Earlier sites (${earlierRows.length})` }),
              h("div", { class: "group settings-sites" }, earlierRows),
            ])
          : null,
        siteRows.length > 1
          ? h("button", {
              class: "text-btn settings-disconnect-all",
              type: "button",
              text: "Disconnect all sites",
              onclick: () => {
                if (!confirm(`Disconnect all ${siteRows.length} sites? They'll ask to connect again.`)) return;
                disconnect({ type: "DUSK_UI_CLEAR_PERMISSIONS", ...(several ? { siteWallets } : {}) }, "Disconnected all sites.");
              },
            })
          : null,
      ]
    : null;

  // Network: a preset applies as it's chosen, as the network menu's do. Custom
  // opens its node addresses, whose Save is what applies them: until then the
  // choice says it's not saved, and stays through a redraw, not past Back.
  const st = (state.settings ??= {});
  const nodeDraft = st.nodeDraft?.for === currentNodeUrl ? st.nodeDraft : null;
  // A network's node with another's prover or archiver is custom, as the pill says.
  const currentPresetId = detectPresetId({ nodeUrl: currentNodeUrl, proverUrl: currentProverUrl, archiverUrl: currentArchiverUrl });
  const { urls } = networks.mainnet;
  const nodeUrlInput = urlInput({ value: nodeDraft?.node ?? currentNodeUrl, placeholder: urls.node, onEnter: () => saveBtn.click() });
  const proverUrlInput = urlInput({ value: nodeDraft?.prover ?? currentProverUrl, placeholder: urls.prover, onEnter: () => saveBtn.click() });
  const archiverUrlInput = urlInput({ value: nodeDraft?.archiver ?? currentArchiverUrl, placeholder: urls.archive, onEnter: () => saveBtn.click() });
  const networkSelect = h(
    "select",
    { id: "network", "aria-label": "Network" },
    NETWORK_PRESETS.map((p) => h("option", { value: p.id, text: [p.label, p.hint].filter(Boolean).join(" · ") }))
  );
  networkSelect.value = nodeDraft?.preset ?? currentPresetId;
  const nodeDetails = h("details", { class: "advanced settings-nodes", open: networkSelect.value === "custom" || Boolean(nodeDraft) });

  // What's typed or picked and not saved says so beside Save.
  const unsavedNote = h("p", { class: "settings-note settings-unsaved", role: "status", hidden: true });
  const addressesChanged = () =>
    nodeUrlInput.value.trim() !== currentNodeUrl || proverUrlInput.value.trim() !== currentProverUrl || archiverUrlInput.value.trim() !== currentArchiverUrl;
  const showUnsaved = () => {
    const unsaved = networkSelect.value !== currentPresetId || addressesChanged();
    unsavedNote.textContent = unsaved ? `Not saved. The wallet stays on ${networkTextOf(currentNodeUrl)} until you press Save.` : "";
    unsavedNote.hidden = !unsaved;
    st.nodeDraft = unsaved
      ? {
          for: currentNodeUrl,
          preset: networkSelect.value,
          node: nodeUrlInput.value,
          prover: proverUrlInput.value,
          archiver: archiverUrlInput.value,
        }
      : null;
  };

  // A preset that couldn't be applied says so under the choice.
  const switchError = h("div", { class: "field-error", role: "alert", hidden: true });
  const applyPreset = async (preset) => {
    const pill = document.getElementById("network-pill");
    networkSelect.disabled = true;
    switchError.hidden = true;
    setNetworkSwitching(pill, preset.label);
    try {
      // From now on, before the wallet answers or the overview is read again.
      switchContext(state);
      const res = await actions?.send?.({ type: "DUSK_UI_SET_NODE_URL", nodeUrl: preset.nodeUrl, proverUrl: preset.proverUrl, archiverUrl: preset.archiverUrl });
      if (res?.error) throw new Error(res.error.message ?? `Couldn't switch to ${preset.label}`);
      st.nodeDraft = null;
      actions?.showToast?.(`Switched to ${preset.label}.`);
      setNetworkSwitching(pill, null);
      state.needsRefresh = true;
      await actions?.render?.({ forceRefresh: true });
    } catch (e) {
      // Still on its network: the choice names it again, and the pill too.
      setNetworkSwitching(pill, null);
      networkSelect.value = currentPresetId;
      showUnsaved();
      switchError.textContent = e?.message ?? String(e);
      switchError.hidden = false;
      actions?.renderHeader?.();
    } finally {
      networkSelect.disabled = false;
    }
  };
  networkSelect.addEventListener("change", () => {
    const preset = NETWORK_PRESETS.find((p) => p.id === networkSelect.value);
    if (!preset) return;
    switchError.hidden = true;
    if (preset.id !== "custom") {
      if (preset.id !== currentPresetId) {
        applyPreset(preset);
        return;
      }
      // Back to the network it's on: nothing to apply, nothing left unsaved.
      nodeUrlInput.value = currentNodeUrl;
      proverUrlInput.value = currentProverUrl;
      archiverUrlInput.value = currentArchiverUrl;
      showUnsaved();
      return;
    }
    // A new custom node's addresses start empty: a network's aren't its own.
    if (currentPresetId !== "custom") {
      for (const input of [nodeUrlInput, proverUrlInput, archiverUrlInput]) input.value = "";
    }
    nodeDetails.open = true;
    showUnsaved();
    nodeUrlInput.focus?.();
  });
  nodeUrlInput.addEventListener("input", () => {
    const presetId = detectPresetIdFromNodeUrl(nodeUrlInput.value);
    networkSelect.value = presetId;
    const preset = NETWORK_PRESETS.find((p) => p.id === presetId);
    if (preset && preset.id !== "custom") {
      proverUrlInput.value = preset.proverUrl || nodeUrlInput.value.trim();
      archiverUrlInput.value = preset.archiverUrl || nodeUrlInput.value.trim();
    }
  });

  // A URL that won't do, or a save that failed, says so above Save.
  const networkError = h("div", { class: "field-error", role: "alert", hidden: true });
  const showNetworkError = (text) => {
    networkError.textContent = text || "";
    networkError.hidden = !text;
  };
  for (const input of [nodeUrlInput, proverUrlInput, archiverUrlInput]) {
    input.addEventListener("input", () => {
      showNetworkError("");
      showUnsaved();
    });
  }
  const saveBtn = h("button", {
    class: "btn-primary",
    type: "button",
    text: "Save",
    onclick: async () => {
      const prevText = saveBtn.textContent;
      try {
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
        showNetworkError("");
        const v = nodeUrlInput.value.trim();
        const pv = proverUrlInput.value.trim();
        const av = archiverUrlInput.value.trim();
        // Each an https address, or plain http on this computer only, as a site's switch takes them.
        const problem = endpointProblem(v, "node") || (pv && endpointProblem(pv, "prover")) || (av && endpointProblem(av, "archiver"));
        if (problem) throw new Error(problem);

        switchContext(state);
        const save = (more = {}) => actions?.send?.({ type: "DUSK_UI_SET_NODE_URL", nodeUrl: v, proverUrl: pv, archiverUrl: av, ...more });
        let resp = await save();
        // A node added before that says another chain now stays as it was, unless the user agrees.
        // Agreeing covers the chain asked about only: a node that answers otherwise by then is asked about again.
        let changed = resp?.error?.data?.chainChanged;
        while (changed && confirm(changed.question)) {
          resp = await save({ acceptChain: changed.answered });
          changed = resp?.error?.data?.chainChanged;
        }
        if (resp?.error) throw new Error(resp.error.message ?? "Failed to save settings");
        st.nodeDraft = null;
        actions?.showToast?.("Settings saved.");
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      } catch (e) {
        showNetworkError(e?.message ?? String(e));
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = prevText;
      }
    },
  });
  nodeDetails.replaceChildren(
    h("summary", { text: "Node addresses" }),
    h("div", { class: "advanced-body" }, [
      fieldLabel(nodeUrlInput, "Node URL"),
      nodeUrlInput,
      fieldLabel(proverUrlInput, "Prover URL"),
      proverUrlInput,
      fieldLabel(archiverUrlInput, "Archiver URL"),
      archiverUrlInput,
      networkError,
      unsavedNote,
      saveBtn,
    ])
  );
  if (nodeDraft) showUnsaved();

  // Advanced: custom gas for every Review, as the web wallet has it.
  const custom = normalizeCustomGas(ov?.customGas);
  const gasOn = st.customGasOn ?? Boolean(custom);
  const gasToggle = h("input", { type: "checkbox", id: "custom-gas", checked: gasOn });
  // What's typed stays through a redraw (a sync or status push) until it's saved.
  const draft = st.customGasDraft ?? null;
  const limitInput = integerInput({ "aria-label": "Gas limit", placeholder: "Gas limit", value: draft?.limit ?? custom?.limit ?? "2500000" });
  const priceInput = integerInput({ "aria-label": "Gas price (LUX)", placeholder: "Gas price (LUX)", value: draft?.price ?? custom?.price ?? "1" });
  const gasNote = h("p", { class: "settings-note" });
  const gasError = h("div", { class: "field-error", role: "alert", hidden: true });
  const gasFields = h("div", { class: "settings-gas-fields", hidden: !gasOn }, [
    fieldLabel(limitInput, "Gas limit"),
    limitInput,
    fieldLabel(priceInput, "Gas price (LUX)"),
    priceInput,
    gasError,
  ]);
  const showGasNote = () => {
    const gas = normalizeCustomGas({ limit: limitInput.value, price: priceInput.value });
    gasNote.textContent = !gasToggle.checked
      ? "The wallet uses the network's gas price, and a gas limit that suits each transaction."
      : gas
      ? `Each transaction costs at most ${formatFee(BigInt(gas.limit) * BigInt(gas.price), { max: true })} DUSK. One that needs more gas than this limit keeps its own.`
      : "";
  };
  const saveGas = async (gas) => {
    try {
      const res = await actions?.send?.({ type: "DUSK_UI_SET_CUSTOM_GAS", customGas: gas });
      if (res?.error) throw new Error(res.error.message ?? "Couldn't save custom gas");
      if (state.overview) state.overview.customGas = gas;
      if (ov && ov !== state.overview) ov.customGas = gas;
      // Saved: the fields show what's saved from now on.
      const kept = st.customGasDraft;
      if (gas && kept && kept.limit === gas.limit && kept.price === gas.price) st.customGasDraft = null;
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 2500);
    }
  };
  const onGasInput = () => {
    const gas = normalizeCustomGas({ limit: limitInput.value, price: priceInput.value });
    gasError.textContent = gas ? "" : "Enter a gas limit and a gas price above 0.";
    gasError.hidden = Boolean(gas);
    showGasNote();
    if (gas) saveGas(gas);
  };
  limitInput.addEventListener("change", onGasInput);
  priceInput.addEventListener("change", onGasInput);
  const keepDraft = () => {
    st.customGasDraft = { limit: String(limitInput.value ?? ""), price: String(priceInput.value ?? "") };
    showGasNote();
  };
  limitInput.addEventListener("input", keepDraft);
  priceInput.addEventListener("input", keepDraft);
  gasToggle.addEventListener("change", () => {
    st.customGasOn = gasToggle.checked;
    gasFields.hidden = !gasToggle.checked;
    showGasNote();
    saveGas(gasToggle.checked ? normalizeCustomGas({ limit: limitInput.value, price: priceInput.value }) : null);
  });
  showGasNote();
  // Deletes every saved contact, away from the list, and asks first.
  const clearContactsBtn = h("button", {
    class: "text-btn settings-delete-contacts",
    type: "button",
    text: "Delete all contacts",
    onclick: async () => {
      if (!confirm("Delete all saved contacts from this wallet? This can't be undone.")) return;
      try {
        // This wallet's alone, as drawn: another wallet's contacts stay.
        await clearAddressBook({ walletId });
        if (state.addressBook) Object.assign(state.addressBook, { loaded: false, items: null, query: "" });
        actions?.showToast?.("Deleted all contacts");
      } catch (e) {
        actions?.showToast?.(e?.message ?? String(e), 2500);
      }
    },
  });
  const advanced = h("details", { class: "advanced settings-advanced", open: Boolean(st.advancedOpen) }, [
    h("summary", { text: "Advanced" }),
    h("div", { class: "advanced-body" }, [
      h("label", { class: "settings-switch", for: "custom-gas" }, [gasToggle, h("span", { text: "Custom gas" })]),
      gasNote,
      gasFields,
      h("p", { class: "settings-note", text: "Remote NFT media is off." }),
      clearContactsBtn,
    ]),
  ]);
  advanced.addEventListener("toggle", () => {
    st.advancedOpen = advanced.open;
  });

  // Contacts, a row of its own.
  const contactsRow = h(
    "button",
    {
      class: "list-row settings-row",
      type: "button",
      onclick: async () => {
        state.addressBook = {
          ...(state.addressBook || {}),
          mode: "manage",
          fromRoute: "options",
          pickReturnRoute: null,
          prefillAddress: "",
          view: "list",
          query: "",
          loaded: false,
          loading: false,
          error: null,
          items: null,
          editId: null,
          editName: "",
          editAddress: "",
        };
        state.route = "contacts";
        await actions?.render?.();
      },
    },
    [
      h("span", { class: "row-icon", "aria-hidden": "true", html: iconSvg("contacts") }),
      h("span", { class: "row-main" }, [h("span", { class: "row-title", text: "Contacts" })]),
      h("span", { class: "row-chev", "aria-hidden": "true", html: iconSvg("chev-r") }),
    ]
  );

  // Reset, on a screen of its own: the password first, as for removing a wallet.
  const resetKept = resetKeptText();
  const resetBtn = h("button", {
    class: "btn-destructive",
    type: "button",
    text: "Reset wallet",
    onclick: async () => {
      state.route = "wallet_reset";
      await actions?.render?.();
    },
  });

  // Dusk's terms of use and privacy policy, as the network's file names its
  // operator's (Mainnet's on a node of no listed network).
  const operator = (networkForNode(currentNodeUrl) ?? networks.mainnet).operator;
  const legalLink = (text, url) =>
    h("button", {
      class: "text-btn chain-link",
      type: "button",
      text,
      onclick: async () => {
        const ok = await openUrl(url);
        if (!ok) actions?.showToast?.(`Couldn't open the ${text.toLowerCase()}`);
      },
    });

  const section = (title, children = [], className = "") =>
    h("section", { class: ["settings-section", className].filter(Boolean).join(" ") }, [
      bracketTitle({ class: "settings-section-title", text: title }),
      ...children.filter(Boolean),
    ]);

  return [
    // Back to where Settings was opened from.
    subnav({ actions: lockBtn ? [lockBtn] : [], title: "Settings", onBack: () => ((st.nodeDraft = null), (state.route = state.optionsFrom || "home"), (state.optionsFrom = null), rerender()) }),
    walletRows.length
      ? section("Wallets", [h("div", { class: "settings-labels" }, walletRows), h("div", { class: "group" }, [addWalletRow])])
      : null,
    ov?.isUnlocked
      ? section("Profile", [
          h("div", { class: "settings-field" }, [fieldLabel(accountSelect, "Active profile"), h("div", { class: "select-wrap" }, [accountSelect])]),
          labelsEditor,
        ])
      : null,
    section("Security", [
      h("div", { class: "settings-field" }, [fieldLabel(autoLockSelect, "Auto-lock"), h("div", { class: "select-wrap" }, [autoLockSelect])]),
      (sayLock(leaving), lockNote),
      fingerRow,
      changePasswordBtn,
      changePasswordBtn ? h("p", { class: "settings-note", text: "Changes the password for every wallet here." }) : null,
      sendPasswordRow || phraseRow ? h("div", { class: "group" }, [phraseRow, sendPasswordRow].filter(Boolean)) : null,
    ]),
    sitesSection ? section("Connected sites", sitesSection) : null,
    section("Contacts", [h("div", { class: "group" }, [contactsRow])]),
    section("Network", [h("div", { class: "select-wrap" }, [networkSelect]), switchError, nodeDetails]),
    // Advanced is its own section, its title the disclosure's.
    h("section", { class: "settings-section" }, [advanced]),
    section("Reset", [
      h("p", {
        class: "settings-note",
        text: `Removes every wallet, with its ${resetKept}, from ${thisDevice()}, and goes back to Mainnet. Your funds stay on Dusk. You need each recovery phrase to use them again.`,
      }),
      resetBtn,
    ], "settings-section--danger"),
    section("About", [
      installedVersion ? h("p", { class: "settings-note", text: `Dusk Wallet v${installedVersion}` }) : null,
      h("p", { class: "settings-note settings-legal" }, [
        legalLink("Terms of use", operator.termsUrl),
        h("span", { class: "sep", "aria-hidden": "true", text: "·" }),
        legalLink("Privacy policy", operator.privacyUrl),
      ]),
    ]),
  ].filter(Boolean);
}
