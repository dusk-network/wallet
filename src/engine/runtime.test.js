import { describe, expect, it, vi } from "vitest";

import { toBytes } from "../shared/bytes.js";

const mocks = vi.hoisted(() => ({
  addListener: vi.fn(),
  runtimeSendMessage: vi.fn(async () => undefined),
  lookupPrimaryName: vi.fn(async () => "alice.dusk"),
  lookupRecipientName: vi.fn(async () => "carol.dusk"),
  unlocked: true,
}));

vi.mock("../platform/extensionApi.js", () => ({
  getExtensionApi: () => ({ runtime: { onMessage: { addListener: mocks.addListener } } }),
  runtimeSendMessage: mocks.runtimeSendMessage,
}));

vi.mock("../shared/walletEngine.js", async (importOriginal) => ({
  ...(await importOriginal()),
  encodeDrc20Input: vi.fn(async () => new Uint8Array([0, 255])),
  encodeDrc721Input: vi.fn(async () => new Uint8Array([0, 255])),
  preloadProtocolDriver: vi.fn(async () => undefined),
  isUnlocked: vi.fn(() => mocks.unlocked),
  getAccounts: vi.fn(() => ["own0", "own1"]),
}));

vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: mocks.lookupPrimaryName,
  lookupRecipientName: mocks.lookupRecipientName,
}));

await import("./runtime.js");
const listener = mocks.addListener.mock.calls[0][0];

function engineCall(method, params) {
  return new Promise((resolve) => {
    listener({ type: "DUSK_ENGINE_CALL", id: method, method, params }, null, resolve);
  });
}

describe("engine byte responses", () => {
  it.each(["dusk_encodeDrc20Input", "dusk_encodeDrc721Input"])(
    "serializes %s before extension messaging",
    async (method) => {
      const response = JSON.parse(JSON.stringify(await engineCall(method)));

      expect(response.result).toBe("0x00ff");
      expect(toBytes(response.result)).toEqual(new Uint8Array([0, 255]));
    }
  );
});

describe("engine name checks", () => {
  const nodeUrl = "https://testnet.nodes.dusk.network";

  it("checks the .dusk names of the wallet's own accounts only, through the wallet's node", async () => {
    mocks.lookupPrimaryName.mockClear();
    await expect(
      engineCall("engine_checkNames", { nodeUrl, accounts: ["own1", "someone-else", "own0"] })
    ).resolves.toEqual({ id: "engine_checkNames", result: true });
    expect(mocks.lookupPrimaryName.mock.calls).toEqual([
      ["own1", { nodeUrl }],
      ["own0", { nodeUrl }],
    ]);
  });

  it("checks nothing while locked", async () => {
    mocks.lookupPrimaryName.mockClear();
    mocks.unlocked = false;
    try {
      await expect(engineCall("engine_checkNames", { nodeUrl, accounts: ["own0"] })).resolves.toEqual({
        id: "engine_checkNames",
        result: true,
      });
      expect(mocks.lookupPrimaryName).not.toHaveBeenCalled();
    } finally {
      mocks.unlocked = true;
    }
  });

  it("looks up the name of a site request's recipient through the approval's node", async () => {
    await expect(engineCall("engine_recipientName", { nodeUrl, recipient: "someone" })).resolves.toEqual({
      id: "engine_recipientName",
      result: "carol.dusk",
    });
    expect(mocks.lookupRecipientName).toHaveBeenCalledWith("someone", { nodeUrl });
    expect(mocks.lookupPrimaryName).not.toHaveBeenCalledWith("someone", expect.anything());
  });
});
