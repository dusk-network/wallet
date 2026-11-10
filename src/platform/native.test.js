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
    // The native side: reached when it's asked to turn on, answering when the test says.
    const reached = Promise.withResolvers();
    const enabled = Promise.withResolvers();
    const invoke = vi.fn(async (cmd, args) => {
      steps.push(args.action);
      if (args.action !== "enable") return { ok: true };
      reached.resolve();
      return enabled.promise;
    });
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    vi.resetModules();
    const { turnFingerprintOff, turnFingerprintOn } = await import("./fingerprint.js");
    const first = turnFingerprintOn("one");
    await expect(turnFingerprintOn("two")).resolves.toEqual({ ok: false, reason: "busy" });
    const off = turnFingerprintOff();
    // The first is with Android: nothing else is asked of it till that ends.
    await reached.promise;
    expect(steps).toEqual(["enable"]);
    enabled.resolve({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
    await off;
    expect(steps).toEqual(["enable", "disable"]);
  });
});

describe("arrival notices in the app", () => {
  it("asks Android through the app's Kotlin, and shows a notice there, saying no where there's no app", async () => {
    const asked = [];
    let allowed = true;
    const invoke = vi.fn(async (cmd, args) => {
      asked.push([cmd, args]);
      return { allowed };
    });
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    vi.resetModules();
    const { askAppNotices, showAppNotice } = await import("./notices.js");
    await expect(askAppNotices()).resolves.toBe("on");
    await expect(showAppNotice({ title: "Transaction executed", body: "Tx: ab…cd" })).resolves.toBe(true);
    allowed = false;
    await expect(askAppNotices()).resolves.toBe("off");
    expect(asked.map(([cmd, args]) => [cmd, args.action, args.args?.title])).toEqual([
      ["notices", "ask", undefined],
      ["notices", "notify", "Transaction executed"],
      ["notices", "ask", undefined],
    ]);

    // No app: no notices, and nothing asked.
    vi.stubGlobal("window", {});
    vi.resetModules();
    const outside = await import("./notices.js");
    await expect(outside.askAppNotices()).resolves.toBe("off");
  });
});
