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

  it("keeps a node's chain ID with it: a network's own node's without asking, none for another node until it's read", async () => {
    const { getSettings, setSettings } = await import("./settings.js");
    // Mainnet by default, and settings kept before chain IDs were: a network's own node needs none.
    await expect(getSettings()).resolves.toMatchObject({ nodeUrl: "https://nodes.dusk.network", chainId: 1 });
    value = { nodeUrl: "https://testnet.nodes.dusk.network" };
    await expect(getSettings()).resolves.toMatchObject({ chainId: 2 });

    // A custom node, as Settings or a site's switch saves it with what it said.
    await setSettings({ nodeUrl: "https://my-node.example", chainId: 2 });
    await expect(getSettings()).resolves.toMatchObject({ nodeUrl: "https://my-node.example", chainId: 2 });
    // Other settings keep it; another node doesn't inherit it.
    await setSettings({ autoLockTimeoutMinutes: 5 });
    await expect(getSettings()).resolves.toMatchObject({ chainId: 2 });
    await setSettings({ nodeUrl: "https://other-node.example" });
    await expect(getSettings()).resolves.toMatchObject({ nodeUrl: "https://other-node.example", chainId: null });
    await setSettings({ nodeUrl: "https://nodes.dusk.network" });
    await expect(getSettings()).resolves.toMatchObject({ chainId: 1 });
  });

  it("names the node's network for anything in this context that loads the settings, a worker just woken included", async () => {
    value = { nodeUrl: "https://my-node.example", chainId: 2 };
    const { getSettings } = await import("./settings.js");
    const { networkForNode } = await import("./nodeNetwork.js");
    expect(networkForNode("https://my-node.example")).toBeNull();
    await getSettings();
    expect(networkForNode("https://my-node.example")?.name).toBe("testnet");
  });

  it("keeps a chain ID read later only while the settings still name that node", async () => {
    const { getSettings, rememberNodeChain, setSettings } = await import("./settings.js");
    await setSettings({ nodeUrl: "https://my-node.example" });
    await expect(rememberNodeChain("https://my-node.example/", 2)).resolves.toBe(true);
    await expect(rememberNodeChain("https://my-node.example", 2)).resolves.toBe(false);
    await expect(rememberNodeChain("https://my-node.example", "2")).resolves.toBe(false);
    // A read that finished after a switch, even at once, leaves the switch's node alone.
    await Promise.all([setSettings({ nodeUrl: "https://other-node.example", chainId: 1 }), rememberNodeChain("https://my-node.example", 3)]);
    await expect(getSettings()).resolves.toMatchObject({ nodeUrl: "https://other-node.example", chainId: 1 });
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
