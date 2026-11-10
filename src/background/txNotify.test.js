import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The extension's notifications, recorded; nothing is shown. `meta` is the
// transaction's record (txStore.js). On a phone, `tray` is what Firefox shows
// of them, and `heard` what it tells the wallet a notice did (onShown, onClosed).
const ext = vi.hoisted(() => ({ clicked: null, created: [], tabs: [], meta: null, tray: new Set(), heard: {}, onClear: null }));
vi.mock("../platform/extensionApi.js", () => ({
  getExtensionApi: () => ({
    notifications: {
      onClicked: { addListener: (fn) => (ext.clicked = fn) },
      onButtonClicked: { addListener: () => {} },
      onShown: { addListener: (fn) => (ext.heard.shown = fn) },
      onClosed: { addListener: (fn) => (ext.heard.closed = fn) },
    },
  }),
  // Firefox, which a test builds for, has no buttons on a notice, and refuses one that asks for them.
  notificationsCreate: vi.fn(async (id, opts) => {
    if (globalThis.__DUSK_TARGET__ === "firefox" && opts.buttons) {
      throw new TypeError('Type error for parameter options (Property "buttons" is unsupported by Firefox) for notifications.create.');
    }
    ext.created.push({ id, opts });
  }),
  // Cleared, a notice goes, and Firefox says it closed, by the person as it always says.
  notificationsClear: vi.fn(async (id) => {
    ext.tray.delete(id);
    ext.heard.closed?.(id, true);
    ext.onClear?.(id);
  }),
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
  Object.assign(ext, { clicked: null, created: [], tabs: [], open: [], meta: { nodeUrl: "https://my-node.example" }, tray: new Set(), heard: {}, onClear: null });
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
  const ASKED = "dusk_notices_asked";
  const NODE = "https://my-node.example";
  // What Firefox does with the notice that asked, as Android answered or the
  // person swiped, and tells the wallet.
  const firefox = {
    shows: (id) => {
      ext.tray.add(id);
      ext.heard.shown?.(id);
    },
    takesAway: (id) => {
      ext.tray.delete(id);
      ext.heard.closed?.(id, true);
    },
  };
  const phone = async () => {
    onPhone();
    vi.stubGlobal("__DUSK_TARGET__", "firefox");
    const notices = await import("./txNotify.js");
    notices.registerTxNotificationHandlers();
    return notices;
  };

  // Amélie's and Marek's: Android's "Allow Firefox to send you notifications?" over the payment, again after a no.
  it("shows no notice by itself, so Firefox for Android never asks Android for leave over a payment", async () => {
    const { notifyTxExecuted, notifyTxSubmitted } = await phone();
    await notifyTxSubmitted({ hash: HASH, origin: "Wallet", nodeUrl: NODE });
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: NODE });
    expect(ext.created).toEqual([]);
  });

  // Hein's: arrival notices back on phones, asked for by the person.
  it("asks when the person taps Tell me when it arrives, once, and once that notice shows, shows the arrival in its place", async () => {
    const { askPhoneNotices, notifyTxExecuted, notifyTxSubmitted } = await phone();
    await expect(askPhoneNotices()).resolves.toBe("asked");
    // The question is Firefox's, as the first notice is made.
    expect(ids()).toEqual([ASKED]);
    // Asked again, or a send on its way: nothing more comes over the wallet.
    await expect(askPhoneNotices()).resolves.toBe("asked");
    await notifyTxSubmitted({ hash: HASH, origin: "Wallet" });
    expect(ids()).toEqual([ASKED]);

    // Allowed: Firefox shows that notice, and the payment's arrival takes its place.
    firefox.shows(ASKED);
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: NODE });
    expect(ids()).toEqual([ASKED, `dusk_tx_${HASH}_executed`]);
    expect([...ext.tray]).toEqual([]);
    await notifyTxExecuted({ hash: HASH, ok: false, error: "out of gas", nodeUrl: NODE });
    expect(ids().at(-1)).toBe(`dusk_tx_${HASH}_failed`);
  });

  // Astra's: allowed, then swiped away before the payment arrived, read as a no and kept off.
  it("shows the arrival after the notice that asked was swiped away", async () => {
    const { askPhoneNotices, notifyTxExecuted } = await phone();
    await askPhoneNotices();
    firefox.shows(ASKED);
    firefox.takesAway(ASKED);
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: NODE });
    expect(ids()).toEqual([ASKED, `dusk_tx_${HASH}_executed`]);
    await expect(askPhoneNotices()).resolves.toBe("on");
  });

  it("shows the arrival when Firefox said nothing of the notice that asked, rather than none ever", async () => {
    const { askPhoneNotices, notifyTxExecuted } = await phone();
    await askPhoneNotices();
    // Shown and swiped away while the wallet slept: it heard neither, and the notice is gone.
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: NODE });
    expect(ids()).toEqual([ASKED, `dusk_tx_${HASH}_executed`]);
  });

  // Astra's: two sends settling together, the second's check finding the
  // notice the first just took away, and keeping notices off.
  it("shows each of two arrivals settling together", async () => {
    const { askPhoneNotices, notifyTxExecuted } = await phone();
    await askPhoneNotices();
    firefox.shows(ASKED);
    // Another send settles as the first's arrival takes the place of the notice that asked.
    const OTHER = "cd".repeat(32);
    let second = null;
    ext.onClear = () => (second ??= notifyTxExecuted({ hash: OTHER, ok: true, nodeUrl: NODE }));
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: NODE });
    await second;
    expect(ids()).toEqual([ASKED, `dusk_tx_${HASH}_executed`, `dusk_tx_${OTHER}_executed`]);
    await expect(askPhoneNotices()).resolves.toBe("on");
  });

  it("never asks again after a no, and shows nothing more", async () => {
    const { askPhoneNotices, notifyTxExecuted } = await phone();
    await askPhoneNotices();
    // Turned down: Firefox takes the notice away without showing it.
    firefox.takesAway(ASKED);
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: NODE });
    await notifyTxExecuted({ hash: HASH, ok: false, nodeUrl: NODE });
    await expect(askPhoneNotices()).resolves.toBe("off");
    expect(ids()).toEqual([ASKED]);
  });
});

// Seen on Firefox for Android: an arrival never showed, its notice refused for its buttons.
describe("in Firefox", () => {
  it("shows a send's outcome without buttons, rather than none, and opens the explorer from the notice itself", async () => {
    vi.stubGlobal("__DUSK_TARGET__", "firefox");
    const { notifyTxExecuted, registerTxNotificationHandlers } = await import("./txNotify.js");
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: "https://my-node.example" });
    expect(ext.created.map(({ id, opts }) => [id.replace(/_\d+$/, ""), opts.title, opts.buttons])).toEqual([[`dusk_tx_${HASH}_executed`, "Transaction executed", undefined]]);
    registerTxNotificationHandlers();
    await ext.clicked(ext.created[0].id);
    expect(ext.tabs).toEqual([EXPLORER]);
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
