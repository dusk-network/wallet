import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const contentScriptUrl = new URL("./contentScript.js", import.meta.url);
const DUSK_WALLET_ID = "wallet.dusk.extension";

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

  // A press on the page: the person's, as the browser marks it, or the page's own.
  press(type = "pointerdown", isTrusted = true) {
    for (const cb of this.#listeners.get(type) ?? []) cb({ type, isTrusted });
  }
}

async function runContentScript({ navigator, answer } = {}) {
  const source = await readFile(contentScriptUrl, "utf8");
  const window = new FakeWindow();
  const sentMessages = [];
  const ports = [];
  // The background's answer to each message: "ok", unless a test says otherwise.
  const sendMessage = vi.fn((message, cb) => {
    sentMessages.push(message);
    cb(answer ? answer(message, sentMessages.length) : { id: message.id, result: "ok" });
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
    setTimeout,
    globalThis: { chrome, navigator },
  });

  vm.runInContext(source, context);
  return { window, sentMessages, sendMessage, connect, ports };
}

describe("contentScript message bridge", () => {
  it("ignores messages from the wrong source or target", async () => {
    const { window, sendMessage, connect } = await runContentScript();

    window.dispatchMessage({
      target: "DUSK_WALLET_EXTENSION",
      walletId: DUSK_WALLET_ID,
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
        target: "DUSK_WALLET_EXTENSION",
        walletId: DUSK_WALLET_ID,
        type: "DUSK_RPC_REQUEST",
        id,
        request: { method: "dusk_chainId" },
      });
    }

    expect(sendMessage).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("says whether the page had a press as it handed a request over, as the browser says it, and for nothing else", async () => {
    for (const isActive of [true, false]) {
      const { window, sentMessages } = await runContentScript({ navigator: { userActivation: { isActive } } });
      const ask = (id, method) =>
        window.dispatchMessage({ target: "DUSK_WALLET_EXTENSION", walletId: DUSK_WALLET_ID, type: "DUSK_RPC_REQUEST", id, pressed: !isActive, request: { method, params: { pressed: !isActive } } });
      window.press();
      ask("req-1", "dusk_openPaymentLink");
      ask("req-2", "dusk_profiles");
      expect(sentMessages.map((m) => [m.id, m.pressed])).toEqual([["req-1", isActive], ["req-2", undefined]]);
    }
  });

  it("takes one press of the person's for one hand-over, however often the page asks in it", async () => {
    // Marek's: one click called dusk_openPaymentLink four times, and four Send tabs opened.
    for (const navigator of [{ userActivation: { isActive: true } }, undefined]) {
      const { window, sentMessages } = await runContentScript({ navigator });
      let n = 0;
      const ask = () => window.dispatchMessage({ target: "DUSK_WALLET_EXTENSION", walletId: DUSK_WALLET_ID, type: "DUSK_RPC_REQUEST", id: `req-${++n}`, request: { method: "dusk_openPaymentLink" } });
      ask();
      window.press();
      for (let i = 0; i < 4; i += 1) ask();
      // The page's own events are no press.
      window.press("pointerdown", false);
      window.press("keydown", false);
      ask();
      window.press("keydown");
      ask();
      expect(sentMessages.map((m) => m.pressed), JSON.stringify(navigator)).toEqual([false, true, false, false, false, false, true]);
    }
  });

  it("derives origin from the content-script window instead of page payload fields", async () => {
    const { window, sentMessages } = await runContentScript();

    window.dispatchMessage({
      target: "DUSK_WALLET_EXTENSION",
      walletId: DUSK_WALLET_ID,
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
      target: "DUSK_WALLET_EXTENSION",
      walletId: DUSK_WALLET_ID,
      type: "DUSK_PROVIDER_EVENT",
      name: "connect",
      data: { chainId: "dusk:2" },
    });
    window.dispatchMessage({
      target: "DUSK_WALLET_EXTENSION",
      walletId: DUSK_WALLET_ID,
      type: "DUSK_PROVIDER_STATE",
      state: {
        isConnected: true,
        profiles: [{ account: "acct0", shieldedAddress: "addr0" }],
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("forwards provider events from the extension port to inpage only as wallet-scoped messages", async () => {
    const { window, ports } = await runContentScript();

    window.dispatchMessage({
      target: "DUSK_WALLET_EXTENSION",
      walletId: DUSK_WALLET_ID,
      type: "DUSK_PROVIDER_SUBSCRIBE",
    });
    ports[0].onMessage.emit({
      type: "DUSK_PROVIDER_EVENT",
      name: "profilesChanged",
      data: [{ account: "acct0" }],
    });

    expect(window.posted.at(-1)).toEqual({
      msg: {
        target: "DUSK_WALLET_EXTENSION",
        walletId: DUSK_WALLET_ID,
        type: "DUSK_PROVIDER_EVENT",
        name: "profilesChanged",
        data: [{ account: "acct0" }],
      },
      targetOrigin: "https://dapp.example",
    });
  });

  it("ignores bridge messages for other wallets", async () => {
    const { window, sendMessage, connect } = await runContentScript();

    window.dispatchMessage({
      target: "DUSK_EXTENSION",
      type: "DUSK_RPC_REQUEST",
      id: "req-0",
      request: { method: "dusk_requestProfiles" },
    });
    window.dispatchMessage({
      target: "DUSK_WALLET_EXTENSION",
      walletId: "wallet.pie.extension",
      type: "DUSK_PROVIDER_SUBSCRIBE",
    });
    window.dispatchMessage({
      target: "DUSK_WALLET_EXTENSION",
      walletId: "wallet.pie.extension",
      type: "DUSK_RPC_REQUEST",
      id: "req-1",
      request: { method: "dusk_requestProfiles" },
    });
    window.dispatchMessage({
      target: "DUSK_WALLET_EXTENSION",
      type: "DUSK_RPC_REQUEST",
      id: "req-2",
      request: { method: "dusk_requestProfiles" },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("asks again when the wallet's background stopped before it answered, as Firefox for Android stops it, and passes on that answer", async () => {
    // Sofia's: the first ask gets nothing back; asked again, the approval still open answers.
    const { window, sentMessages } = await runContentScript({
      answer: (message, n) => (n === 1 ? undefined : { id: message.id, result: { hash: "ab".repeat(32) } }),
    });
    window.dispatchMessage({ target: "DUSK_WALLET_EXTENSION", walletId: DUSK_WALLET_ID, type: "DUSK_RPC_REQUEST", id: "req-7", request: { method: "dusk_sendTransaction" } });
    await vi.waitFor(() => expect(window.posted.at(-1)?.msg?.type).toBe("DUSK_RPC_RESPONSE"));
    expect(sentMessages.map((m) => [m.id, m.resume])).toEqual([["req-7", undefined], ["req-7", true]]);
    expect(window.posted.at(-1).msg.response).toEqual({ id: "req-7", result: { hash: "ab".repeat(32) } });
  });

  it("tells the site plainly when nothing can take its request up, never an answer with nothing in it", async () => {
    const { window } = await runContentScript({
      answer: (message, n) => (n === 1 ? undefined : { error: { code: 4900, message: "The wallet stopped before it answered." } }),
    });
    window.dispatchMessage({ target: "DUSK_WALLET_EXTENSION", walletId: DUSK_WALLET_ID, type: "DUSK_RPC_REQUEST", id: "req-8", request: { method: "dusk_sendTransaction" } });
    await vi.waitFor(() => expect(window.posted.at(-1)?.msg?.type).toBe("DUSK_RPC_RESPONSE"));
    expect(window.posted.at(-1).msg.response).toEqual({ error: { code: 4900, message: "The wallet stopped before it answered." } });
  });

  it("scopes RPC responses to Dusk Wallet", async () => {
    const { window } = await runContentScript();

    window.dispatchMessage({
      target: "DUSK_WALLET_EXTENSION",
      walletId: DUSK_WALLET_ID,
      type: "DUSK_RPC_REQUEST",
      id: "req-1",
      request: { method: "dusk_chainId" },
    });

    await vi.waitFor(() => expect(window.posted.at(-1)?.msg?.type).toBe("DUSK_RPC_RESPONSE"));

    expect(window.posted.at(-1)).toEqual({
      msg: {
        target: "DUSK_WALLET_EXTENSION",
        walletId: DUSK_WALLET_ID,
        type: "DUSK_RPC_RESPONSE",
        id: "req-1",
        response: { id: "req-1", result: "ok" },
      },
      targetOrigin: "https://dapp.example",
    });
  });
});
