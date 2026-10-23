import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NETWORK_PRESETS } from "../shared/networkPresets.js";

const mocks = vi.hoisted(() => ({ accounts: [], status: null }));

vi.mock("@duskdomains/sdk/lens-reader", async (importOriginal) => ({
  ...(await importOriginal()),
  createLensReader: vi.fn(),
}));
vi.mock("../shared/walletEngine.js", async (importOriginal) => ({
  ...(await importOriginal()),
  preloadProtocolDriver: vi.fn(async () => undefined),
  isUnlocked: vi.fn(() => true),
  getAccounts: vi.fn(() => mocks.accounts),
}));
vi.mock("../background/engineHost.js", () => ({
  engineCall: vi.fn(async () => true),
  getEngineStatus: vi.fn(async () => mocks.status),
}));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const OTHER =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const TESTNET = NETWORK_PRESETS.find((preset) => preset.id === "testnet").nodeUrl;
const page = (file) => `chrome-extension://wallet/${file}`;
const ENGINE = { id: "wallet", url: page("offscreen.html") };

afterEach(() => {
  vi.unstubAllGlobals();
});

// Chrome's offscreen document, where the engine runs: chrome.runtime and
// nothing else, so no storage.
async function loadEngine() {
  const sent = [];
  let listener = null;
  vi.stubGlobal("chrome", {
    runtime: {
      id: "wallet",
      getURL: page,
      sendMessage: (message, respond) => {
        sent.push(message);
        respond?.({ ok: true });
      },
      onMessage: { addListener: (fn) => (listener = fn) },
    },
  });
  vi.resetModules();
  const lens = await import("@duskdomains/sdk/lens-reader");
  lens.createLensReader.mockResolvedValue({
    verifyPrimary: async () => ({ store: "", primary: { spelling: "alice.dusk" }, height: 1n }),
  });
  await import("../engine/runtime.js");
  const call = (method, params) =>
    new Promise((resolve) => listener({ type: "DUSK_ENGINE_CALL", id: method, method, params }, null, resolve));
  return { sent, call };
}

// The background, with the extension's storage.
async function loadBackground(store) {
  vi.stubGlobal("chrome", {
    runtime: { id: "wallet", getURL: page, sendMessage: () => {}, onMessage: { addListener: () => {} } },
    storage: {
      local: {
        get: (key, respond) => respond(key in store ? { [key]: structuredClone(store[key]) } : {}),
        set: (items, respond) => {
          Object.assign(store, structuredClone(items));
          respond();
        },
      },
    },
  });
  vi.resetModules();
  return import("../background/siteNames.js");
}

describe("integration: .dusk name checks from the engine", () => {
  it("land in the background's storage, though the engine has none", async () => {
    mocks.accounts = [ACCOUNT];
    const engine = await loadEngine();
    await expect(engine.call("engine_checkNames", { nodeUrl: TESTNET, accounts: [ACCOUNT] })).resolves.toEqual({
      id: "engine_checkNames",
      result: true,
    });
    const checked = engine.sent.filter((message) => message.type === "DUSK_NAME_CHECKED");
    expect(checked).toEqual([{ type: "DUSK_NAME_CHECKED", nodeUrl: TESTNET, account: ACCOUNT, name: "alice.dusk" }]);

    const store = {};
    mocks.status = { isUnlocked: true, accounts: [ACCOUNT] };
    const background = await loadBackground(store);
    await expect(background.keepEngineNameCheck(checked[0], ENGINE)).resolves.toBe(true);
    expect(store.dusk_verified_names_v1).toEqual({
      testnet: { [ACCOUNT]: { name: "alice.dusk", at: expect.any(Number) } },
    });
    await expect(background.siteNames(TESTNET)).resolves.toEqual(new Map([[ACCOUNT, "alice.dusk"]]));
  });

  it("are taken only from the engine's own page, for the unlocked wallet's own accounts", async () => {
    const store = {};
    mocks.status = { isUnlocked: true, accounts: [ACCOUNT] };
    const { keepEngineNameCheck } = await loadBackground(store);
    const check = { type: "DUSK_NAME_CHECKED", nodeUrl: TESTNET, account: ACCOUNT, name: "alice.dusk" };

    // A content script, the popup or another extension's engine page is not the engine.
    for (const sender of [
      { id: "wallet", url: "https://dapp.example/page", tab: { id: 1 } },
      { id: "wallet", url: page("popup.html") },
      { id: "other", url: "chrome-extension://other/offscreen.html" },
      { id: "wallet" },
      undefined,
    ]) {
      await expect(keepEngineNameCheck(check, sender)).resolves.toBe(false);
    }
    // Another account, a name that isn't one, or a locked wallet.
    await expect(keepEngineNameCheck({ ...check, account: OTHER }, ENGINE)).resolves.toBe(false);
    for (const name of ["alice", 7, undefined]) {
      await expect(keepEngineNameCheck({ ...check, name }, ENGINE)).resolves.toBe(false);
    }
    mocks.status = { isUnlocked: false, accounts: [] };
    await expect(keepEngineNameCheck(check, ENGINE)).resolves.toBe(false);
    expect(store).toEqual({});

    // Firefox's engine page is the engine too, and "no name" is an answer.
    mocks.status = { isUnlocked: true, accounts: [ACCOUNT] };
    await expect(keepEngineNameCheck({ ...check, name: null }, { url: page("engine.html") })).resolves.toBe(true);
    expect(store.dusk_verified_names_v1.testnet[ACCOUNT].name).toBeNull();
  });

  it("are passed to the background with their sender", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src", "background", "index.js"), "utf8");
    expect(source).toMatch(/message\?\.type === "DUSK_NAME_CHECKED"[\s\S]*?keepEngineNameCheck\(message, sender\)/);
  });
});
