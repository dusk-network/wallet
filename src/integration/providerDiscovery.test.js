import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const inpageUrl = new URL("../inpage.js", import.meta.url);
const DUSK_WALLET_ID = "wallet.dusk.extension";

class TestCustomEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.detail = init.detail;
  }
}

class TestMessageEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.data = init.data;
    this.source = init.source;
  }
}

async function runInpageScript() {
  const source = await readFile(inpageUrl, "utf8");
  const window = new EventTarget();
  const posted = [];
  window.window = window;
  window.location = { origin: "https://dapp.example" };
  window.posted = posted;
  window.postMessage = (msg, targetOrigin) => {
    posted.push({ msg, targetOrigin });
  };
  window.MessageEvent = TestMessageEvent;

  const context = vm.createContext({
    window,
    console,
    Event,
    CustomEvent: TestCustomEvent,
    MessageEvent: TestMessageEvent,
    Map,
    Array,
    Object,
    String,
    Boolean,
    Promise,
    Date,
    Math,
    Error,
    crypto: { randomUUID: () => `req-${posted.length + 1}` },
  });

  vm.runInContext(source, context);
  return window;
}

function dispatchWalletMessage(window, data) {
  window.dispatchEvent(
    new window.MessageEvent("message", {
      source: window,
      data: {
        target: "DUSK_WALLET_EXTENSION",
        walletId: DUSK_WALLET_ID,
        ...data,
      },
    })
  );
}

function lastRpcRequest(window) {
  return window.posted
    .map((entry) => entry.msg)
    .filter((msg) => msg?.type === "DUSK_RPC_REQUEST")
    .at(-1);
}

