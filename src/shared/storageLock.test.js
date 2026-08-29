import { afterEach, describe, expect, it, vi } from "vitest";

import { withStorageLock } from "./storageLock.js";

afterEach(() => vi.unstubAllGlobals());

describe("storage lock", () => {
  it("uses a cross-context Web Lock when available", async () => {
    const request = vi.fn(async (_name, fn) => fn());
    vi.stubGlobal("navigator", { locks: { request } });

    await expect(withStorageLock("settings", () => 42)).resolves.toBe(42);
    expect(request).toHaveBeenCalledWith("dusk-wallet:settings", expect.any(Function));
  });
});
