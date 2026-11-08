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
