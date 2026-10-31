import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: null,
  getSettings: vi.fn(),
  setSettings: vi.fn(),
  getWatchedAssets: vi.fn(),
  watchToken: vi.fn(),
  unwatchToken: vi.fn(),
  watchNft: vi.fn(),
  unwatchNft: vi.fn(),
}));

vi.mock("../shared/settings.js", () => ({
  getSettings: mocks.getSettings,
  setSettings: mocks.setSettings,
}));

// The contacts store, as built on the engine's vault.
const contacts = vi.hoisted(() => ({
  store: { list: vi.fn(), upsert: vi.fn(), markChecked: vi.fn(), remove: vi.fn() },
  vault: null,
  clearContacts: vi.fn(async () => {}),
}));
vi.mock("../shared/contactsStore.js", () => ({
  contactsStore: (vault) => {
    contacts.vault = vault;
    return contacts.store;
  },
  clearContacts: contacts.clearContacts,
}));

vi.mock("../shared/assetsStore.js", () => ({
  getWatchedAssets: mocks.getWatchedAssets,
  watchToken: mocks.watchToken,
  unwatchToken: mocks.unwatchToken,
  watchNft: mocks.watchNft,
  unwatchNft: mocks.unwatchNft,
}));

import { handleUiCommand } from "./uiCommands.js";

function createAdapters(result = "result") {
  return {
    engineCall: vi.fn().mockResolvedValue(result),
    ensureEngineConfigured: vi.fn(),
    getEngineStatus: vi.fn().mockResolvedValue({
      isUnlocked: true,
      accounts: [" wallet-id "],
      selectedAccountIndex: 1,
    }),
  };
}

