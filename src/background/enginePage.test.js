import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeSendMessage: vi.fn(),
  tabsCreate: vi.fn(async () => ({ id: 7 })),
  tabsGet: vi.fn(async () => ({ id: 7 })),
  tabsQuery: vi.fn(async () => []),
}));

vi.mock("../shared/settings.js", () => ({
  getSettings: vi.fn(async () => ({ nodeUrl: "https://testnet.nodes.dusk.network" })),
}));

vi.mock("../platform/extensionApi.js", () => ({
  getExtensionApi: () => ({
    tabs: {
      hide: vi.fn(),
      onRemoved: { addListener: vi.fn() },
    },
  }),
  runtimeGetURL: (path) => `moz-extension://wallet/${path}`,
  runtimeSendMessage: mocks.runtimeSendMessage,
  tabsCreate: mocks.tabsCreate,
  tabsGet: mocks.tabsGet,
  tabsHide: vi.fn(async () => {}),
  tabsQuery: mocks.tabsQuery,
}));

describe("Firefox engine page", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.runtimeSendMessage.mockImplementation(async (message) => {
      if (message.type === "DUSK_ENGINE_PING") return { ok: true, ready: false };
      if (message.method === "engine_status") {
        return { result: { isUnlocked: true, accounts: ["acct0"] } };
      }
      if (message.method === "engine_lock") return { result: true };
      return { result: true };
    });
  });

  it("keeps status and lock available when protocol preload hangs or fails", async () => {
    const page = await import("./enginePage.js");

    await expect(page.getEngineStatusStrict()).resolves.toMatchObject({
      isUnlocked: true,
      accounts: ["acct0"],
    });

    page.handleEngineReady({
      type: "DUSK_ENGINE_READY",
      ok: false,
      error: "protocol preload failed",
    });

    await expect(page.engineCall("engine_lock")).resolves.toBe(true);
    await expect(page.engineCall("engine_config", {})).rejects.toThrow("protocol preload failed");
  });
});
