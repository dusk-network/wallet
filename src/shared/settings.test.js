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
