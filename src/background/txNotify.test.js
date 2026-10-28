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
const EXPLORER = `https://apps.testnet.dusk.network/explorer/transactions/transaction/?id=${HASH}`;

beforeEach(() => {
  vi.resetModules();
  // The transaction was sent on the custom node, before the network was kept with it.
  Object.assign(ext, { clicked: null, created: [], tabs: [], meta: { nodeUrl: "https://my-node.example" } });
  // A custom node of Testnet's, as Settings saved it with the chain ID it gave.
  vi.stubGlobal("localStorage", memoryStorage());
  localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl: "https://my-node.example", chainId: 2 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a transaction's notification, in a worker just woken", () => {
  it("names the node's network and offers its explorer, from the settings", async () => {
    const { notifyTxExecuted } = await import("./txNotify.js");
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: "https://my-node.example" });
    const [{ opts }] = ext.created;
    expect(opts.message).toContain("Network: Testnet");
    expect(opts.buttons.map((b) => b.title)).toEqual(["View in Explorer", "Open Wallet"]);
  });

  it("opens the transaction on its network's explorer when clicked", async () => {
    const { registerTxNotificationHandlers } = await import("./txNotify.js");
    registerTxNotificationHandlers();
    await ext.clicked(`dusk_tx_${HASH}_executed_1`);
    expect(ext.tabs).toEqual([EXPLORER]);
  });

  it("names the network a transaction was sent on, by the chain ID its record keeps, after a switch to another node", async () => {
    ext.meta = { nodeUrl: "https://my-node.example", chainId: 2 };
    localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl: "https://nodes.dusk.network" }));
    const { notifyTxExecuted, registerTxNotificationHandlers } = await import("./txNotify.js");
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: "https://my-node.example" });
    expect(ext.created[0].opts.message).toContain("Network: Testnet");
    expect(ext.created[0].opts.buttons.map((b) => b.title)).toEqual(["View in Explorer", "Open Wallet"]);
    registerTxNotificationHandlers();
    await ext.clicked(`dusk_tx_${HASH}_executed_1`);
    expect(ext.tabs).toEqual([EXPLORER]);
  });
});
