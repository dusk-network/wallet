import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The extension's notifications, recorded; nothing is shown. `meta` is the
// transaction's record (txStore.js). On a phone, Firefox for Android as it
// does: a notice made without Android's leave (`android`, "ask" till the
// person answers, "no" after a no) has Android ask (`questions`), and the last
// one made holds the answer (`question`); `tray` is what shows, and `heard`
// what Firefox tells the wallet (onShown, onClosed, and its own start).
const ext = vi.hoisted(() => ({ clicked: null, created: [], tabs: [], meta: null, android: null, question: null, questions: [], tray: new Set(), heard: {}, onClear: null }));
vi.mock("../platform/extensionApi.js", () => ({
  getExtensionApi: () => ({
    notifications: {
      onClicked: { addListener: (fn) => (ext.clicked = fn) },
      onButtonClicked: { addListener: () => {} },
      onShown: { addListener: (fn) => (ext.heard.shown = fn) },
      onClosed: { addListener: (fn) => (ext.heard.closed = fn) },
    },
    runtime: { onStartup: { addListener: (fn) => (ext.heard.startup = fn) } },
  }),
  // Firefox, which a test builds for, has no buttons on a notice, and refuses one that asks for them.
  notificationsCreate: vi.fn(async (id, opts) => {
    if (globalThis.__DUSK_TARGET__ === "firefox" && opts.buttons) {
      throw new TypeError('Type error for parameter options (Property "buttons" is unsupported by Firefox) for notifications.create.');
    }
    ext.created.push({ id, opts });
    if (ext.android === "yes") {
      ext.tray.add(id);
      ext.heard.shown?.(id);
    } else if (ext.android) {
      ext.questions.push(id);
      ext.question = id;
    }
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
  Object.assign(ext, { clicked: null, created: [], tabs: [], open: [], meta: { nodeUrl: "https://my-node.example" }, android: null, question: null, questions: [], tray: new Set(), heard: {}, onClear: null });
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
  const tray = () => [...ext.tray].map((id) => id.replace(/_\d+$/, ""));
  const ASKED = "dusk_notices_asked";
  const NODE = "https://my-node.example";
  const OTHER = "cd".repeat(32);
  const phone = async () => {
    onPhone();
    vi.stubGlobal("__DUSK_TARGET__", "firefox");
    ext.android ??= "ask";
    const notices = await import("./txNotify.js");
    notices.registerTxNotificationHandlers();
    return notices;
  };
  const firefox = {
    // The person answers Android's question: Firefox shows the notice holding
    // the answer, or takes it away unshown.
    answer: (yes) => {
      const id = ext.question;
      ext.question = null;
      ext.android = yes ? "yes" : "no";
      if (yes) {
        ext.tray.add(id);
        ext.heard.shown?.(id);
      } else {
        ext.heard.closed?.(id, true);
      }
    },
    swipe: (id) => {
      ext.tray.delete(id);
      ext.heard.closed?.(id, true);
    },
    // Firefox goes, its question with it, and starts again: a new background hears its start.
    restarts: async () => {
      ext.question = null;
      vi.resetModules();
      const notices = await phone();
      ext.heard.startup?.();
      return notices;
    },
  };

  // Amélie's and Marek's: Android's "Allow Firefox to send you notifications?" over the payment, again after a no.
  it("shows no notice by itself, so Firefox for Android never asks Android for leave over a payment", async () => {
    const { notifyTxExecuted, notifyTxSubmitted } = await phone();
    await notifyTxSubmitted({ hash: HASH, origin: "Wallet", nodeUrl: NODE });
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: NODE });
    expect(ext.created).toEqual([]);
  });

  // Hein's: arrival notices back on phones, asked for by the person.
  it("asks when the person taps Tell me when it arrives, once, and with a yes shows the arrival in the place of the notice that asked", async () => {
    const { askPhoneNotices, notifyTxExecuted, notifyTxSubmitted } = await phone();
    await expect(askPhoneNotices()).resolves.toBe("asked");
    // The question is Firefox's, as the first notice is made.
    expect(ext.questions).toEqual([ASKED]);
    // Asked again, or a send on its way: nothing more comes over the wallet.
    await expect(askPhoneNotices()).resolves.toBe("asked");
    await notifyTxSubmitted({ hash: HASH, origin: "Wallet" });
    expect(ids()).toEqual([ASKED]);

    // The payment arrives with the question on screen, and waits for the answer: a yes.
    const arrival = notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: NODE });
    firefox.answer(true);
    await arrival;
    expect(ids()).toEqual([ASKED, `dusk_tx_${HASH}_executed`]);
    expect(tray()).toEqual([`dusk_tx_${HASH}_executed`]);
    await notifyTxExecuted({ hash: HASH, ok: false, error: "out of gas", nodeUrl: NODE });
    expect(ids().at(-1)).toBe(`dusk_tx_${HASH}_failed`);
    expect(ext.questions).toEqual([ASKED]);
  });

  // Astra's: a notice made with the question on screen took its answer, and
  // a no closed that one, unheard, so a later send asked again.
  it("waits for the answer with the question on screen, so a no is heard and nothing asks again", async () => {
    const { askPhoneNotices, notifyTxExecuted } = await phone();
    await askPhoneNotices();
    const arrival = notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: NODE });
    firefox.answer(false);
    await arrival;
    await notifyTxExecuted({ hash: OTHER, ok: true, nodeUrl: NODE });
    expect(ext.questions).toEqual([ASKED]);
    expect(ids()).toEqual([ASKED]);
    await expect(askPhoneNotices()).resolves.toBe("off");
  });

  // A question doesn't outlive Firefox: unanswered, it's not asked, and nothing asks by itself.
  it("offers the tap again once Firefox starts anew with its question unanswered", async () => {
    await (await phone()).askPhoneNotices();
    const { askPhoneNotices, notifyTxExecuted } = await firefox.restarts();
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: NODE });
    expect(ext.questions).toEqual([ASKED]);
    const { noticesState } = await import("../shared/phoneNotices.js");
    await expect(noticesState()).resolves.toBe(null);
    // Tapped again: the phone asks, as the person asked.
    await expect(askPhoneNotices()).resolves.toBe("asked");
    expect(ext.questions).toEqual([ASKED, ASKED]);
  });

  // Astra's: allowed, then swiped away before the payment arrived, read as a no and kept off.
  it("shows the arrival after the notice that asked was swiped away", async () => {
    const { askPhoneNotices, notifyTxExecuted } = await phone();
    await askPhoneNotices();
    firefox.answer(true);
    firefox.swipe(ASKED);
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: NODE });
    expect(ids()).toEqual([ASKED, `dusk_tx_${HASH}_executed`]);
    await expect(askPhoneNotices()).resolves.toBe("on");
  });

  // Astra's: two sends settling together, the second's check finding the
  // notice the first just took away, and keeping notices off.
  it("shows each of two arrivals settling together", async () => {
    const { askPhoneNotices, notifyTxExecuted } = await phone();
    await askPhoneNotices();
    firefox.answer(true);
    // Another send settles as the first's arrival takes the place of the notice that asked.
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
    firefox.answer(false);
    await notifyTxExecuted({ hash: HASH, ok: true, nodeUrl: NODE });
    await notifyTxExecuted({ hash: HASH, ok: false, nodeUrl: NODE });
    await expect(askPhoneNotices()).resolves.toBe("off");
    expect(ids()).toEqual([ASKED]);
    expect(ext.questions).toEqual([ASKED]);
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
