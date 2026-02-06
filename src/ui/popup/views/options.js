import { NETWORK_PRESETS } from "../../../shared/networkPresets.js";
import { detectPresetIdFromNodeUrl } from "../../../shared/network.js";
import { clearPermissions } from "../../../shared/permissions.js";
import { clearVault } from "../../../shared/vault.js";
import { AUTO_LOCK_OPTIONS } from "../../../shared/settings.js";
import { MAX_ACCOUNT_COUNT } from "../../../shared/constants.js";
import { setAccountName } from "../../../shared/accountNames.js";
import { platform } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { truncateMiddle } from "../../lib/strings.js";
import { subnav } from "../../components/Subnav.js";

export function optionsView(ov, { state, actions } = {}) {
  const currentNodeUrl = String(ov?.nodeUrl ?? "").trim();
  const currentProverUrl = String(ov?.proverUrl ?? "").trim();
  const currentArchiverUrl = String(ov?.archiverUrl ?? "").trim();
  const currentAutoLock = Number(ov?.autoLockTimeoutMinutes ?? 5);
  const currentNftMetaEnabled = ov?.nftMetadataEnabled !== false;
  const currentIpfsGateway = String(ov?.ipfsGateway ?? "https://ipfs.io/ipfs/").trim();

  const lockBtn = ov?.isUnlocked
    ? h("button", {
        class: "btn-outline",
        text: "Lock wallet",
        onclick: async () => {
          await actions?.send?.({ type: "DUSK_UI_LOCK" });
          state.route = "home";
          state.needsRefresh = true;
          await actions?.render?.({ forceRefresh: true });
        },
      })
    : null;

  // Account selector (multi-account)
  const accounts = Array.isArray(ov?.accounts) ? ov.accounts : [];
  const selectedAccountIndex = Number(ov?.selectedAccountIndex ?? 0) || 0;
  const accountCount = Math.min(
    MAX_ACCOUNT_COUNT,
    Math.max(1, Number(ov?.accountCount ?? (accounts.length || 1)) || 1)
  );
  const displayAccounts = accounts.length
    ? accounts
    : Array.from({ length: accountCount }, () => "");

  const nameMap = ov?.accountNames && typeof ov.accountNames === "object" ? ov.accountNames : {};

  const accountSelect = h(
    "select",
    { id: "account" },
    (accounts.length ? accounts : [""]).map((acct, i) =>
      h("option", {
        value: String(i),
        text: (() => {
          const name = String(nameMap?.[String(i)] ?? "").trim();
          const acctText = String(acct) ? truncateMiddle(String(acct), 8, 6) : "";
          if (name && acctText) return `${name} · ${acctText}`;
          if (name) return name;
          if (acctText) return `Account ${i + 1} · ${acctText}`;
          return `Account ${i + 1}`;
        })(),
      })
    )
  );
  accountSelect.value = String(
    Math.max(0, Math.min(selectedAccountIndex, Math.max(0, accounts.length - 1)))
  );

  accountSelect.addEventListener("change", async () => {
    try {
      await actions?.send?.({
        type: "DUSK_UI_SET_ACCOUNT_INDEX",
        index: Number(accountSelect.value),
      });
      actions?.showToast?.("Account selected.");
      state.needsRefresh = true;
      await actions?.render?.({ forceRefresh: true });
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 2500);
    }
  });

  const canAddAccount = displayAccounts.length < MAX_ACCOUNT_COUNT;
  const addAccountBtn = ov?.isUnlocked && canAddAccount
    ? h("button", {
        class: "btn-outline",
        text: "Add account",
        onclick: async () => {
          try {
            await actions?.send?.({ type: "DUSK_UI_ADD_ACCOUNT" });
            actions?.showToast?.("Account added.");
            state.needsRefresh = true;
            await actions?.render?.({ forceRefresh: true });
          } catch (e) {
            actions?.showToast?.(e?.message ?? String(e), 2500);
          }
        },
      })
    : null;

  const walletId = ov?.isUnlocked && accounts.length ? String(accounts[0] ?? "").trim() : "";
  const accountNamesEditor = ov?.isUnlocked && walletId
    ? h("div", { class: "row" }, [
        h("label", { text: "Account names" }),
        ...displayAccounts.map((acct, i) => {
          const input = h("input", {
            placeholder: `Account ${i + 1} name (optional)`,
            value: String(nameMap?.[String(i)] ?? ""),
          });

          input.addEventListener("change", async () => {
            try {
              await setAccountName(walletId, i, input.value);
              actions?.showToast?.("Account name saved.");
              state.needsRefresh = true;
              await actions?.render?.({ forceRefresh: true });
            } catch (e) {
              actions?.showToast?.(e?.message ?? String(e), 2500);
            }
          });

          const addr = String(acct ?? "").trim();
          return h("div", { class: "row" }, [
            h("div", { class: "muted", text: `Account ${i + 1}` }),
            input,
            addr
              ? h("div", { class: "muted" }, [h("code", { text: addr })])
              : null,
          ].filter(Boolean));
        }),
        h("div", {
          class: "muted",
          text: "Optional labels stored locally (per wallet).",
        }),
      ])
    : null;

  // Auto-lock timeout selector.
  const autoLockSelect = h(
    "select",
    { id: "auto-lock" },
    AUTO_LOCK_OPTIONS.map((opt) =>
      h("option", { value: String(opt.value), text: opt.label })
    )
  );
  autoLockSelect.value = String(currentAutoLock);

  autoLockSelect.addEventListener("change", async () => {
    const timeout = Number(autoLockSelect.value);
    try {
      await actions?.send?.({
        type: "DUSK_UI_SET_AUTO_LOCK",
        autoLockTimeoutMinutes: timeout,
      });
      actions?.showToast?.(
        timeout > 0
          ? `Auto-lock set to ${AUTO_LOCK_OPTIONS.find((o) => o.value === timeout)?.label ?? timeout + " min"}.`
          : "Auto-lock disabled."
      );
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 2500);
    }
  });

  const nodeUrlInput = h("input", {
    value: currentNodeUrl,
    placeholder: "https://nodes.dusk.network",
  });

  const proverUrlInput = h("input", {
    value: currentProverUrl,
    placeholder: "https://provers.dusk.network",
  });

  const archiverUrlInput = h("input", {
    value: currentArchiverUrl,
    placeholder: "https://nodes.dusk.network",
  });

  const networkSelect = h(
    "select",
    { id: "network" },
    NETWORK_PRESETS.map((p) => h("option", { value: p.id, text: p.label }))
  );

  networkSelect.value = detectPresetIdFromNodeUrl(currentNodeUrl);

  const networkHint = h("div", {
    class: "muted",
    text:
      NETWORK_PRESETS.find((p) => p.id === networkSelect.value)?.hint ?? "",
  });

  function syncFromSelect() {
    const preset = NETWORK_PRESETS.find((p) => p.id === networkSelect.value);
    if (!preset) return;
    if (preset.id !== "custom" && preset.nodeUrl) {
      nodeUrlInput.value = preset.nodeUrl;
      // Keep prover/archiver aligned with known presets.
      if (preset.proverUrl) proverUrlInput.value = preset.proverUrl;
      if (preset.archiverUrl) archiverUrlInput.value = preset.archiverUrl;
    }
    networkHint.textContent = preset.hint ?? "";
  }

  function syncFromNodeUrl() {
    const presetId = detectPresetIdFromNodeUrl(nodeUrlInput.value);
    networkSelect.value = presetId;
    const preset = NETWORK_PRESETS.find((p) => p.id === presetId);
    networkHint.textContent = preset?.hint ?? "";

    // If the node URL matches a known preset, keep prover/archiver aligned.
    if (preset && preset.id !== "custom") {
      proverUrlInput.value = preset.proverUrl || nodeUrlInput.value.trim();
      archiverUrlInput.value = preset.archiverUrl || nodeUrlInput.value.trim();
    }
  }

  networkSelect.addEventListener("change", syncFromSelect);
  nodeUrlInput.addEventListener("input", syncFromNodeUrl);

  const saveBtn = h("button", {
    class: "btn-primary",
    text: "Save",
    onclick: async () => {
      const prevText = saveBtn.textContent;
      try {
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving...";
        const v = nodeUrlInput.value.trim();
        const pv = proverUrlInput.value.trim();
        const av = archiverUrlInput.value.trim();

        // Only validate URL format (not reachability)
        try {
          // eslint-disable-next-line no-new
          new URL(v);
        } catch {
          throw new Error("Invalid node URL format");
        }

        if (pv) {
          try {
            // eslint-disable-next-line no-new
            new URL(pv);
          } catch {
            throw new Error("Invalid prover URL format");
          }
        }
        if (av) {
          try {
            // eslint-disable-next-line no-new
            new URL(av);
          } catch {
            throw new Error("Invalid archiver URL format");
          }
        }

        const resp = await actions?.send?.({
          type: "DUSK_UI_SET_NODE_URL",
          nodeUrl: v,
          proverUrl: pv,
          archiverUrl: av,
        });
        if (resp?.error)
          throw new Error(resp.error.message ?? "Failed to save settings");

        actions?.showToast?.("Settings saved.");
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      } catch (e) {
        actions?.showToast?.(e?.message ?? String(e), 2500);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = prevText;
      }
    },
  });

  const clearPermBtn = h("button", {
    class: "btn-outline",
    text: "Clear connected sites",
    onclick: async () => {
      try {
        await clearPermissions();
        actions?.showToast?.("Cleared connected sites.");
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      } catch (e) {
        actions?.showToast?.(e?.message ?? String(e), 2500);
      }
    },
  });

  const connectedSites = Array.isArray(ov?.permissions) ? ov.permissions : [];
  const connectedSitesEl = platform.capabilities.dapp
    ? connectedSites.length
      ? h(
          "div",
          { class: "row" },
          connectedSites.flatMap((p) => {
            const origin = String(p?.origin ?? "");
            const idx = Number(p?.accountIndex ?? 0) || 0;

            const sel = h(
              "select",
              {},
              displayAccounts.map((acct, i) =>
                h("option", {
                  value: String(i),
                  text: (() => {
                    const name = String(nameMap?.[String(i)] ?? "").trim();
                    const acctText = String(acct) ? truncateMiddle(String(acct), 6, 4) : "";
                    if (name && acctText) return `${name} · ${acctText}`;
                    if (name) return name;
                    if (acctText) return `Account ${i + 1} · ${acctText}`;
                    return `Account ${i + 1}`;
                  })(),
                })
              )
            );
            sel.value = String(
              Math.max(0, Math.min(idx, Math.max(0, displayAccounts.length - 1)))
            );

            sel.addEventListener("change", async () => {
              try {
                await actions?.send?.({
                  type: "DUSK_UI_SET_ORIGIN_ACCOUNT",
                  origin,
                  accountIndex: Number(sel.value),
                });
                actions?.showToast?.("Updated site account.");
                state.needsRefresh = true;
                await actions?.render?.({ forceRefresh: true });
              } catch (e) {
                actions?.showToast?.(e?.message ?? String(e), 2500);
              }
            });

            return [
              h("div", { class: "divider" }),
              h("div", { class: "muted", text: origin }),
              h("div", { class: "select-wrap" }, [sel]),
            ];
          })
        )
      : h("div", { class: "row" }, [h("div", { class: "muted", text: "No connected sites." })])
    : null;

  const clearVaultBtn = h("button", {
    class: "btn-destructive",
    text: "Reset wallet vault",
    onclick: async () => {
      const ok = confirm(
        "This will remove the encrypted mnemonic from this browser profile. Continue?"
      );
      if (!ok) return;

      try {
        // Best-effort lock (engine can still be running).
        try {
          await actions?.send?.({ type: "DUSK_UI_LOCK" });
        } catch {
          // ignore
        }

        await clearPermissions();
        await clearVault();

        actions?.showToast?.("Vault removed. Please import again.", 2500);
        state.route = "home";
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      } catch (e) {
        actions?.showToast?.(e?.message ?? String(e), 2500);
      }
    },
  });

  const addressBookBtn = h("button", {
    class: "btn-outline",
    text: "Contacts",
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
  });

  const nftMetaToggle = h("input", { type: "checkbox" });
  nftMetaToggle.checked = currentNftMetaEnabled;

  const ipfsGatewayInput = h("input", {
    value: currentIpfsGateway,
    placeholder: "https://ipfs.io/ipfs/",
  });

  const saveNftBtn = h("button", {
    class: "btn-outline",
    text: "Save NFT settings",
    onclick: async () => {
      const prevText = saveNftBtn.textContent;
      try {
        saveNftBtn.disabled = true;
        saveNftBtn.textContent = "Saving...";
        const resp = await actions?.send?.({
          type: "DUSK_UI_SET_NFT_SETTINGS",
          nftMetadataEnabled: Boolean(nftMetaToggle.checked),
          ipfsGateway: ipfsGatewayInput.value,
        });
        if (resp?.error) throw new Error(resp.error.message ?? "Failed to save NFT settings");
        actions?.showToast?.("NFT settings saved.");
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      } catch (e) {
        actions?.showToast?.(e?.message ?? String(e), 2500);
      } finally {
        saveNftBtn.disabled = false;
        saveNftBtn.textContent = prevText;
      }
    },
  });

  return [
    subnav({
      title: "Settings",
      onBack: () => {
        state.route = "home";
        actions?.render?.().catch(() => {});
      },
    }),
    lockBtn ? h("div", { class: "row" }, [h("div", { class: "btnrow" }, [lockBtn])]) : null,
    ov?.isUnlocked
      ? h("div", { class: "row" }, [
          h("label", { text: "Account" }),
          h("div", { class: "select-wrap" }, [accountSelect]),
          addAccountBtn ? h("div", { class: "btnrow" }, [addAccountBtn]) : null,
          h("div", {
            class: "muted",
            text: "This controls which account the wallet UI is operating on.",
          }),
        ].filter(Boolean))
      : null,
    accountNamesEditor,
    h("div", { class: "row" }, [
      h("label", { text: "Auto-lock" }),
      h("div", { class: "select-wrap" }, [autoLockSelect]),
      h("div", {
        class: "muted",
        text: "Automatically lock the wallet after a period of inactivity.",
      }),
    ]),
    h("div", { class: "divider" }),
    h("div", { class: "row" }, [
      h("label", { text: "Network" }),
      h("div", { class: "select-wrap" }, [networkSelect]),
      networkHint,
      h("div", {
        class: "muted",
        text: "Selecting a network will prefill the node URL. You can still edit it manually.",
      }),
    ]),
    h("div", { class: "row" }, [
      h("label", { text: "Node URL" }),
      nodeUrlInput,
      h("div", { class: "muted" }, [
        "This must be the base http(s) URL of a Rusk/RUES-enabled node. Example: ",
        h("code", { text: "https://nodes.dusk.network" }),
      ]),
    ]),

    h("div", { class: "row" }, [
      h("label", { text: "Prover URL" }),
      proverUrlInput,
      h("div", { class: "muted" }, [
        "Optional. Used for shielded transaction proving. Example: ",
        h("code", { text: "https://testnet.provers.dusk.network" }),
      ]),
    ]),

    h("div", { class: "row" }, [
      h("label", { text: "Archiver URL" }),
      archiverUrlInput,
      h("div", { class: "muted" }, [
        "Optional. Used for note discovery/sync. Example: ",
        h("code", { text: "https://testnet.nodes.dusk.network" }),
      ]),
    ]),
    h("div", { class: "row" }, [h("div", { class: "btnrow" }, [saveBtn])]),
    h("div", { class: "divider" }),
    h("div", { class: "row" }, [
      h("label", { text: "NFT privacy" }),
      h("div", { class: "muted", text: "Fetching NFT metadata/images can leak usage patterns to third-party servers." }),
      h("label", { text: "Fetch NFT metadata/images" }),
      h("div", { class: "box" }, [
        h("div", { class: "hrow" }, [
          h("div", { class: "muted", text: nftMetaToggle.checked ? "Enabled" : "Disabled" }),
          nftMetaToggle,
        ]),
      ]),
      h("label", { text: "IPFS gateway" }),
      ipfsGatewayInput,
      h("div", { class: "muted", text: "Used to resolve ipfs:// URIs (default: https://ipfs.io/ipfs/)." }),
      h("div", { class: "btnrow" }, [saveNftBtn]),
    ]),
    h("div", { class: "row" }, [
      h("div", { class: "muted", text: "Manage saved recipients for quick sending." }),
      h("div", { class: "btnrow" }, [addressBookBtn]),
    ]),
    h("div", { class: "divider" }),
    h("div", { class: "row" }, [
      h(
        "div",
        { class: "btnrow" },
        platform.capabilities.dapp
          ? [clearPermBtn, clearVaultBtn]
          : [clearVaultBtn]
      ),
    ]),
    connectedSitesEl,
  ].filter(Boolean);
}
