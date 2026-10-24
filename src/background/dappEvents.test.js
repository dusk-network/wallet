import { describe, expect, it, vi, beforeEach } from "vitest";

let permissions = {};
let settings = { nodeUrl: "https://testnet.nodes.dusk.network" };
let engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"] };
// The .dusk name checks kept in verifiedNames.js.
let verifiedNames = {};
let storageListener = null;

vi.mock("../shared/settings.js", () => ({
  getSettings: vi.fn(async () => settings),
}));

vi.mock("../shared/permissions.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getPermissions: vi.fn(async () => permissions),
}));

vi.mock("./engineHost.js", () => ({
  engineCall: vi.fn(async () => true),
  getEngineStatus: vi.fn(async () => engineStatus),
}));

vi.mock("../shared/verifiedNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  readVerifiedNames: vi.fn(async () => verifiedNames),
}));

vi.mock("../platform/extensionApi.js", () => ({
  getExtensionApi: () => ({
    storage: {
      onChanged: {
        addListener: (fn) => {
          storageListener = fn;
        },
      },
    },
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

class FakePortWithoutSenderOrigin extends FakePort {
  constructor(tabId = 1) {
    super("https://unused.example", tabId);
    this.sender = { tab: { id: tabId } };
  }
}

describe("dappEvents", () => {
  beforeEach(() => {
    permissions = {};
    settings = { nodeUrl: "https://testnet.nodes.dusk.network" };
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"] };
    verifiedNames = {};
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
      isConnected: false,
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

  it("disconnects a stale permission without exposing a replacement wallet", async () => {
    permissions = {
      "https://dapp.example": {
        profileId: "account:0:wallet-a",
        accountIndex: 0,
        grants: { publicAccount: true, shieldedReceiveAddress: true },
        updatedAt: 1,
      },
    };
    engineStatus = {
      isUnlocked: true,
      accounts: ["wallet-b"],
      addresses: ["wallet-b-shielded"],
    };

    const ev = await import("./dappEvents.js");
    const port = new FakePort("https://dapp.example");
    ev.registerDappPort(port);
    await new Promise((r) => setTimeout(r, 0));

    const state = port.messages.find((m) => m?.type === "DUSK_PROVIDER_STATE")?.state;
    expect(state).toMatchObject({ isConnected: false, profiles: [] });
    expect(JSON.stringify(state)).not.toContain("wallet-b");
  });

  it.each([
    ["profileId", { accountIndex: 0, updatedAt: 1 }],
    ["updatedAt", { profileId: "account:0:acct0", accountIndex: 0 }],
  ])("disconnects a permission missing %s", async (_field, permission) => {
    permissions = { "https://dapp.example": permission };
    const ev = await import("./dappEvents.js");
    const port = new FakePort("https://dapp.example");
    ev.registerDappPort(port);
    await new Promise((r) => setTimeout(r, 0));

    expect(port.messages.find((m) => m?.type === "DUSK_PROVIDER_STATE")?.state).toMatchObject({
      isConnected: false,
      profiles: [],
    });
  });

  it("refreshes provider state when a legacy permission is migrated", async () => {
    const oldPermissions = {
      "https://dapp.example": {
        profileId: "account:0:acct0",
        accountIndex: 0,
        grants: { publicAccount: true, shieldedReceiveAddress: false },
      },
    };
    permissions = {
      "https://dapp.example": {
        ...oldPermissions["https://dapp.example"],
        updatedAt: 1,
      },
    };

    const ev = await import("./dappEvents.js");
    const port = new FakePort("https://dapp.example");
    ev.registerDappPort(port);
    await new Promise((r) => setTimeout(r, 0));
    port.messages = [];

    await ev.handlePermissionsDiff(oldPermissions, permissions);

    expect(port.messages).toContainEqual({
      type: "DUSK_PROVIDER_EVENT",
      name: "connect",
      data: { chainId: "dusk:2" },
    });
    expect(port.messages).toContainEqual({
      type: "DUSK_PROVIDER_EVENT",
      name: "profilesChanged",
      data: [{ profileId: "account:0:acct0", account: "acct0" }],
    });
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

  it("broadcasts empty profiles when lock or auto-lock clears dApp-visible state", async () => {
    permissions = {
      "https://dapp.example": {
        profileId: "account:0:acct0",
        accountIndex: 0,
        grants: { publicAccount: true, shieldedReceiveAddress: true },
        connectedAt: 1,
        updatedAt: 1,
      },
    };

    const ev = await import("./dappEvents.js");

    const port = new FakePort("https://dapp.example");
    ev.registerDappPort(port);
    await new Promise((r) => setTimeout(r, 0));

    const stateMsg = port.messages.find((m) => m?.type === "DUSK_PROVIDER_STATE");
    expect(stateMsg?.state.profiles).toEqual([
      { profileId: "account:0:acct0", account: "acct0", shieldedAddress: "addr0" },
    ]);

    engineStatus = {
      isUnlocked: false,
      accounts: ["acct0", "acct1"],
      addresses: ["addr0", "addr1"],
    };

    await ev.broadcastProfilesChangedAll();

    const profileMsgs = port.messages.filter(
      (m) => m?.type === "DUSK_PROVIDER_EVENT" && m?.name === "profilesChanged"
    );
    expect(profileMsgs.at(-1)?.data).toEqual([]);

    const lockedPort = new FakePort("https://dapp.example", 2);
    ev.registerDappPort(lockedPort);
    await new Promise((r) => setTimeout(r, 0));
    const lockedStateMsg = lockedPort.messages.find((m) => m?.type === "DUSK_PROVIDER_STATE");
    expect(lockedStateMsg?.state).toMatchObject({
      isConnected: true,
      profiles: [],
    });
  });

  it("does not bind non-local HTTP sender origins even when permission exists", async () => {
    permissions = {
      "http://dapp.example": {
        profileId: "account:0:acct0",
        accountIndex: 0,
        grants: { publicAccount: true, shieldedReceiveAddress: false },
        connectedAt: 1,
        updatedAt: 1,
      },
    };

    const ev = await import("./dappEvents.js");

    const port = new FakePort("http://dapp.example");
    ev.registerDappPort(port);
    await new Promise((r) => setTimeout(r, 0));

    expect(port.messages).toEqual([]);
  });

  it("binds local HTTP sender origins for development", async () => {
    permissions = {
      "http://localhost:5173": {
        profileId: "account:0:acct0",
        accountIndex: 0,
        grants: { publicAccount: true, shieldedReceiveAddress: false },
        connectedAt: 1,
        updatedAt: 1,
      },
    };

    const ev = await import("./dappEvents.js");

    const port = new FakePort("http://localhost:5173");
    ev.registerDappPort(port);
    await new Promise((r) => setTimeout(r, 0));

    const stateMsg = port.messages.find((m) => m?.type === "DUSK_PROVIDER_STATE");
    expect(stateMsg?.state).toMatchObject({
      isConnected: true,
      profiles: [{ profileId: "account:0:acct0", account: "acct0" }],
    });
  });

  it("does not let a HELLO message re-key a sender-derived origin", async () => {
    permissions = {
      "https://dapp.example": {
        profileId: "account:0:acct0",
        accountIndex: 0,
        grants: { publicAccount: true, shieldedReceiveAddress: false },
        connectedAt: 1,
        updatedAt: 1,
      },
      "https://evil.example": {
        profileId: "account:1:acct1",
        accountIndex: 1,
        grants: { publicAccount: true, shieldedReceiveAddress: true },
        connectedAt: 1,
        updatedAt: 1,
      },
    };

    const ev = await import("./dappEvents.js");

    const port = new FakePort("https://dapp.example");
    ev.registerDappPort(port);
    await new Promise((r) => setTimeout(r, 0));

    port.onMessage.emit({ type: "DUSK_DAPP_HELLO", origin: "https://evil.example" });
    await new Promise((r) => setTimeout(r, 0));

    await ev.broadcastProfilesChangedForOrigin("https://evil.example");
    await ev.broadcastProfilesChangedForOrigin("https://dapp.example");

    const profileMsgs = port.messages.filter(
      (m) => m?.type === "DUSK_PROVIDER_EVENT" && m?.name === "profilesChanged"
    );
    expect(profileMsgs).toHaveLength(1);
    expect(profileMsgs[0].data).toEqual([{ profileId: "account:0:acct0", account: "acct0" }]);
  });

  it("uses HELLO only as a fallback when sender origin is unavailable", async () => {
    permissions = {
      "https://dapp.example": {
        profileId: "account:1:acct1",
        accountIndex: 1,
        grants: { publicAccount: true, shieldedReceiveAddress: false },
        connectedAt: 1,
        updatedAt: 1,
      },
    };

    const ev = await import("./dappEvents.js");

    const port = new FakePortWithoutSenderOrigin();
    ev.registerDappPort(port);
    await new Promise((r) => setTimeout(r, 0));
    expect(port.messages).toEqual([]);

    port.onMessage.emit({ type: "DUSK_DAPP_HELLO", origin: "https://dapp.example" });
    await new Promise((r) => setTimeout(r, 0));

    const stateMsg = port.messages.find((m) => m?.type === "DUSK_PROVIDER_STATE");
    expect(stateMsg?.state.profiles).toEqual([{ profileId: "account:1:acct1", account: "acct1" }]);
  });

  it("ignores non-local HTTP HELLO fallback origins", async () => {
    permissions = {
      "http://dapp.example": {
        profileId: "account:0:acct0",
        accountIndex: 0,
        grants: { publicAccount: true, shieldedReceiveAddress: false },
        connectedAt: 1,
        updatedAt: 1,
      },
    };

    const ev = await import("./dappEvents.js");

    const port = new FakePortWithoutSenderOrigin();
    ev.registerDappPort(port);
    await new Promise((r) => setTimeout(r, 0));

    port.onMessage.emit({ type: "DUSK_DAPP_HELLO", origin: "http://dapp.example" });
    await new Promise((r) => setTimeout(r, 0));

    expect(port.messages).toEqual([]);
  });

  describe("profile names", () => {
    const connected = (accountIndex = 0) => ({
      profileId: `account:${accountIndex}:acct${accountIndex}`,
      accountIndex,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
      connectedAt: 1,
      updatedAt: 1,
    });
    const check = (name, at = Date.now()) => ({ name, at });
    const profileEvents = (port) =>
      port.messages.filter((m) => m?.type === "DUSK_PROVIDER_EVENT" && m?.name === "profilesChanged");

    async function openPort(ev, origin = "https://dapp.example", tabId = 1) {
      const port = new FakePort(origin, tabId);
      ev.registerDappPort(port);
      await new Promise((r) => setTimeout(r, 0));
      return port;
    }

    it("gives a connected site's profile its .dusk name in its state and in profilesChanged", async () => {
      permissions = { "https://dapp.example": connected(0) };
      verifiedNames = { testnet: { acct0: check("alice.dusk"), acct1: check("bob.dusk") } };

      const ev = await import("./dappEvents.js");
      const port = await openPort(ev);
      expect(port.messages.find((m) => m?.type === "DUSK_PROVIDER_STATE")?.state.profiles).toEqual([
        { profileId: "account:0:acct0", account: "acct0", name: "alice.dusk" },
      ]);

      await ev.broadcastProfilesChangedAll();
      expect(profileEvents(port).at(-1)?.data).toEqual([
        { profileId: "account:0:acct0", account: "acct0", name: "alice.dusk" },
      ]);

      // A name checked over ten minutes ago, or on another network, isn't sent.
      verifiedNames = {
        testnet: { acct0: check("alice.dusk", Date.now() - 10 * 60_000) },
        mainnet: { acct0: check("main.dusk") },
      };
      await ev.broadcastProfilesChangedForOrigin("https://dapp.example");
      expect(profileEvents(port).at(-1)?.data).toEqual([{ profileId: "account:0:acct0", account: "acct0" }]);
    });

    it("has a connected profile's name checked again, without waiting, when it is over a minute old", async () => {
      permissions = { "https://dapp.example": connected(1) };
      verifiedNames = { testnet: { acct0: check(null, Date.now() - 2 * 60_000) } };
      const { engineCall } = await import("./engineHost.js");
      engineCall.mockClear();
      // The check never answers; the state doesn't wait for it.
      engineCall.mockImplementation(() => new Promise(() => {}));

      const ev = await import("./dappEvents.js");
      const port = await openPort(ev);
      engineCall.mockImplementation(async () => true);
      expect(port.messages.find((m) => m?.type === "DUSK_PROVIDER_STATE")?.state.profiles).toEqual([
        { profileId: "account:1:acct1", account: "acct1" },
      ]);
      expect(engineCall).toHaveBeenCalledWith("engine_checkNames", {
        nodeUrl: "https://testnet.nodes.dusk.network",
        accounts: ["acct1"],
      });
    });

    it("sends profilesChanged when a later check adds, changes or removes a connected profile's name", async () => {
      permissions = { "https://dapp.example": connected(0), "https://other.example": connected(1) };
      const ev = await import("./dappEvents.js");
      const port = await openPort(ev);
      const other = await openPort(ev, "https://other.example", 2);
      const stranger = await openPort(ev, "https://stranger.example", 3);
      for (const p of [port, other, stranger]) p.messages = [];

      const steps = [
        [{}, { testnet: { acct0: check("alice.dusk") } }, "alice.dusk"],
        [{ testnet: { acct0: check("alice.dusk") } }, { testnet: { acct0: check("carol.dusk") } }, "carol.dusk"],
        [{ testnet: { acct0: check("carol.dusk") } }, { testnet: { acct0: check(null) } }, undefined],
      ];
      for (const [before, after, name] of steps) {
        await ev.handleVerifiedNamesDiff(before, after);
        expect(profileEvents(port).at(-1)?.data).toEqual([
          { profileId: "account:0:acct0", account: "acct0", ...(name ? { name } : {}) },
        ]);
      }
      expect(profileEvents(port)).toHaveLength(3);
      // Only the site whose profile was checked hears of it, and an
      // unconnected site hears nothing.
      expect(profileEvents(other)).toEqual([]);
      expect(stranger.messages).toEqual([]);

      // A check on another network, or while locked, sends nothing.
      await ev.handleVerifiedNamesDiff({}, { mainnet: { acct0: check("main.dusk") } });
      engineStatus = { ...engineStatus, isUnlocked: false };
      await ev.handleVerifiedNamesDiff({}, { testnet: { acct0: check("alice.dusk") } });
      expect(profileEvents(port)).toHaveLength(3);
    });

    it("passes a name check kept in storage on to the site", async () => {
      permissions = { "https://dapp.example": connected(0) };
      const ev = await import("./dappEvents.js");
      ev.registerStorageChangeForwarder();
      const port = await openPort(ev);
      port.messages = [];

      storageListener(
        { dusk_verified_names_v1: { oldValue: undefined, newValue: { testnet: { acct0: check("alice.dusk") } } } },
        "local"
      );
      await vi.waitFor(() =>
        expect(profileEvents(port).at(-1)?.data).toEqual([
          { profileId: "account:0:acct0", account: "acct0", name: "alice.dusk" },
        ])
      );
    });

    // Holds the next permissions read until `release` is called.
    async function holdPermissions() {
      const { getPermissions } = await import("../shared/permissions.js");
      const held = {};
      getPermissions.mockImplementationOnce(
        () => new Promise((resolve) => (held.release = () => resolve(permissions)))
      );
      return held;
    }

    // Holds the next call of the mocked `read` until `release` is called,
    // which answers `value`: what it read before the wallet changed.
    function holdNext(read, value) {
      const held = {};
      read.mockImplementationOnce(() => new Promise((resolve) => (held.release = () => resolve(value))));
      return held;
    }

    const moveToMainnet = async (ev) => {
      settings = { nodeUrl: "https://nodes.dusk.network" };
      await ev.handleSettingsDiff({ nodeUrl: "https://testnet.nodes.dusk.network" }, settings);
    };
    // As index.js locks: the engine, then sites hear of it.
    const lock = async (ev) => {
      engineStatus = { ...engineStatus, isUnlocked: false };
      await ev.broadcastProfilesChangedAll();
    };
    // The site's permission becomes `next`, as storage reports it.
    const regrant = (next) => async (ev) => {
      const before = permissions;
      permissions = next;
      await ev.handlePermissionsDiff(before, next);
    };

    it("drops a name update begun on the network the wallet moved away from", async () => {
      permissions = { "https://dapp.example": connected(0) };
      verifiedNames = { testnet: { acct0: check("alice.dusk") }, mainnet: { acct0: check("main.dusk") } };
      const ev = await import("./dappEvents.js");
      const port = await openPort(ev);
      port.messages = [];

      // A Testnet check comes in, and the wallet moves to Mainnet while its
      // update waits for the permissions.
      const held = await holdPermissions();
      const update = ev.handleVerifiedNamesDiff({}, { testnet: { acct0: check("carol.dusk") } });
      await vi.waitFor(() => expect(held.release).toBeTypeOf("function"));
      await moveToMainnet(ev);
      held.release();
      await update;

      expect(profileEvents(port).map((event) => event.data)).toEqual([
        [{ profileId: "account:0:acct0", account: "acct0", name: "main.dusk" }],
      ]);
    });

    it("builds a site's first state again when the wallet moves network meanwhile", async () => {
      permissions = { "https://dapp.example": connected(0) };
      verifiedNames = { testnet: { acct0: check("alice.dusk") }, mainnet: { acct0: check("main.dusk") } };
      const ev = await import("./dappEvents.js");

      const held = await holdPermissions();
      const port = new FakePort("https://dapp.example");
      ev.registerDappPort(port);
      await vi.waitFor(() => expect(held.release).toBeTypeOf("function"));
      await moveToMainnet(ev);
      held.release();

      await vi.waitFor(() => expect(port.messages.some((m) => m?.type === "DUSK_PROVIDER_STATE")).toBe(true));
      const states = port.messages.filter((m) => m?.type === "DUSK_PROVIDER_STATE");
      expect(states).toHaveLength(1);
      expect(states[0].state).toMatchObject({
        chainId: "dusk:1",
        profiles: [{ profileId: "account:0:acct0", account: "acct0", name: "main.dusk" }],
      });
    });

    it.each([
      ["locks", lock, []],
      ["revokes the site's grant", regrant({}), []],
      [
        "switches the site's profile",
        regrant({ "https://dapp.example": connected(1) }),
        [{ profileId: "account:1:acct1", account: "acct1" }],
      ],
    ])("sends sites only profiles read after the wallet %s", async (_, change, profiles) => {
      permissions = { "https://dapp.example": connected(0) };
      verifiedNames = { testnet: { acct0: check("alice.dusk") } };
      const ev = await import("./dappEvents.js");
      const { getEngineStatus } = await import("./engineHost.js");
      const port = await openPort(ev);
      port.messages = [];

      // A profile update, a name check's update and a new page's first state
      // have read the wallet before the change, and go on after it.
      const held = [0, 1, 2].map(() => holdNext(getEngineStatus, engineStatus));
      const updates = [
        ev.broadcastProfilesChangedAll(),
        ev.handleVerifiedNamesDiff({}, { testnet: { acct0: check("carol.dusk") } }),
      ];
      const late = new FakePort("https://dapp.example", 2);
      ev.registerDappPort(late);
      await vi.waitFor(() => expect(held.every((h) => h.release)).toBe(true));
      await change(ev);
      held.forEach((h) => h.release());
      await Promise.all(updates);

      // The updates are dropped and the first state is built again, so each
      // page keeps the profiles the change sent it.
      expect(profileEvents(port).map((event) => event.data)).toEqual([profiles]);
      const states = () =>
        late.messages.filter((m) => m?.type === "DUSK_PROVIDER_STATE").map((m) => m.state.profiles);
      await vi.waitFor(() => expect(states()).toEqual([profiles]));
    });

    it("gives sites the new network's names when the wallet's node changes", async () => {
      permissions = { "https://dapp.example": connected(0) };
      verifiedNames = { testnet: { acct0: check("alice.dusk") }, mainnet: { acct0: check("main.dusk") } };
      const ev = await import("./dappEvents.js");
      const port = await openPort(ev);
      port.messages = [];

      settings = { nodeUrl: "https://nodes.dusk.network" };
      await ev.handleSettingsDiff({ nodeUrl: "https://testnet.nodes.dusk.network" }, settings);
      expect(profileEvents(port).at(-1)?.data).toEqual([
        { profileId: "account:0:acct0", account: "acct0", name: "main.dusk" },
      ]);

      // Between networks without names, profiles stay as they are.
      port.messages = [];
      settings = { nodeUrl: "http://127.0.0.1:8080" };
      await ev.handleSettingsDiff({ nodeUrl: "https://devnet.nodes.dusk.network" }, settings);
      expect(profileEvents(port)).toEqual([]);
    });
  });
});