describe("integration: inpage provider discovery", () => {
  it("announces the wallet provider through the discovery events", async () => {
    const window = await runInpageScript();
    const announcements = [];

    window.addEventListener("dusk:announceProvider", (event) => {
      announcements.push(event.detail);
    });

    window.dispatchEvent(new Event("dusk:requestProvider"));

    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toMatchObject({
      info: {
        uuid: "wallet.dusk.extension",
        name: "Dusk Wallet",
        rdns: "network.dusk.wallet",
      },
      provider: window.duskWallet,
    });
    expect(typeof announcements[0].info.icon).toBe("string");
    expect(window.dusk).toBeUndefined();
    expect(window.duskWallet?.isDusk).toBe(true);
  });

  it("deduplicates equivalent profilesChanged payloads", async () => {
    const window = await runInpageScript();
    const events = [];
    window.duskWallet.on("profilesChanged", (profiles) => events.push(profiles));

    const profile = { profileId: "account:0:acct0", account: "acct0" };
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: window,
        data: {
          target: "DUSK_WALLET_EXTENSION",
          walletId: DUSK_WALLET_ID,
          type: "DUSK_PROVIDER_EVENT",
          name: "profilesChanged",
          data: [profile],
        },
      })
    );
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: window,
        data: {
          target: "DUSK_WALLET_EXTENSION",
          walletId: DUSK_WALLET_ID,
          type: "DUSK_PROVIDER_EVENT",
          name: "profilesChanged",
          data: [{ profileId: "account:0:acct0", account: "acct0" }],
        },
      })
    );
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: window,
        data: {
          target: "DUSK_WALLET_EXTENSION",
          walletId: DUSK_WALLET_ID,
          type: "DUSK_PROVIDER_EVENT",
          name: "profilesChanged",
          data: [{ profileId: "account:0:acct0", account: "acct0", shieldedAddress: "addr0" }],
        },
      })
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual([profile]);
    expect(events[1]).toEqual([{ profileId: "account:0:acct0", account: "acct0", shieldedAddress: "addr0" }]);
  });

  it("distinguishes disconnected, connected locked, and connected unlocked profile state", async () => {
    const window = await runInpageScript();
    const provider = window.duskWallet;

    expect(provider.isAuthorized).toBe(false);
    expect(provider.profiles).toEqual([]);

    const disconnectedProfiles = provider.request({ method: "dusk_profiles" });
    dispatchWalletMessage(window, {
      type: "DUSK_RPC_RESPONSE",
      id: lastRpcRequest(window).id,
      response: { result: [] },
    });
    await expect(disconnectedProfiles).resolves.toEqual([]);
    expect(provider.isAuthorized).toBe(false);
    expect(provider.profiles).toEqual([]);

    dispatchWalletMessage(window, {
      type: "DUSK_PROVIDER_STATE",
      state: {
        isConnected: true,
        profiles: [],
        chainId: "dusk:2",
      },
    });

    const lockedProfiles = provider.request({ method: "dusk_profiles" });
    dispatchWalletMessage(window, {
      type: "DUSK_RPC_RESPONSE",
      id: lastRpcRequest(window).id,
      response: { result: [] },
    });
    await expect(lockedProfiles).resolves.toEqual([]);
    expect(provider.isAuthorized).toBe(true);
    expect(provider.profiles).toEqual([]);

    const profile = { profileId: "account:0:acct0", account: "acct0" };
    dispatchWalletMessage(window, {
      type: "DUSK_PROVIDER_STATE",
      state: {
        isConnected: true,
        profiles: [profile],
        chainId: "dusk:2",
      },
    });

    expect(provider.isAuthorized).toBe(true);
    expect(provider.profiles).toEqual([profile]);

    const events = [];
    provider.on("profilesChanged", (profiles) => events.push(profiles));
    dispatchWalletMessage(window, {
      type: "DUSK_PROVIDER_EVENT",
      name: "profilesChanged",
      data: [],
    });

    expect(events.at(-1)).toEqual([]);
    expect(provider.isAuthorized).toBe(true);
    expect(provider.profiles).toEqual([]);
  });

  it("scopes bridge messages to Dusk Wallet", async () => {
    const source = await readFile(inpageUrl, "utf8");
    const window = new EventTarget();
    const posted = [];
    window.window = window;
    window.location = { origin: "https://dapp.example" };
    window.postMessage = (msg, targetOrigin) => {
      posted.push({ msg, targetOrigin });
    };
    window.MessageEvent = TestMessageEvent;

    const context = vm.createContext({
      window,
      console,
      Event,
      CustomEvent: TestCustomEvent,
      MessageEvent: TestMessageEvent,
      Map,
      Array,
      Object,
      String,
      Boolean,
      Promise,
      Date,
      Math,
      Error,
      crypto: { randomUUID: () => "req-1" },
    });

    vm.runInContext(source, context);

    const resultPromise = window.duskWallet.request({ method: "dusk_chainId" });
    expect(posted.at(-1)).toEqual({
      msg: {
        target: "DUSK_WALLET_EXTENSION",
        walletId: DUSK_WALLET_ID,
        type: "DUSK_RPC_REQUEST",
        id: "req-1",
        request: { method: "dusk_chainId", params: undefined },
      },
      targetOrigin: "https://dapp.example",
    });

    const events = [];
    window.duskWallet.on("chainChanged", (chainId) => events.push(chainId));
    expect(posted.at(-1).msg).toMatchObject({
      target: "DUSK_WALLET_EXTENSION",
      walletId: DUSK_WALLET_ID,
      type: "DUSK_PROVIDER_SUBSCRIBE",
    });

    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: window,
        data: {
          target: "DUSK_WALLET_EXTENSION",
          walletId: "wallet.pie.extension",
          type: "DUSK_RPC_RESPONSE",
          id: "req-1",
          response: { result: "dusk:testnet" },
        },
      })
    );
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: window,
        data: {
          target: "DUSK_WALLET_EXTENSION",
          walletId: "wallet.pie.extension",
          type: "DUSK_PROVIDER_EVENT",
          name: "chainChanged",
          data: "dusk:testnet",
        },
      })
    );
    expect(events).toEqual([]);

    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: window,
        data: {
          target: "DUSK_WALLET_EXTENSION",
          walletId: DUSK_WALLET_ID,
          type: "DUSK_RPC_RESPONSE",
          id: "req-1",
          response: { result: "dusk:mainnet" },
        },
      })
    );

    await expect(resultPromise).resolves.toBe("dusk:mainnet");
  });
});
