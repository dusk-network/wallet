import { formatFee } from "../../../shared/amount.js";
import { NETWORK_PRESETS } from "../../../shared/networkPresets.js";
import { detectPresetIdFromNodeUrl } from "../../../shared/network.js";
import { AUTO_LOCK_OPTIONS, normalizeCustomGas } from "../../../shared/settings.js";
import { MAX_ACCOUNT_COUNT } from "../../../shared/constants.js";
import { setAccountName } from "../../../shared/accountNames.js";
import { clearAddressBook } from "../../../shared/addressBook.js";
import { duskNamesNetwork, lookupPrimaryName } from "../../../shared/duskNames.js";
import { platform } from "../../../platform/index.js";
import { getExtensionApi } from "../../../platform/extensionApi.js";
import { h } from "../../lib/dom.js";
import { shortAddress } from "../../lib/strings.js";
import { subnav } from "../../components/Subnav.js";
import { bracketTitle } from "../../components/BracketTitle.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { fieldLabel, integerInput, textInput, urlInput } from "../../components/FormControls.js";
import { profileLabelOf } from "../../components/ProfileName.js";
import { switchContext } from "../context.js";

// Settings: the profile, security, connected sites, contacts and the network,
// then Advanced (custom gas, Delete all contacts), and Reset wallet on its
// own at the end.

const autoLockLabel = (minutes) =>
  AUTO_LOCK_OPTIONS.find((o) => o.value === minutes)?.label ?? `${minutes} minutes`;

