import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Chen's on Firefox for Android: opened with no signal, the wallet showed "—" for every balance while saying
// they "may be out of date". Lena's: the stake's figure kept, but nothing said it couldn't be read.

function memoryStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => store.get(String(k)) ?? null,
    setItem: (k, v) => store.set(String(k), String(v)),
    removeItem: (k) => store.delete(String(k)),
    clear: () => store.clear(),
  };
}

const NODE = "https://testnet.nodes.dusk.network";
const place = { nodeUrl: NODE, account: "profile-1-account" };
const read = { balance: { nonce: "4", value: "857535243" }, shieldedBalance: { value: "0", spendable: "0" }, staked: { lux: "247500000", native: "0", sozu: "247500000" } };

let kept;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 12, 19, 52));
  vi.stubGlobal("localStorage", memoryStorage());
  vi.resetModules();
  kept = await import("./keptBalances.js");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the balances read last, kept on the device", () => {
  it("fill in what can't be read now, each said to be maybe out of date, with when the balance was read", async () => {
    const readAt = Date.now();
    await expect(kept.withKeptBalances(place, read)).resolves.toEqual({});

    // No signal, an hour on: nothing read; what was read last, said so.
    vi.setSystemTime(readAt + 60 * 60_000);
    await expect(kept.withKeptBalances(place, { balance: null, shieldedBalance: null, staked: null }, { stakeRead: false })).resolves.toEqual({
      balance: read.balance,
      balanceStale: true,
      balanceReadAt: readAt,
      shieldedBalance: read.shieldedBalance,
      shieldedStale: true,
      staked: read.staked,
      stakeStale: true,
    });

    // The public balance read, the stake not: the stake alone is kept and said so; the balance read now is kept.
    const now = { ...read.balance, value: "800000000" };
    await expect(kept.withKeptBalances(place, { ...read, balance: now, staked: null }, { stakeRead: false })).resolves.toEqual({ staked: read.staked, stakeStale: true });
    await expect(kept.keptBalancesOf(place)).resolves.toMatchObject({ balance: now, balanceAt: Date.now() });
  });

  it("are a profile's on a node alone: another profile, or another node, has none of them", async () => {
    await kept.withKeptBalances(place, read);
    await expect(kept.withKeptBalances({ ...place, account: "profile-2-account" }, { balance: null })).resolves.toEqual({});
    await expect(kept.withKeptBalances({ ...place, nodeUrl: "https://nodes.dusk.network" }, { balance: null })).resolves.toEqual({});
  });

  it("go with the wallet: a removed wallet's profiles' alone, and every one on a reset", async () => {
    await kept.withKeptBalances(place, read);
    await kept.withKeptBalances({ ...place, account: "other-wallet-account" }, read);
    await kept.forgetKeptBalances(["profile-1-account"]);
    await expect(kept.keptBalancesOf(place)).resolves.toBeNull();
    await expect(kept.keptBalancesOf({ ...place, account: "other-wallet-account" })).resolves.not.toBeNull();

    const { clearWalletData } = await import("./walletReset.js");
    await clearWalletData().catch(() => {});
    await expect(kept.keptBalancesOf({ ...place, account: "other-wallet-account" })).resolves.toBeNull();
  });
});
