import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NETWORK_PRESETS } from "./networkPresets.js";

const mocks = vi.hoisted(() => ({ store: {}, extension: true, broken: false }));

vi.mock("./storage.js", () => ({
  storage: {
    get: vi.fn(async (key) => {
      if (mocks.broken) throw new Error("storage unavailable");
      return key in mocks.store ? { [key]: structuredClone(mocks.store[key]) } : {};
    }),
    set: vi.fn(async (items) => {
      if (mocks.broken) throw new Error("storage unavailable");
      Object.assign(mocks.store, structuredClone(items));
    }),
  },
  STORAGE_KEYS: { VERIFIED_NAMES: "dusk_verified_names_v1" },
}));
vi.mock("../platform/runtime.js", () => ({ isExtensionRuntime: () => mocks.extension }));

const nodeUrl = (id) => NETWORK_PRESETS.find((preset) => preset.id === id).nodeUrl;
const MAINNET = nodeUrl("mainnet");
const TESTNET = nodeUrl("testnet");
const NAMES_OFF = [nodeUrl("devnet"), nodeUrl("local"), "https://rusk.example.com", undefined];
const ACCOUNT = "account-a";
const OTHER = "account-b";
const MINUTE = 60_000;

let names;

beforeEach(async () => {
  mocks.store = {};
  mocks.extension = true;
  mocks.broken = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.resetModules();
  names = await import("./verifiedNames.js");
});

afterEach(() => {
  vi.useRealTimers();
});

const namesOn = async (url) => names.verifiedNamesFor(await names.readVerifiedNames(), url);

describe("verified names", () => {
  it("gives a name for ten minutes after its check, on the network it was checked on", async () => {
    await names.rememberVerifiedName(TESTNET, ACCOUNT, "alice.dusk");
    await names.rememberVerifiedName(MAINNET, ACCOUNT, "main.dusk");
    expect(mocks.store.dusk_verified_names_v1).toEqual({
      testnet: { [ACCOUNT]: { name: "alice.dusk", at: Date.now() } },
      mainnet: { [ACCOUNT]: { name: "main.dusk", at: Date.now() } },
    });

    expect(await namesOn(TESTNET)).toEqual(new Map([[ACCOUNT, "alice.dusk"]]));
    expect(await namesOn(MAINNET)).toEqual(new Map([[ACCOUNT, "main.dusk"]]));
    for (const url of NAMES_OFF) expect(await namesOn(url)).toEqual(new Map());

    vi.advanceTimersByTime(10 * MINUTE - 1);
    expect((await namesOn(TESTNET)).get(ACCOUNT)).toBe("alice.dusk");
    vi.advanceTimersByTime(1);
    expect(await namesOn(TESTNET)).toEqual(new Map());
  });

  it("keeps an account that has no name as having none", async () => {
    await names.rememberVerifiedName(TESTNET, ACCOUNT, "alice.dusk");
    await names.rememberVerifiedName(TESTNET, ACCOUNT, null);
    expect(mocks.store.dusk_verified_names_v1.testnet[ACCOUNT]).toEqual({ name: null, at: Date.now() });
    expect(await namesOn(TESTNET)).toEqual(new Map());
  });

  it("checks again an account not checked in the last minute, where names are on", async () => {
    expect(names.namesToRecheck({}, TESTNET, [ACCOUNT, OTHER])).toEqual([ACCOUNT, OTHER]);

    await names.rememberVerifiedName(TESTNET, ACCOUNT, null);
    const all = await names.readVerifiedNames();
    expect(names.namesToRecheck(all, TESTNET, [ACCOUNT, OTHER])).toEqual([OTHER]);
    // A check on one network is none on the other.
    expect(names.namesToRecheck(all, MAINNET, [ACCOUNT])).toEqual([ACCOUNT]);
    for (const url of NAMES_OFF) expect(names.namesToRecheck(all, url, [ACCOUNT])).toEqual([]);

    vi.advanceTimersByTime(MINUTE);
    expect(names.namesToRecheck(all, TESTNET, [ACCOUNT, OTHER])).toEqual([ACCOUNT, OTHER]);
  });

  it("drops checks over ten minutes old when it keeps a new one", async () => {
    await names.rememberVerifiedName(TESTNET, ACCOUNT, "alice.dusk");
    vi.advanceTimersByTime(10 * MINUTE);
    await names.rememberVerifiedName(MAINNET, OTHER, "bob.dusk");
    expect(mocks.store.dusk_verified_names_v1).toEqual({
      mainnet: { [OTHER]: { name: "bob.dusk", at: Date.now() } },
    });
  });

  it("gives no name for what isn't a check made since", async () => {
    const now = Date.now();
    const all = {
      testnet: {
        a: { name: 7, at: now },
        b: { name: "bob", at: now },
        c: { name: "carol.dusk", at: "soon" },
        d: { name: "dave.dusk", at: now + MINUTE },
        e: null,
      },
    };
    expect(names.verifiedNamesFor(all, TESTNET)).toEqual(new Map());
    expect(names.verifiedNamesFor(null, TESTNET)).toEqual(new Map());
  });

  it("keeps nothing outside the extension, where no site gets names, or where names are off", async () => {
    mocks.extension = false;
    await names.rememberVerifiedName(TESTNET, ACCOUNT, "alice.dusk");
    mocks.extension = true;
    for (const url of NAMES_OFF) await names.rememberVerifiedName(url, ACCOUNT, "alice.dusk");
    expect(mocks.store).toEqual({});
  });

  it("reads names on a custom node's network once the node gave its chain ID, never by its name", async () => {
    const custom = "https://testnet.example.org";
    expect(names.duskNamesNetwork(custom)).toBeNull();
    (await import("./nodeNetwork.js")).noteChainId(custom, 2);
    expect(names.duskNamesNetwork(`${custom}/rusk`)).toBe("testnet");
    expect([names.duskNamesNetwork(MAINNET), names.duskNamesNetwork(TESTNET), ...NAMES_OFF.map((url) => names.duskNamesNetwork(url))]).toEqual([
      "mainnet",
      "testnet",
      null,
      null,
      null,
      null,
    ]);
  });

  it("never throws when storage fails", async () => {
    mocks.broken = true;
    await expect(names.rememberVerifiedName(TESTNET, ACCOUNT, "alice.dusk")).resolves.toBeUndefined();
    await expect(names.readVerifiedNames()).resolves.toEqual({});
  });
});