export function optionsView(ov, { state, actions } = {}) {
  const currentNodeUrl = String(ov?.nodeUrl ?? "").trim();
  const currentProverUrl = String(ov?.proverUrl ?? "").trim();
  const currentArchiverUrl = String(ov?.archiverUrl ?? "").trim();
  const currentAutoLock = Number(ov?.autoLockTimeoutMinutes ?? 15);
  const installedVersion = String(getExtensionApi()?.runtime?.getManifest?.()?.version ?? "").trim();
  const rerender = (opts) => actions?.render?.(opts)?.catch?.(() => {});

  const lockBtn = ov?.isUnlocked
    ? h("button", {
        class: "btn-outline",
        type: "button",
        text: "Lock wallet",
        onclick: async () => {
          switchContext(state);
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

  // Labels only this device knows, one per profile. A label being typed
  // survives a redraw (a sync's status, another label saved): its field
  // starts from what was typed, and saves when it's left. A saved label
  // shows at once in the header's pill; Settings doesn't redraw for it.
  const walletId = ov?.isUnlocked && accounts.length ? String(accounts[0] ?? "").trim() : "";
  const nameMap = ov?.accountNames && typeof ov.accountNames === "object" ? ov.accountNames : {};
  const drafts = (state.labelDrafts ??= {});
  const labelOf = (s) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, 32);
  const labelsEditor =
    ov?.isUnlocked && walletId
      ? h("div", { class: "settings-labels" }, [
          h("h3", { class: "settings-subtitle", text: "Labels on this device" }),
          ...displayAccounts.map((acct, i) => {
            let saved = labelOf(nameMap?.[String(i)]);
            const input = textInput({
              placeholder: "Label, only on this device",
              "aria-label": `Profile ${i + 1} label`,
              value: drafts[i] ?? saved,
            });
            input.addEventListener("input", () => {
              drafts[i] = input.value;
            });
            const save = async () => {
              const value = input.value;
              const label = labelOf(value);
              if (label === saved) {
                if (drafts[i] === value) delete drafts[i];
                return;
              }
              const before = saved;
              saved = label;
              try {
                const map = await setAccountName(walletId, i, value);
                if (drafts[i] === value) delete drafts[i];
                const names =
                  map && typeof map === "object" ? { ...map } : { ...(state.overview?.accountNames ?? {}), [String(i)]: label };
                if (!label && !(map && typeof map === "object")) delete names[String(i)];
                if (state.overview) state.overview.accountNames = names;
                if (ov && ov !== state.overview) ov.accountNames = names;
                actions?.showToast?.("Label saved.");
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
            return h("div", { class: "settings-label" }, [line, input]);
          }),
        ])
      : null;

  // Auto-lock. The choice shows at once: a redraw before the overview has it
  // doesn't put the old one back.
  const lockChoices = AUTO_LOCK_OPTIONS.some((o) => o.value === currentAutoLock)
    ? AUTO_LOCK_OPTIONS
    : [...AUTO_LOCK_OPTIONS, { value: currentAutoLock, label: autoLockLabel(currentAutoLock) }];
  const autoLockSelect = h(
    "select",
    { id: "auto-lock" },
    lockChoices.map((opt) => h("option", { value: String(opt.value), text: opt.label }))
  );
  autoLockSelect.value = String(currentAutoLock);
  autoLockSelect.addEventListener("change", async () => {
    const timeout = Number(autoLockSelect.value);
    if (state.overview) state.overview.autoLockTimeoutMinutes = timeout;
    if (ov && ov !== state.overview) ov.autoLockTimeoutMinutes = timeout;
    try {
      const res = await actions?.send?.({ type: "DUSK_UI_SET_AUTO_LOCK", autoLockTimeoutMinutes: timeout });
      if (res?.error) throw new Error(res.error.message ?? "Couldn't save auto-lock");
      actions?.showToast?.(timeout > 0 ? `Locks after ${autoLockLabel(timeout)} without use.` : "Auto-lock is off.");
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 2500);
    }
  });

  // Connected sites, each with its profile and Disconnect; Disconnect all asks first.
  const connectedSites = Array.isArray(ov?.permissions) ? ov.permissions : [];
  const siteHost = (origin) => {
    try {
      return new URL(origin).host || origin;
    } catch {
      return origin;
    }
  };
  const disconnect = async (message, done) => {
    try {
      const response = await actions?.send?.(message);
      if (response?.error) throw new Error(response.error.message ?? "Couldn't disconnect");
      actions?.showToast?.(done);
      state.needsRefresh = true;
      await actions?.render?.({ forceRefresh: true });
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 2500);
    }
  };
  const siteRows = connectedSites.map((p) => {
    const origin = String(p?.origin ?? "");
    const host = siteHost(origin);
    const idx = Number(p?.accountIndex ?? 0) || 0;
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
      h("div", { class: "settings-site__head" }, [
        h("span", { class: "settings-site__host", title: origin, text: host }),
        h("button", {
          class: "mini-btn",
          type: "button",
          text: "Disconnect",
          "aria-label": `Disconnect ${host}`,
          onclick: () => disconnect({ type: "DUSK_UI_DISCONNECT_ORIGIN", origin }, `Disconnected ${host}.`),
        }),
      ]),
      h("div", { class: "select-wrap" }, [sel]),
    ]);
  });
  const sitesSection = platform.capabilities.dapp
    ? [
        siteRows.length
          ? h("div", { class: "group settings-sites" }, siteRows)
          : h("p", { class: "settings-empty", text: "No sites are connected." }),
        siteRows.length > 1
          ? h("button", {
              class: "text-btn settings-disconnect-all",
              type: "button",
              text: "Disconnect all sites",
              onclick: () => {
                if (!confirm(`Disconnect all ${siteRows.length} sites? They'll ask to connect again.`)) return;
                disconnect({ type: "DUSK_UI_CLEAR_PERMISSIONS" }, "Disconnected all sites.");
              },
            })
          : null,
      ]
    : null;

  // Network: the preset, and its node addresses for a custom one.
  const nodeUrlInput = urlInput({ value: currentNodeUrl, placeholder: "https://nodes.dusk.network", onEnter: () => saveBtn.click() });
  const proverUrlInput = urlInput({ value: currentProverUrl, placeholder: "https://provers.dusk.network", onEnter: () => saveBtn.click() });
  const archiverUrlInput = urlInput({ value: currentArchiverUrl, placeholder: "https://nodes.dusk.network", onEnter: () => saveBtn.click() });
  const networkSelect = h(
    "select",
    { id: "network", "aria-label": "Network" },
    NETWORK_PRESETS.map((p) => h("option", { value: p.id, text: p.label }))
  );
  networkSelect.value = detectPresetIdFromNodeUrl(currentNodeUrl);
  const networkHint = h("div", { class: "muted" });
  const nodeDetails = h("details", { class: "advanced settings-nodes", open: networkSelect.value === "custom" });
  const showNetworkHint = (preset) => {
    networkHint.textContent = preset?.hint ?? "";
    networkHint.hidden = !preset?.hint;
  };
  showNetworkHint(NETWORK_PRESETS.find((p) => p.id === networkSelect.value));
  networkSelect.addEventListener("change", () => {
    const preset = NETWORK_PRESETS.find((p) => p.id === networkSelect.value);
    if (!preset) return;
    if (preset.id !== "custom" && preset.nodeUrl) {
      nodeUrlInput.value = preset.nodeUrl;
      if (preset.proverUrl) proverUrlInput.value = preset.proverUrl;
      if (preset.archiverUrl) archiverUrlInput.value = preset.archiverUrl;
    } else {
      nodeDetails.open = true;
    }
    showNetworkHint(preset);
  });
  nodeUrlInput.addEventListener("input", () => {
    const presetId = detectPresetIdFromNodeUrl(nodeUrlInput.value);
    networkSelect.value = presetId;
    const preset = NETWORK_PRESETS.find((p) => p.id === presetId);
    showNetworkHint(preset);
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
    input.addEventListener("input", () => showNetworkError(""));
  }
  const saveBtn = h("button", {
    class: "btn-primary",
    type: "button",
    text: "Save",
    onclick: async () => {
      const prevText = saveBtn.textContent;
      try {
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving...";
        showNetworkError("");
        const v = nodeUrlInput.value.trim();
        const pv = proverUrlInput.value.trim();
        const av = archiverUrlInput.value.trim();
        const valid = (u) => {
          try {
            // eslint-disable-next-line no-new
            new URL(u);
            return true;
          } catch {
            return false;
          }
        };
        if (!valid(v)) throw new Error("Invalid node URL format");
        if (pv && !valid(pv)) throw new Error("Invalid prover URL format");
        if (av && !valid(av)) throw new Error("Invalid archiver URL format");

        switchContext(state);
        const resp = await actions?.send?.({ type: "DUSK_UI_SET_NODE_URL", nodeUrl: v, proverUrl: pv, archiverUrl: av });
        if (resp?.error) throw new Error(resp.error.message ?? "Failed to save settings");
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
      saveBtn,
    ])
  );

  // Advanced: custom gas for every Review, as the web wallet has it.
  const st = (state.settings ??= {});
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
        await clearAddressBook();
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

  const resetBtn = h("button", {
    class: "btn-destructive",
    type: "button",
    text: "Reset wallet",
    onclick: async () => {
      if (!confirm("This will remove the encrypted recovery phrase from this browser profile. Continue?")) return;
      try {
        switchContext(state);
        const res = await actions?.send?.({ type: "DUSK_UI_RESET_WALLET" });
        if (res?.error) throw new Error(res.error.message ?? "Wallet reset failed");
        actions?.showToast?.("Wallet reset. Import again to continue.", 2500);
        state.route = "home";
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      } catch (e) {
        actions?.showToast?.(e?.message ?? String(e), 2500);
      }
    },
  });

  const section = (title, children = [], className = "") =>
    h("section", { class: ["settings-section", className].filter(Boolean).join(" ") }, [
      bracketTitle({ class: "settings-section-title", text: title }),
      ...children.filter(Boolean),
    ]);

  return [
    subnav({ actions: lockBtn ? [lockBtn] : [], title: "Settings", onBack: () => ((state.route = "home"), rerender()) }),
    ov?.isUnlocked
      ? section("Profile", [
          h("div", { class: "settings-field" }, [fieldLabel(accountSelect, "Active profile"), h("div", { class: "select-wrap" }, [accountSelect])]),
          labelsEditor,
        ])
      : null,
    section("Security", [
      h("div", { class: "settings-field" }, [fieldLabel(autoLockSelect, "Auto-lock"), h("div", { class: "select-wrap" }, [autoLockSelect])]),
      h("p", { class: "settings-note", text: "Locks the wallet after this long without use." }),
    ]),
    sitesSection ? section("Connected sites", sitesSection) : null,
    section("Contacts", [h("div", { class: "group" }, [contactsRow])]),
    section("Network", [h("div", { class: "select-wrap" }, [networkSelect]), networkHint, nodeDetails]),
    // Advanced is its own section, its title the disclosure's.
    h("section", { class: "settings-section" }, [advanced]),
    section("Reset", [
      h("p", { class: "settings-note", text: "Removes this wallet from this browser. You need the recovery phrase to use it again." }),
      resetBtn,
    ], "settings-section--danger"),
    installedVersion ? section("About", [h("p", { class: "settings-note", text: `Dusk Wallet v${installedVersion}` })]) : null,
  ].filter(Boolean);
}
