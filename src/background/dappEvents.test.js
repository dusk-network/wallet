import { describe, expect, it, vi, beforeEach } from "vitest";

let permissions = {};
let settings = { nodeUrl: "https://testnet.nodes.dusk.network" };
let engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"] };

vi.mock("../shared/settings.js", () => ({
  getSettings: vi.fn(async () => settings),
}));

vi.mock("../shared/permissions.js", () => ({
  getPermissions: vi.fn(async () => permissions),
}));

vi.mock("./engineHost.js", () => ({
  getEngineStatus: vi.fn(async () => engineStatus),
}));

vi.mock("../platform/extensionApi.js", () => ({
  getExtensionApi: () => ({
    storage: { onChanged: { addListener: () => {} } },
  }),
}));

class FakeEvent {
  #listeners = [];
  addListener(cb) {
    this.#listeners.push(cb);
  }
  emit(...args) {
    for (const cb of this.#listeners) cb(...args);
  }
}

class FakePort {
  name = "DUSK_DAPP_PORT";
  sender;
  messages = [];
  onDisconnect = new FakeEvent();
  onMessage = new FakeEvent();

  constructor(origin, tabId = 1) {
    this.sender = {
      url: `${origin}/page`,
      tab: { id: tabId, url: `${origin}/page` },
    };
  }

  postMessage(msg) {
    this.messages.push(msg);
  }
}

describe("dappEvents", () => {
  beforeEach(() => {
    permissions = {};
    settings = { nodeUrl: "https://testnet.nodes.dusk.network" };
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"] };
    vi.resetModules();
  });

  it("does not leak all profiles when accountIndex is out of bounds", async () => {
    permissions = {
      "https://dapp.example": {
        profileId: "account:999:missing",
        accountIndex: 999,
        grants: { publicAccount: true, shieldedReceiveAddress: true },
        connectedAt: 1,
        updatedAt: 1,
      },
    };

    const ev = await import("./dappEvents.js");

    const port = new FakePort("https://dapp.example");
    ev.registerDappPort(port);
    await new Promise((r) => setTimeout(r, 0));

    // initPortForOrigin() posts DUSK_PROVIDER_STATE immediately.
    const stateMsg = port.messages.find((m) => m?.type === "DUSK_PROVIDER_STATE");
    expect(stateMsg).toBeTruthy();
    expect(stateMsg.state).toMatchObject({
      isConnected: true,
      profiles: [],
      chainId: "dusk:2",
    });

    // profilesChanged should also emit [] (not the full list).
    await ev.broadcastProfilesChangedAll();
    const profileMsgs = port.messages.filter(
      (m) => m?.type === "DUSK_PROVIDER_EVENT" && m?.name === "profilesChanged"
    );
    expect(profileMsgs.at(-1)?.data).toEqual([]);
  });

  it("emits profilesChanged when an origin's selected profile changes", async () => {
    // Start connected to profile 0
    permissions = {
      "https://dapp.example": {
        profileId: "account:0:acct0",
        accountIndex: 0,
        grants: { publicAccount: true, shieldedReceiveAddress: false },
        connectedAt: 1,
        updatedAt: 1,
      },
    };

    const ev = await import("./dappEvents.js");

    const port = new FakePort("https://dapp.example");
    ev.registerDappPort(port);
    await new Promise((r) => setTimeout(r, 0));

    // Change permission selection to profile 1
    const oldP = { ...permissions };
    const newP = {
      "https://dapp.example": {
        profileId: "account:1:acct1",
        accountIndex: 1,
        grants: { publicAccount: true, shieldedReceiveAddress: false },
        connectedAt: 1,
        updatedAt: 2,
      },
    };
    permissions = newP;

    await ev.handlePermissionsDiff(oldP, newP);

    const profileMsgs = port.messages.filter(
      (m) => m?.type === "DUSK_PROVIDER_EVENT" && m?.name === "profilesChanged"
    );
    expect(profileMsgs.at(-1)?.data).toEqual([{ profileId: "account:1:acct1", account: "acct1" }]);
  });

  it("emits profilesChanged when shielded grant changes on the same profile", async () => {
    permissions = {
      "https://dapp.example": {
        profileId: "account:0:acct0",
        accountIndex: 0,
        grants: { publicAccount: true, shieldedReceiveAddress: false },
        connectedAt: 1,
        updatedAt: 1,
      },
    };

    const ev = await import("./dappEvents.js");

    const port = new FakePort("https://dapp.example");
    ev.registerDappPort(port);
    await new Promise((r) => setTimeout(r, 0));

    const oldP = { ...permissions };
    const newP = {
      "https://dapp.example": {
        profileId: "account:0:acct0",
        accountIndex: 0,
        grants: { publicAccount: true, shieldedReceiveAddress: true },
        connectedAt: 1,
        updatedAt: 2,
      },
    };
    permissions = newP;

    await ev.handlePermissionsDiff(oldP, newP);

    const profileMsgs = port.messages.filter(
      (m) => m?.type === "DUSK_PROVIDER_EVENT" && m?.name === "profilesChanged"
    );
    expect(profileMsgs.at(-1)?.data).toEqual([
      { profileId: "account:0:acct0", account: "acct0", shieldedAddress: "addr0" },
    ]);
  });
});
