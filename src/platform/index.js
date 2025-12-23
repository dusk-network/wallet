import { getRuntimeKind, isExtensionRuntime, isTauriRuntime } from "./runtime.js";
import { kv } from "./storage.js";
import { assetUrl } from "./assets.js";

const kind = getRuntimeKind();

// Capabilities help the UI decide which features to show.
// For now: dApp injection/connection only exists in the extension.
export const platform = {
  kind,
  isExtension: isExtensionRuntime(),
  isTauri: isTauriRuntime(),

  capabilities: Object.freeze({
    dapp: kind === "extension",
  }),

  kv,
  assetUrl,
};
