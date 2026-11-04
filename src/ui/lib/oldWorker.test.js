import { describe, expect, it, vi } from "vitest";

import { reloadOldWorker } from "./oldWorker.js";

function setup(reply, version = "0.4.0") {
  const kept = {};
  const api = { runtime: { getManifest: () => ({ version }), reload: vi.fn() } };
  const kv = {
    get: async (key) => ({ [key]: kept[key] }),
    set: async (items) => Object.assign(kept, items),
  };

  return { api, ask: async () => reply, kv };
}

describe("reloadOldWorker", () => {
  it("leaves a worker of this version running", async () => {
    const deps = setup({ ok: true, version: "0.4.0" });

    expect(await reloadOldWorker(deps)).toBe(false);
    expect(deps.api.runtime.reload).not.toHaveBeenCalled();
  });

  it.each([
    ["doesn't know the question", { error: "Unknown message", ok: false }],
    ["says it's another version", { ok: true, version: "0.3.0" }],
  ])("reloads for a worker that %s, once for this version", async (_, reply) => {
    const deps = setup(reply);

    expect(await reloadOldWorker(deps)).toBe(true);
    expect(await reloadOldWorker(deps)).toBe(false);
    expect(deps.api.runtime.reload).toHaveBeenCalledOnce();
  });

  it("tries again for the next version", async () => {
    const deps = setup({ error: "Unknown message", ok: false });

    await reloadOldWorker(deps);
    deps.api.runtime.getManifest = () => ({ version: "0.5.0" });

    expect(await reloadOldWorker(deps)).toBe(true);
    expect(deps.api.runtime.reload).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["no answer", undefined],
    ["another error", { error: { message: "Wallet is locked" } }],
  ])("reloads for nothing on %s", async (_, reply) => {
    const deps = setup(reply);

    expect(await reloadOldWorker(deps)).toBe(false);
    expect(deps.api.runtime.reload).not.toHaveBeenCalled();
  });

  it("does nothing outside an extension", async () => {
    const ask = vi.fn();

    expect(await reloadOldWorker({ api: null, ask })).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });
});
