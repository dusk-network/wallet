import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The extension's notifications, recorded; nothing is shown. `meta` is the
// transaction's record (txStore.js).
const ext = vi.hoisted(() => ({ clicked: null, created: [], tabs: [], meta: null }));
vi.mock("../platform/extensionApi.js", () => ({
  getExtensionApi: () => ({
    notifications: {
      onClicked: { addListener: (fn) => (ext.clicked = fn) },
      onButtonClicked: { addListener: () => {} },
    },
  }),
  notificationsCreate: vi.fn(async (id, opts) => ext.created.push({ id, opts })),
  runtimeGetURL: (path) => `chrome-extension://wallet/${path}`,
  tabsCreate: vi.fn(async ({ url }) => ext.tabs.push(url)),
  // The wallet's tab open already, if a test opens one.
  tabsQuery: vi.fn(async () => ext.open),
  tabsUpdate: vi.fn(async (id, { url }) => ext.tabs.push(`${id}:${url}`)),
}));
vi.mock("../shared/txStore.js", () => ({ getTxMeta: vi.fn(async () => ext.meta) }));

function memoryStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => store.get(String(k)) ?? null,
    setItem: (k, v) => store.set(String(k), String(v)),
    removeItem: (k) => store.delete(String(k)),
    clear: () => store.clear(),
  };
}

const HASH = "ab".repeat(32);
const EXPLORER = `https://explorer.testnet.dusk.network/transactions/transaction/?id=${HASH}`;

beforeEach(() => {
  vi.resetModules();
  // The transaction was sent on the custom node, before the network was kept with it.
  Object.assign(ext, { clicked: null, created: [], tabs: [], open: [], meta: { nodeUrl: "https://my-node.example" } });
  // A custom node of Testnet's, as Settings saved it with the chain ID it gave.
  vi.stubGlobal("localStorage", memoryStorage());
  localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl: "https://my-node.example", chainId: 2 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("on a phone", () => {
  // Amélie's and Marek's: Android's "Allow Firefox to send you notifications?" over the payment, again after a no.
  it("shows no notice, so Firefox for Android never asks Android for leave over a payment", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0" });
    const { notifyTxExecuted, notifyTxSubmitted } = await import("./txNotify.js");
    await notifyTxSubmitted({ hash: HASH, origin: "Wallet", nodeUrl: "https://my-node.example" });
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: "https://my-node.example" });
    expect(ext.created).toEqual([]);
  });
});

describe("a notice opening the wallet", () => {
  it("shows it in the wallet's tab open already, rather than another", async () => {
    ext.open = [{ id: 4, url: "https://site.example/" }, { id: 8, url: "chrome-extension://wallet/full.html?route=send" }];
    const { registerTxNotificationHandlers } = await import("./txNotify.js");
    registerTxNotificationHandlers();
    await ext.clicked(`dusk_tx_${HASH}_submitted_1`);
    await vi.waitFor(() => expect(ext.tabs).toEqual([`8:chrome-extension://wallet/full.html?route=home&tx=${HASH}`]));
    ext.open = [];
    await ext.clicked(`dusk_tx_${HASH}_submitted_1`);
    await vi.waitFor(() => expect(ext.tabs.at(-1)).toBe(`chrome-extension://wallet/full.html?route=home&tx=${HASH}`));
  });
});

describe("a transaction's notification, in a worker just woken", () => {
  it("names the node by its address and offers its network's explorer, from the settings", async () => {
    const { notifyTxExecuted } = await import("./txNotify.js");
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: "https://my-node.example" });
    const [{ opts }] = ext.created;
    expect(opts.message).toContain("Network: Custom · my-node.example");
    expect(opts.buttons.map((b) => b.title)).toEqual(["View in Explorer", "Open Wallet"]);
  });

  it("opens the transaction on its network's explorer when clicked", async () => {
    const { registerTxNotificationHandlers } = await import("./txNotify.js");
    registerTxNotificationHandlers();
    await ext.clicked(`dusk_tx_${HASH}_executed_1`);
    expect(ext.tabs).toEqual([EXPLORER]);
  });

  it("names the node a transaction was sent on, and its network's explorer by the chain ID its record keeps, after a switch to another node", async () => {
    ext.meta = { nodeUrl: "https://my-node.example", chainId: 2 };
    localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl: "https://nodes.dusk.network" }));
    const { notifyTxExecuted, registerTxNotificationHandlers } = await import("./txNotify.js");
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: "https://my-node.example" });
    expect(ext.created[0].opts.message).toContain("Network: Custom · my-node.example");
    expect(ext.created[0].opts.buttons.map((b) => b.title)).toEqual(["View in Explorer", "Open Wallet"]);
    registerTxNotificationHandlers();
    await ext.clicked(`dusk_tx_${HASH}_executed_1`);
    expect(ext.tabs).toEqual([EXPLORER]);
  });
});
