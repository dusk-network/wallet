import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./storage.js", () => {
  let store = {};
  return {
    storage: {
      get: async (key) => (store[key] === undefined ? {} : { [key]: structuredClone(store[key]) }),
      set: async (items) => Object.assign(store, structuredClone(items)),
      remove: async (keys) => {
        for (const k of [keys].flat()) delete store[k];
      },
    },
    STORAGE_KEYS: { WALLETS: "dusk_wallets_v1" },
    __reset: () => {
      store = {};
    },
  };
});

let wallets;
beforeEach(async () => {
  vi.resetModules();
  (await import("./storage.js")).__reset();
  wallets = await import("./wallets.js");
});

describe("wallets", () => {
  it("names a wallet by its number until it's given a name", () => {
    expect(wallets.walletLabel({ n: 2 })).toBe("Wallet 2");
    expect(wallets.walletLabel({ n: 2, name: "  Savings   jar " })).toBe("Savings jar");
    expect(wallets.normalizeWalletName("x".repeat(40))).toHaveLength(32);
  });

  it("numbers the next wallet one past the highest here, as the vault does", () => {
    expect(wallets.nextWalletNumber([{ n: 1 }, { n: 2 }])).toBe(3);
    // A removed wallet's number isn't given again.
    expect(wallets.nextWalletNumber([{ n: 1 }, { n: 3 }])).toBe(4);
    expect(wallets.nextWalletNumber([])).toBe(1);
  });

  it("keeps what each wallet showed, and the one unlocked last", async () => {
    await expect(wallets.activeWalletId()).resolves.toBe("");
    await wallets.noteActiveWallet("k1", { walletId: "acct-a0", accounts: ["acct-a0", "acct-a1"] });
    await wallets.setWalletName("k1", "Main");
    await wallets.noteActiveWallet("k2", { walletId: "acct-b0", accounts: ["acct-b0", "acct-b1"] });

    await expect(wallets.activeWalletId()).resolves.toBe("acct-b0");
    await expect(wallets.getWalletDirectory()).resolves.toEqual({
      active: "k2",
      wallets: {
        k1: { walletId: "acct-a0", accounts: ["acct-a0", "acct-a1"], name: "Main" },
        k2: { walletId: "acct-b0", accounts: ["acct-b0", "acct-b1"] },
      },
    });

    // Noted again, it keeps its name; "" gives it its number back.
    await wallets.noteActiveWallet("k1", { walletId: "acct-a0", accounts: ["acct-a0", "acct-a1"] });
    expect((await wallets.getWalletDirectory()).wallets.k1.name).toBe("Main");
    await wallets.setWalletName("k1", " ");
    expect((await wallets.getWalletDirectory()).wallets.k1).not.toHaveProperty("name");
  });

  it("forgets a removed wallet, and every wallet on a reset", async () => {
    await wallets.noteActiveWallet("k1", { walletId: "a", accounts: ["a"] });
    await wallets.noteActiveWallet("k2", { walletId: "b", accounts: ["b"] });
    await wallets.forgetWallet("k2");
    await expect(wallets.getWalletDirectory()).resolves.toEqual({ active: "", wallets: { k1: { walletId: "a", accounts: ["a"] } } });
    await wallets.clearWallets();
    await expect(wallets.getWalletDirectory()).resolves.toEqual({ active: "", wallets: {} });
  });
});
