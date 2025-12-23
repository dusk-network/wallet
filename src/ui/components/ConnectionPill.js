import { h } from "../lib/dom.js";
import { platform } from "../../platform/index.js";

export function connectionPill(ov) {
  // Desktop/mobile wallet apps don't embed into arbitrary sites,
  // so the "connected site" pill is extension-only.
  if (!platform.capabilities.dapp) return null;

  const origin = ov?.activeOrigin;
  const connected = Boolean(origin && ov?.activeConnected);

  let hostLabel = "No active site";
  if (origin) {
    try {
      hostLabel = new URL(origin).hostname;
    } catch {
      hostLabel = origin;
    }
  }

  const statusText = connected ? "Connected" : "Not connected";

  return h("div", { class: "conn-pill", title: origin || "" }, [
    h("div", { class: `conn-dot ${connected ? "conn-dot--on" : ""}` }),
    h("div", { class: "conn-text", text: `${hostLabel} • ${statusText}` }),
  ]);
}
