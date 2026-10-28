import { beforeEach, describe, expect, it, vi } from "vitest";

let value;

vi.mock("./storage.js", () => ({
  storage: {
    get: vi.fn(async (key) => value ? { [key]: value } : {}),
    set: vi.fn(async (record) => { value = Object.values(record)[0]; }),
  },
  STORAGE_KEYS: { SETTINGS: "settings" },
}));

describe("settings", () => {
  beforeEach(() => {
    value = undefined;
    vi.resetModules();
  });

  it("does not lose concurrent patches", async () => {
    const { getSettings, setSettings } = await import("./settings.js");
    await Promise.all([
      setSettings({ autoLockTimeoutMinutes: 15 }),
      setSettings({ selectedAccountIndex: 1 }),
    ]);

    await expect(getSettings()).resolves.toMatchObject({
      autoLockTimeoutMinutes: 15,
      selectedAccountIndex: 1,
    });
  });

  it("auto-locks after 15 minutes by default, and offers 5, 15 and Off only", async () => {
    const { AUTO_LOCK_OPTIONS, getSettings, setSettings } = await import("./settings.js");
    expect(AUTO_LOCK_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      [5, "5 minutes"],
      [15, "15 minutes"],
      [0, "Off"],
    ]);
    await expect(getSettings()).resolves.toMatchObject({ autoLockTimeoutMinutes: 15 });
    // What earlier versions offered becomes the nearest that's still offered.
    for (const [stored, used] of [[1, 5], [30, 15], [60, 15], [0, 0], [5, 5]]) {
      await setSettings({ autoLockTimeoutMinutes: stored });
      await expect(getSettings()).resolves.toMatchObject({ autoLockTimeoutMinutes: used });
    }
  });

  it("keeps custom gas only as a whole limit and price, else the network's price", async () => {
    const { getSettings, normalizeCustomGas, setSettings } = await import("./settings.js");
    await expect(getSettings()).resolves.toMatchObject({ customGas: null });
    await setSettings({ customGas: { limit: "3000000", price: "2" } });
    await expect(getSettings()).resolves.toMatchObject({ customGas: { limit: "3000000", price: "2" } });
    expect([normalizeCustomGas({ limit: "3000000" }), normalizeCustomGas({ limit: "0", price: "1" }), normalizeCustomGas(null)]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("keeps balances shown until Hide balances is turned on, and remembers it", async () => {
    const { getSettings, setSettings } = await import("./settings.js");
    await expect(getSettings()).resolves.toMatchObject({ hideBalances: false });

    await setSettings({ hideBalances: true });
    await expect(getSettings()).resolves.toMatchObject({ hideBalances: true });
    await setSettings({ hideBalances: false });
    await expect(getSettings()).resolves.toMatchObject({ hideBalances: false });

    // Only true hides them.
    value = { hideBalances: "yes" };
    await expect(getSettings()).resolves.toMatchObject({ hideBalances: false });
  });
});
