import { NETWORK_PRESETS } from "../../../shared/networkPresets.js";
import { detectPresetIdFromNodeUrl } from "../../../shared/network.js";
import { clearPermissions } from "../../../shared/permissions.js";
import { clearVault } from "../../../shared/vault.js";
import { platform } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { bannerView } from "../../components/Banner.js";
import { subnav } from "../../components/Subnav.js";

export function optionsView(ov, { state, actions } = {}) {
  const currentNodeUrl = String(ov?.nodeUrl ?? "").trim();

  const nodeUrlInput = h("input", {
    value: currentNodeUrl,
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
    }
    networkHint.textContent = preset.hint ?? "";
  }

  function syncFromNodeUrl() {
    const presetId = detectPresetIdFromNodeUrl(nodeUrlInput.value);
    networkSelect.value = presetId;
    const preset = NETWORK_PRESETS.find((p) => p.id === presetId);
    networkHint.textContent = preset?.hint ?? "";
  }

  networkSelect.addEventListener("change", syncFromSelect);
  nodeUrlInput.addEventListener("input", syncFromNodeUrl);

  const saveBtn = h("button", {
    class: "btn-primary",
    text: "Save",
    onclick: async () => {
      try {
        const v = nodeUrlInput.value.trim();
        // eslint-disable-next-line no-new
        new URL(v);

        const resp = await actions?.send?.({ type: "DUSK_UI_SET_NODE_URL", nodeUrl: v });
        if (resp?.error)
          throw new Error(resp.error.message ?? "Failed to save settings");

        state.banner = { kind: "ok", text: "Saved settings." };
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      } catch (e) {
        state.banner = { kind: "error", text: e?.message ?? String(e) };
        await actions?.render?.();
      }
    },
  });

  const clearPermBtn = h("button", {
    class: "btn-outline",
    text: "Clear connected sites",
    onclick: async () => {
      try {
        await clearPermissions();
        state.banner = { kind: "ok", text: "Cleared connected sites." };
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      } catch (e) {
        state.banner = { kind: "error", text: e?.message ?? String(e) };
        await actions?.render?.();
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

        state.banner = { kind: "ok", text: "Vault removed. You must import again." };
        state.route = "home";
        state.needsRefresh = true;
        await actions?.render?.({ forceRefresh: true });
      } catch (e) {
        state.banner = { kind: "error", text: e?.message ?? String(e) };
        await actions?.render?.();
      }
    },
  });

  return [
    subnav({
      title: "Settings",
      onBack: () => {
        state.route = "home";
        state.banner = null;
        actions?.render?.().catch(() => {});
      },
    }),
    bannerView(state.banner),
    h("div", { class: "row" }, [
      h("label", { text: "Network" }),
      networkSelect,
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
