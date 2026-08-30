import { describe, expect, it, vi } from "vitest";

import { toBytes } from "../shared/bytes.js";

const mocks = vi.hoisted(() => ({
  addListener: vi.fn(),
  runtimeSendMessage: vi.fn(async () => undefined),
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
}));

await import("./runtime.js");
const listener = mocks.addListener.mock.calls[0][0];

function engineCall(method) {
  return new Promise((resolve) => {
    listener({ type: "DUSK_ENGINE_CALL", id: method, method }, null, resolve);
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
