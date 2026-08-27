import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeSendMessage: vi.fn(),
  settings: null,
}));

vi.mock("../shared/settings.js", () => ({
  getSettings: vi.fn(async () => mocks.settings),
}));

vi.mock("../platform/extensionApi.js", () => ({
  runtimeSendMessage: mocks.runtimeSendMessage,
}));

import { createEngineBridge } from "./engineBridge.js";

describe("engine bridge", () => {
  beforeEach(() => {
    mocks.settings = {
      nodeUrl: "https://testnet.nodes.dusk.network",
      proverUrl: "https://testnet.provers.dusk.network",
      archiverUrl: "https://testnet.nodes.dusk.network",
      accountCount: 2,
      selectedAccountIndex: 0,
    };
    mocks.runtimeSendMessage.mockReset();
  });

  it("starts the host and caches engine configuration", async () => {
    const ensureHost = vi.fn(async () => {});
    mocks.runtimeSendMessage.mockResolvedValue({ result: true });
    const bridge = createEngineBridge({ ensureHost, noResponseMessage: "No engine" });

    await bridge.ensureEngineConfigured();
    await bridge.ensureEngineConfigured();

    expect(ensureHost).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeSendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeSendMessage.mock.calls[0][0]).toMatchObject({
      type: "DUSK_ENGINE_CALL",
      method: "engine_config",
      params: mocks.settings,
    });
  });

  it("retries transient calls but never retries transaction submission", async () => {
    const bridge = createEngineBridge({ ensureHost: async () => {}, noResponseMessage: "No engine" });
    mocks.runtimeSendMessage
      .mockRejectedValueOnce(new Error("Receiving end does not exist"))
      .mockResolvedValueOnce({ result: "ready" });

    await expect(bridge.engineCall("engine_status")).resolves.toBe("ready");
    expect(mocks.runtimeSendMessage).toHaveBeenCalledTimes(2);

    mocks.runtimeSendMessage.mockReset();
    mocks.runtimeSendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    await expect(bridge.engineCall("dusk_sendTransaction")).rejects.toThrow("Receiving end does not exist");
    expect(mocks.runtimeSendMessage).toHaveBeenCalledTimes(1);
  });

  it("normalizes engine status and falls back to locked", async () => {
    const bridge = createEngineBridge({ ensureHost: async () => {}, noResponseMessage: "No engine" });
    mocks.runtimeSendMessage.mockResolvedValueOnce({
      result: { isUnlocked: 1, accounts: ["account"], addresses: ["address"], selectedAccountIndex: "1" },
    });

    await expect(bridge.getEngineStatus()).resolves.toEqual({
      isUnlocked: true,
      accounts: ["account"],
      addresses: ["address"],
      selectedAccountIndex: 1,
    });

    mocks.runtimeSendMessage.mockRejectedValueOnce(new Error("offline"));
    await expect(bridge.getEngineStatus()).resolves.toEqual({
      isUnlocked: false,
      accounts: [],
      addresses: [],
      selectedAccountIndex: 0,
    });
  });
});
