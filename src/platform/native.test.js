import { afterEach, describe, expect, it, vi } from "vitest";

import { openUrl } from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// The app's WebView: Tauri's bridge to the wrapper, and window.open, which
// there loads the site in the wallet's own window.
function inTheApp() {
  const invoke = vi.fn(async () => null);
  const open = vi.fn();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke }, open });
  return { invoke, open };
}

describe("a link the app opens", () => {
  it("goes to the phone's browser, never into the wallet's window, as Lena's explorer and sozu.fi links did", async () => {
    const { invoke, open } = inTheApp();
    await expect(openUrl("https://explorer.testnet.dusk.network/transactions/transaction/?id=ab")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", { url: "https://explorer.testnet.dusk.network/transactions/transaction/?id=ab", with: undefined }, undefined);
    expect(open).not.toHaveBeenCalled();
  });

  it("says it couldn't, rather than putting the site in the wallet's window, when the browser won't open it", async () => {
    const { invoke, open } = inTheApp();
    invoke.mockRejectedValueOnce(new Error("no browser"));
    await expect(openUrl("https://sozu.fi")).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("fingerprint unlock turned on", () => {
  it("starts no second turning on while one is under way, and turns off only after it", async () => {
    const steps = [];
    const enabled = Promise.withResolvers();
    const invoke = vi.fn(async (cmd, args) => {
      steps.push(args.action);
      return args.action === "enable" ? enabled.promise : { ok: true };
    });
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    vi.resetModules();
    const { turnFingerprintOff, turnFingerprintOn } = await import("./fingerprint.js");
    const first = turnFingerprintOn("one");
    await expect(turnFingerprintOn("two")).resolves.toEqual({ ok: false, reason: "busy" });
    const off = turnFingerprintOff();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(steps).toEqual(["enable"]);
    enabled.resolve({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
    await off;
    expect(steps).toEqual(["enable", "disable"]);
  });
});
