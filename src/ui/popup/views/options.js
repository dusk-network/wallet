import { NETWORK_PRESETS } from "../../../shared/networkPresets.js";
import { detectPresetIdFromNodeUrl } from "../../../shared/network.js";
import { clearPermissions } from "../../../shared/permissions.js";
import { clearVault } from "../../../shared/vault.js";
import { AUTO_LOCK_OPTIONS } from "../../../shared/settings.js";
import { platform } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { subnav } from "../../components/Subnav.js";

export function optionsView(ov, { state, actions } = {}) {
  const currentNodeUrl = String(ov?.nodeUrl ?? "").trim();
  const currentProverUrl = String(ov?.proverUrl ?? "").trim();
  const currentArchiverUrl = String(ov?.archiverUrl ?? "").trim();
  const currentAutoLock = Number(ov?.autoLockTimeoutMinutes ?? 5);

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

  return [
    subnav({
      title: "Settings",
      onBack: () => {
        state.route = "home";
        actions?.render?.().catch(() => {});
      },
    }),
    lockBtn ? h("div", { class: "row" }, [h("div", { class: "btnrow" }, [lockBtn])]) : null,
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
  ].filter(Boolean);
}