describe("shared UI command dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings = { accountCount: 2, nodeUrl: "https://nodes.example" };
    mocks.getSettings.mockImplementation(async () => mocks.settings);
    mocks.setSettings.mockImplementation(async (next) => {
      mocks.settings = { ...mocks.settings, ...next };
      return mocks.settings;
    });
  });

  it("leaves platform commands alone", async () => {
    const adapters = createAdapters();

    await expect(handleUiCommand({ type: "DUSK_UI_OVERVIEW" }, adapters)).resolves.toBeNull();
    expect(adapters.getEngineStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["DUSK_UI_GET_MINIMUM_STAKE", {}, "dusk_getMinimumStake", undefined, 100n, "100"],
    ["DUSK_UI_GET_STAKE_INFO", { profileIndex: 2.9 }, "dusk_getStakeInfo", { profileIndex: 2 }, {
      amount: { value: 1n, locked: 2n, eligibility: 3n, total: 4n },
      reward: 5n,
      faults: 6,
      hardFaults: 7,
    }, {
      amount: { value: "1", locked: "2", eligibility: "3", total: "4" },
      reward: "5",
      faults: 6,
      hardFaults: 7,
    }],
    ["DUSK_UI_GET_STAKE_OWNER_STATUS", {}, "dusk_getStakeOwnerStatus", { profileIndex: 1 }, "owner", "owner"],
    ["DUSK_UI_GET_SOZU_STATUS", {}, "dusk_getSozuStatus", { profileIndex: 1 }, "sozu", "sozu"],
    ["DUSK_UI_DRC20_GET_METADATA", { contractId: "c", driver: "d" }, "dusk_getDrc20Metadata", { contractId: "c", driver: "d" }, { symbol: "T" }, { symbol: "T" }],
    ["DUSK_UI_DRC20_GET_BALANCE", { contractId: "c", driver: "d", profileIndex: "invalid" }, "dusk_getDrc20Balance", { contractId: "c", profileIndex: 1, driver: "d" }, 9n, "9"],
    ["DUSK_UI_DRC20_ENCODE_INPUT", { fnName: "transfer", args: [1], driver: "d" }, "dusk_encodeDrc20Input", { fnName: "transfer", args: [1], driver: "d" }, "encoded", "encoded"],
    ["DUSK_UI_DRC20_DECODE_INPUT", { fnName: "transfer", fnArgs: "0x01", driver: "d" }, "dusk_decodeDrc20Input", { fnName: "transfer", fnArgs: "0x01", driver: "d" }, [1], [1]],
    ["DUSK_UI_DRC721_GET_METADATA", { contractId: "n" }, "dusk_getDrc721Metadata", { contractId: "n" }, { name: "NFT" }, { name: "NFT" }],
    ["DUSK_UI_DRC721_OWNER_OF", { contractId: "n", tokenId: "1" }, "dusk_getDrc721OwnerOf", { contractId: "n", tokenId: "1" }, "owner", "owner"],
    ["DUSK_UI_DRC721_TOKEN_URI", { contractId: "n", tokenId: "1" }, "dusk_getDrc721TokenUri", { contractId: "n", tokenId: "1" }, 123n, "123"],
    ["DUSK_UI_DRC721_DECODE_INPUT", { fnName: "mint", fnArgs: "0x02" }, "dusk_decodeDrc721Input", { fnName: "mint", fnArgs: "0x02" }, [2], [2]],
  ])("dispatches %s", async (type, message, method, params, engineResult, expectedResult) => {
    const adapters = createAdapters(engineResult);

    await expect(handleUiCommand({ type, ...message }, adapters)).resolves.toEqual({
      ok: true,
      result: expectedResult,
    });
    expect(adapters.ensureEngineConfigured).toHaveBeenCalledOnce();
    expect(adapters.engineCall).toHaveBeenCalledWith(method, params);
  });

  it.each([
    ["DUSK_UI_ASSETS_GET", {}, "getWatchedAssets", ["wallet-id", "https://nodes.example", 2]],
    ["DUSK_UI_ASSETS_WATCH_TOKEN", { token: { contractId: "t" } }, "watchToken", ["wallet-id", "https://nodes.example", 2, { contractId: "t" }]],
    ["DUSK_UI_ASSETS_UNWATCH_TOKEN", { contractId: "t" }, "unwatchToken", ["wallet-id", "https://nodes.example", 2, "t"]],
    ["DUSK_UI_ASSETS_WATCH_NFT", { nft: { contractId: "n", tokenId: "1" } }, "watchNft", ["wallet-id", "https://nodes.example", 2, { contractId: "n", tokenId: "1" }]],
    ["DUSK_UI_ASSETS_UNWATCH_NFT", { contractId: "n", tokenId: "1" }, "unwatchNft", ["wallet-id", "https://nodes.example", 2, "n", "1"]],
  ])("dispatches %s", async (type, message, mockName, expectedArgs) => {
    const adapters = createAdapters();
    const assetMock = mocks[mockName].mockResolvedValue("asset-result");

    await expect(
      handleUiCommand({ type, profileIndex: 2, ...message }, adapters)
    ).resolves.toEqual({ ok: true, result: "asset-result" });
    expect(assetMock).toHaveBeenCalledWith(...expectedArgs);
  });

  it("handles cached gas prices without requiring an unlocked wallet", async () => {
    const adapters = createAdapters(11n);

    await expect(
      handleUiCommand({ type: "DUSK_UI_GET_CACHED_GAS_PRICE" }, adapters)
    ).resolves.toEqual({ ok: true, result: 11n });
    expect(adapters.getEngineStatus).not.toHaveBeenCalled();
    expect(adapters.engineCall).toHaveBeenCalledWith("dusk_getCachedGasPrice");
  });

  it("updates NFT settings", async () => {
    const adapters = createAdapters();

    await expect(handleUiCommand({
      type: "DUSK_UI_SET_NFT_SETTINGS",
      ipfsGateway: "https://ipfs.example",
    }, adapters)).resolves.toEqual({
      ok: true,
      nftMetadataEnabled: false,
      ipfsGateway: "https://ipfs.example",
    });
    expect(mocks.setSettings).toHaveBeenCalledWith({
      nftMetadataEnabled: false,
      ipfsGateway: "https://ipfs.example",
    });
  });

  it("saves Hide balances, with the wallet locked or not", async () => {
    const adapters = createAdapters();

    await expect(handleUiCommand({ type: "DUSK_UI_SET_HIDE_BALANCES", hideBalances: true }, adapters)).resolves.toEqual({
      ok: true,
      hideBalances: true,
    });
    expect(mocks.setSettings).toHaveBeenCalledWith({ hideBalances: true });
    expect(adapters.getEngineStatus).not.toHaveBeenCalled();

    // Only true hides them.
    await expect(handleUiCommand({ type: "DUSK_UI_SET_HIDE_BALANCES", hideBalances: "true" }, adapters)).resolves.toEqual({
      ok: true,
      hideBalances: false,
    });
  });

  it("clamps and applies the selected account index", async () => {
    const adapters = createAdapters(true);

    await expect(handleUiCommand({
      type: "DUSK_UI_SET_ACCOUNT_INDEX",
      index: 9,
    }, adapters)).resolves.toEqual({ ok: true, result: true });
    expect(mocks.setSettings).toHaveBeenCalledWith({ selectedAccountIndex: 1 });
    expect(adapters.engineCall).toHaveBeenCalledWith("engine_selectAccount", { index: 1 });
  });

  it("sets the shielded checkpoint for the primary profile", async () => {
    const adapters = createAdapters({ bookmark: "b", block: "c" });

    await expect(handleUiCommand({
      type: "DUSK_UI_SET_SHIELDED_CHECKPOINT_NOW",
    }, adapters)).resolves.toEqual({
      ok: true,
      result: { bookmark: "b", block: "c" },
    });
    expect(adapters.engineCall).toHaveBeenCalledWith(
      "dusk_setShieldedCheckpointNow",
      { profileIndex: 0 }
    );
  });

  it("asks the contacts store for the pages' contacts, which the engine's key opens", async () => {
    const adapters = createAdapters({ namespace: "place", text: null });
    const entry = { id: "1", name: "Shop", address: "addr" };
    contacts.store.list.mockResolvedValueOnce([entry]);
    contacts.store.upsert.mockResolvedValueOnce(entry);
    contacts.store.markChecked.mockResolvedValueOnce(null);
    contacts.store.remove.mockResolvedValueOnce(undefined);
    const ask = (message) => handleUiCommand({ type: "DUSK_UI_CONTACTS", ...message }, adapters);

    await expect(ask({ op: "list", query: "sh" })).resolves.toEqual({ ok: true, result: [entry] });
    expect(contacts.store.list).toHaveBeenCalledWith({ query: "sh" });
    await expect(ask({ op: "upsert", entry })).resolves.toEqual({ ok: true, result: entry });
    expect(contacts.store.upsert).toHaveBeenCalledWith(entry);
    await expect(ask({ op: "markChecked", entry, checkedAt: 5 })).resolves.toEqual({ ok: true, result: null });
    expect(contacts.store.markChecked).toHaveBeenCalledWith(entry, 5);
    await expect(ask({ op: "remove", id: "1" })).resolves.toEqual({ ok: true, result: null });
    expect(contacts.store.remove).toHaveBeenCalledWith("1");

    // The store opens and seals through the engine, which holds the key.
    await contacts.vault.open({ place: { v: 1 } });
    await contacts.vault.seal("{}");
    expect(adapters.engineCall.mock.calls).toEqual([
      ["engine_contactsOpen", { records: { place: { v: 1 } } }],
      ["engine_contactsSeal", { text: "{}" }],
    ]);
    await expect(ask({ op: "toString" })).rejects.toMatchObject({ message: "Unknown contacts operation" });
  });

  it("deletes every contact without the engine, the wallet locked or not", async () => {
    const adapters = createAdapters();
    adapters.getEngineStatus.mockResolvedValue({ isUnlocked: false, accounts: [] });
    await expect(handleUiCommand({ type: "DUSK_UI_CONTACTS", op: "clear" }, adapters)).resolves.toEqual({ ok: true, result: true });
    expect(contacts.clearContacts).toHaveBeenCalledTimes(1);
    expect(adapters.engineCall).not.toHaveBeenCalled();
  });

  it("changes one wallet's data only for the wallet its page showed", async () => {
    const adapters = createAdapters();
    const shown = { walletId: "another-wallet" };
    for (const message of [
      { type: "DUSK_UI_SET_ACCOUNT_INDEX", index: 0 },
      { type: "DUSK_UI_ASSETS_WATCH_TOKEN", token: { contractId: "c" } },
      { type: "DUSK_UI_ASSETS_UNWATCH_TOKEN", contractId: "c" },
      { type: "DUSK_UI_ASSETS_WATCH_NFT", nft: { contractId: "c", tokenId: "1" } },
      { type: "DUSK_UI_ASSETS_UNWATCH_NFT", contractId: "c", tokenId: "1" },
      { type: "DUSK_UI_CONTACTS", op: "upsert", entry: { name: "A" } },
      { type: "DUSK_UI_CONTACTS", op: "markChecked", entry: { name: "A" } },
      { type: "DUSK_UI_CONTACTS", op: "remove", id: "1" },
    ]) {
      await expect(handleUiCommand({ ...message, ...shown }, adapters)).rejects.toMatchObject({
        code: 4100,
        message: "The wallet changed meanwhile.",
      });
    }
    expect(mocks.setSettings).not.toHaveBeenCalled();
    expect(adapters.engineCall).not.toHaveBeenCalled();
    for (const change of [mocks.watchToken, mocks.unwatchToken, mocks.watchNft, mocks.unwatchNft, contacts.store.upsert, contacts.store.markChecked, contacts.store.remove]) {
      expect(change).not.toHaveBeenCalled();
    }

    // Its own wallet, still open: made.
    await handleUiCommand({ type: "DUSK_UI_ASSETS_UNWATCH_TOKEN", contractId: "c", walletId: " wallet-id " }, adapters);
    expect(mocks.unwatchToken).toHaveBeenCalledWith("wallet-id", "https://nodes.example", 1, "c");
  });

  it("rejects commands while the wallet is locked", async () => {
    const adapters = createAdapters();
    adapters.getEngineStatus.mockResolvedValue({ isUnlocked: false, accounts: [] });

    await expect(
      handleUiCommand({ type: "DUSK_UI_GET_MINIMUM_STAKE" }, adapters)
    ).rejects.toMatchObject({ code: 4100, message: "Wallet locked" });
    expect(adapters.engineCall).not.toHaveBeenCalled();
  });
});
