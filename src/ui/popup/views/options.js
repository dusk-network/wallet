import { NETWORK_PRESETS } from "../../../shared/networkPresets.js";
import { detectPresetIdFromNodeUrl } from "../../../shared/network.js";
import { clearPermissions } from "../../../shared/permissions.js";
import { clearVault } from "../../../shared/vault.js";
import { platform } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { subnav } from "../../components/Subnav.js";

export function optionsView(ov, { state, actions } = {}) {
  const currentNodeUrl = String(ov?.nodeUrl ?? "").trim();
  const currentProverUrl = String(ov?.proverUrl ?? "").trim();
  const currentArchiverUrl = String(ov?.archiverUrl ?? "").trim();

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
        saveBtn.textContent = "Testing...";
        const v = nodeUrlInput.value.trim();
        const pv = proverUrlInput.value.trim();
        const av = archiverUrlInput.value.trim();
        // eslint-disable-next-line no-new
        new URL(v);

        if (pv) {
          // eslint-disable-next-line no-new
          new URL(pv);
        }
        if (av) {
          // eslint-disable-next-line no-new
          new URL(av);
        }

        const resp = await actions?.send?.({
          type: "DUSK_UI_SET_NODE_URL",
          nodeUrl: v,
          proverUrl: pv,
          archiverUrl: av,
        });
        if (resp?.error)
          throw new Error(resp.error.message ?? "Failed to save settings");

        actions?.showToast?.("Saved settings.");
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
