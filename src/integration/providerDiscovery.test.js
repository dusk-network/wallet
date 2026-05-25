import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const inpageUrl = new URL("../inpage.js", import.meta.url);

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
  window.window = window;
  window.location = { origin: "https://dapp.example" };
  window.postMessage = () => {};
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
  });

  vm.runInContext(source, context);
  return window;
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
          target: "DUSK_EXTENSION",
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
          target: "DUSK_EXTENSION",
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
          target: "DUSK_EXTENSION",
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
});
