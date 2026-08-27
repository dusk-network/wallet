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

  it("rejects commands while the wallet is locked", async () => {
    const adapters = createAdapters();
    adapters.getEngineStatus.mockResolvedValue({ isUnlocked: false, accounts: [] });

    await expect(
      handleUiCommand({ type: "DUSK_UI_GET_MINIMUM_STAKE" }, adapters)
    ).rejects.toMatchObject({ code: 4100, message: "Wallet locked" });
    expect(adapters.engineCall).not.toHaveBeenCalled();
  });
});
