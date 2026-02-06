import { describe, expect, it, vi, beforeEach } from "vitest";

let permissions = {};
let settings = { nodeUrl: "https://testnet.nodes.dusk.network" };
let engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"] };

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
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"] };
    vi.resetModules();
  });

  it("does not leak all accounts when accountIndex is out of bounds", async () => {
    permissions = { "https://dapp.example": { accountIndex: 999, connectedAt: 1 } };

    const ev = await import("./dappEvents.js");

    const port = new FakePort("https://dapp.example");
    ev.registerDappPort(port);
    await new Promise((r) => setTimeout(r, 0));

    // initPortForOrigin() posts DUSK_PROVIDER_STATE immediately.
    const stateMsg = port.messages.find((m) => m?.type === "DUSK_PROVIDER_STATE");
    expect(stateMsg).toBeTruthy();
    expect(stateMsg.state).toMatchObject({
      isConnected: true,
      accounts: [],
      chainId: "dusk:2",
    });

    // accountsChanged should also emit [] (not the full list).
    await ev.broadcastAccountsChangedAll();
    const acctMsgs = port.messages.filter(
      (m) => m?.type === "DUSK_PROVIDER_EVENT" && m?.name === "accountsChanged"
    );
    expect(acctMsgs.at(-1)?.data).toEqual([]);
  });

  it("emits accountsChanged when an origin's selected account changes", async () => {
    // Start connected to account 0
    permissions = { "https://dapp.example": { accountIndex: 0, connectedAt: 1 } };

    const ev = await import("./dappEvents.js");

    const port = new FakePort("https://dapp.example");
    ev.registerDappPort(port);
    await new Promise((r) => setTimeout(r, 0));

    // Change permission selection to account 1
    const oldP = { "https://dapp.example": { accountIndex: 0 } };
    const newP = { "https://dapp.example": { accountIndex: 1 } };
    permissions = { "https://dapp.example": { accountIndex: 1, connectedAt: 1 } };

    await ev.handlePermissionsDiff(oldP, newP);

    const acctMsgs = port.messages.filter(
      (m) => m?.type === "DUSK_PROVIDER_EVENT" && m?.name === "accountsChanged"
    );
    expect(acctMsgs.at(-1)?.data).toEqual(["acct1"]);
  });
});
