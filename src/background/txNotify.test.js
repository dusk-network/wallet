import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The extension's notifications, recorded; nothing is shown. `meta` is the
// transaction's record (txStore.js).
const ext = vi.hoisted(() => ({ clicked: null, created: [], tabs: [], meta: null, shown: {} }));
vi.mock("../platform/extensionApi.js", () => ({
  getExtensionApi: () => ({
    notifications: {
      onClicked: { addListener: (fn) => (ext.clicked = fn) },
      onButtonClicked: { addListener: () => {} },
    },
  }),
  notificationsCreate: vi.fn(async (id, opts) => ext.created.push({ id, opts })),
  // What shows in the phone's notices: a test says, as Firefox's getAll would.
  notificationsGetAll: vi.fn(async () => ext.shown),
  notificationsClear: vi.fn(async (id) => delete ext.shown[id]),
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
  Object.assign(ext, { clicked: null, created: [], tabs: [], open: [], meta: { nodeUrl: "https://my-node.example" }, shown: {} });
  // A custom node of Testnet's, as Settings saved it with the chain ID it gave.
  vi.stubGlobal("localStorage", memoryStorage());
  localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl: "https://my-node.example", chainId: 2 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("on a phone", () => {
  const onPhone = () => vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0" });
  const ids = () => ext.created.map(({ id }) => id.replace(/_\d+$/, ""));

  // Amélie's and Marek's: Android's "Allow Firefox to send you notifications?" over the payment, again after a no.
  it("shows no notice by itself, so Firefox for Android never asks Android for leave over a payment", async () => {
    onPhone();
    const { notifyTxExecuted, notifyTxSubmitted } = await import("./txNotify.js");
    await notifyTxSubmitted({ hash: HASH, origin: "Wallet", nodeUrl: "https://my-node.example" });
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: "https://my-node.example" });
    expect(ext.created).toEqual([]);
  });

  // Hein's: arrival notices back on phones, asked for by the person.
  it("asks when the person taps Tell me when it arrives, once, and with a yes shows the arrival", async () => {
    onPhone();
    const { askPhoneNotices, notifyTxExecuted, notifyTxSubmitted } = await import("./txNotify.js");
    await expect(askPhoneNotices()).resolves.toBe("asked");
    // The question is Firefox's, as the first notice is made.
    expect(ids()).toEqual(["dusk_notices_asked"]);
    // Asked again, or a send on its way: nothing more comes over the wallet.
    await expect(askPhoneNotices()).resolves.toBe("asked");
    await notifyTxSubmitted({ hash: HASH, origin: "Wallet" });
    expect(ids()).toEqual(["dusk_notices_asked"]);

    // Allowed: that notice shows, and the payment's arrival shows in its place.
    ext.shown = { dusk_notices_asked: {} };
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: "https://my-node.example" });
    expect(ids()).toEqual(["dusk_notices_asked", `dusk_tx_${HASH}_executed`]);
    expect(ext.shown).toEqual({});
    await notifyTxExecuted({ hash: HASH, ok: false, error: "out of gas", nodeUrl: "https://my-node.example" });
    expect(ids().at(-1)).toBe(`dusk_tx_${HASH}_failed`);
  });

  // A send learned settled by a look-up rather than the watcher: what the tap asked is settled all the same.
  it("settles what the tap asked as any send settles, showing nothing for it", async () => {
    onPhone();
    const { askPhoneNotices, settlePhoneNotices } = await import("./txNotify.js");
    const { noticesState } = await import("../shared/phoneNotices.js");
    await askPhoneNotices();
    ext.shown = {};
    await settlePhoneNotices();
    await expect(noticesState()).resolves.toBe("off");
    expect(ids()).toEqual(["dusk_notices_asked"]);
  });

  it("never asks again after a no, and shows nothing more", async () => {
    onPhone();
    const { askPhoneNotices, notifyTxExecuted } = await import("./txNotify.js");
    await askPhoneNotices();
    // Turned down: Firefox takes the notice away at once.
    ext.shown = {};
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: "https://my-node.example" });
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: "https://my-node.example" });
    await expect(askPhoneNotices()).resolves.toBe("off");
    expect(ids()).toEqual(["dusk_notices_asked"]);
    const { noticesState } = await import("../shared/phoneNotices.js");
    await expect(noticesState()).resolves.toBe("off");
  });
});

describe("a send's outcome learned twice", () => {
  it("is said once", async () => {
    const { notifyTxExecuted } = await import("./txNotify.js");
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: "https://my-node.example" });
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: "https://my-node.example" });
    expect(ext.created).toHaveLength(1);
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
