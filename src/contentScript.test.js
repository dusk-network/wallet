import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const contentScriptUrl = new URL("./contentScript.js", import.meta.url);

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
  messages = [];
  onMessage = new FakeEvent();
  onDisconnect = new FakeEvent();

  postMessage(msg) {
    this.messages.push(msg);
  }
}

class FakeWindow {
  location = { origin: "https://dapp.example" };
  posted = [];
  #listeners = new Map();

  addEventListener(type, cb) {
    const arr = this.#listeners.get(type) ?? [];
    arr.push(cb);
    this.#listeners.set(type, arr);
  }

  postMessage(msg, targetOrigin) {
    this.posted.push({ msg, targetOrigin });
  }

  dispatchMessage(data, source = this) {
    for (const cb of this.#listeners.get("message") ?? []) {
      cb({ source, data });
    }
  }
}

async function runContentScript() {
  const source = await readFile(contentScriptUrl, "utf8");
  const window = new FakeWindow();
  const sentMessages = [];
  const ports = [];
  const sendMessage = vi.fn((message, cb) => {
    sentMessages.push(message);
    cb({ id: message.id, result: "ok" });
  });
  const connect = vi.fn(() => {
    const port = new FakePort();
    ports.push(port);
    return port;
  });

  const chrome = {
    runtime: {
      sendMessage,
      connect,
      getURL: (path) => `chrome-extension://wallet/${String(path ?? "")}`,
    },
  };

  const context = vm.createContext({
    window,
    chrome,
    console,
    Promise,
    Error,
    String,
    Boolean,
    globalThis: { chrome },
  });

  vm.runInContext(source, context);
  return { window, sentMessages, sendMessage, connect, ports };
}

describe("contentScript message bridge", () => {
  it("ignores messages from the wrong source or target", async () => {
    const { window, sendMessage, connect } = await runContentScript();

    window.dispatchMessage({
      target: "DUSK_EXTENSION",
      type: "DUSK_RPC_REQUEST",
      id: "req-1",
      request: { method: "dusk_chainId" },
    }, {});
    window.dispatchMessage({
      target: "OTHER_TARGET",
      type: "DUSK_RPC_REQUEST",
      id: "req-2",
      request: { method: "dusk_chainId" },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid request ids before contacting the background", async () => {
    const { window, sendMessage, connect } = await runContentScript();

    for (const id of [undefined, null, "", 42, "x".repeat(129)]) {
      window.dispatchMessage({
        target: "DUSK_EXTENSION",
        type: "DUSK_RPC_REQUEST",
        id,
        request: { method: "dusk_chainId" },
      });
    }

    expect(sendMessage).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("derives origin from the content-script window instead of page payload fields", async () => {
    const { window, sentMessages } = await runContentScript();

    window.dispatchMessage({
      target: "DUSK_EXTENSION",
      type: "DUSK_RPC_REQUEST",
      id: "req-1",
      origin: "https://evil.example",
      request: {
        method: "dusk_profiles",
        params: { origin: "https://evil.example" },
      },
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      type: "DUSK_RPC_REQUEST",
      id: "req-1",
      origin: "https://dapp.example",
      request: {
        method: "dusk_profiles",
        params: { origin: "https://evil.example" },
      },
    });
  });

  it("does not forward page-forged provider events to the background", async () => {
    const { window, sendMessage, connect } = await runContentScript();

    window.dispatchMessage({
      target: "DUSK_EXTENSION",
      type: "DUSK_PROVIDER_EVENT",
      name: "connect",
      data: { chainId: "dusk:2" },
    });
    window.dispatchMessage({
      target: "DUSK_EXTENSION",
      type: "DUSK_PROVIDER_STATE",
      state: {
        isConnected: true,
        profiles: [{ account: "acct0", shieldedAddress: "addr0" }],
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("forwards provider events from the extension port to inpage only as extension-target messages", async () => {
    const { window, ports } = await runContentScript();

    window.dispatchMessage({
      target: "DUSK_EXTENSION",
      type: "DUSK_PROVIDER_SUBSCRIBE",
    });
    ports[0].onMessage.emit({
      type: "DUSK_PROVIDER_EVENT",
      name: "profilesChanged",
      data: [{ account: "acct0" }],
    });

    expect(window.posted.at(-1)).toEqual({
      msg: {
        target: "DUSK_EXTENSION",
        type: "DUSK_PROVIDER_EVENT",
        name: "profilesChanged",
        data: [{ account: "acct0" }],
      },
      targetOrigin: "https://dapp.example",
    });
  });
});
