import { afterEach, describe, expect, it, vi } from "vitest";

import { accessibleName, fakeEvent, installFakeDom, pastClickGuard, settle, visibleText } from "../testing/fakeDom.js";

vi.mock("../../wallet/bus.js", () => ({ send: vi.fn() }));
// Deposits' arrivals, read as the popup draws: held for wallet B, to stop a
// redraw where the overview names B and the DOM is still A's.
const arrivals = vi.hoisted(() => ({ gate: null, heldFor: "" }));
vi.mock("../../shared/bridgeArrival.js", async (importOriginal) => ({
  ...(await importOriginal()),
  loadArrivals: vi.fn(async (walletId) => {
    if (arrivals.gate && walletId === arrivals.heldFor) await arrivals.gate.promise;
  }),
}));

const A =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const B =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const TO =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck929";
const wallet = (account, key) => ({
  hasVault: true,
  isUnlocked: true,
  networkName: "Testnet",
  nodeUrl: "https://testnet.nodes.dusk.network",
  accounts: [account],
  accountCount: 1,
  selectedAccountIndex: 0,
  balance: { value: "1500000000000" },
  shieldedBalance: { value: "0", spendable: "0" },
  txs: [],
  walletKey: key,
  wallets: [
    { key: "wa", n: 1, name: "", walletId: A, accounts: [A], accountNames: {}, active: key === "wa" },
    { key: "wb", n: 2, name: "", walletId: B, accounts: [B], accountNames: {}, active: key === "wb" },
  ],
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  arrivals.gate = null;
});

const flush = async () => {
  for (let i = 0; i < 8; i++) await settle();
};

// The popup on `route` with wallet A open; `t.open` is what the wallet's
// overview says, `t.deliver` the wallet's own messages to the popup.
async function popupOn(route, extra = {}, answer = async () => undefined, { history, tauri, mount = false, tab } = {}) {
  const dom = installFakeDom({ pathname: "/popup.html" });
  if (history) dom.window.history = history(dom.window);
  // The app on an Android phone: Tauri's bridge to the wrapper.
  if (tauri) {
    dom.window.__TAURI_INTERNALS__ = tauri;
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 6; wv) AppleWebKit/537.36 Chrome/156.0 Mobile Safari/537.36" });
  }
  dom.document.body.innerHTML = "";
  const header = dom.document.createElement("div");
  header.id = "header-actions";
  const app = dom.document.createElement("div");
  app.id = "app";
  dom.document.body.append(header, app);
  let onMessage = null;
  vi.stubGlobal("browser", {
    runtime: { id: "dusk-wallet", sendMessage: () => {}, onMessage: { addListener: (fn) => (onMessage = fn) } },
    // `tab`: the page in a tab of its own, as the extension's full page.
    ...(tab ? { tabs: { getCurrent: async () => tab } } : {}),
  });
  vi.resetModules();
  const { send } = await import("../../wallet/bus.js");
  const t = { dom, app, send, open: wallet(A, "wa") };
  send.mockReset();
  send.mockImplementation(async (message) => {
    const answered = await answer(message, t);
    if (answered !== undefined) return answered;
    if (message.type === "DUSK_UI_OVERVIEW") return t.open;
    if (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE") return { ok: true, result: { min: "1", median: "1", max: "1" } };
    if (message.type === "DUSK_UI_SEND_TX") return { ok: true, result: { hash: "ab".repeat(32) } };
    return { ok: true, result: null };
  });
  const { state } = await import("./state.js");
  Object.assign(state, { route, ...extra });
  const { render, mountPopup } = await import("./app.js");
  // `mount`: as the page starts (popup.js), a notice's tap read with the first draw.
  if (mount) mountPopup();
  else await render();
  await flush();
  return Object.assign(t, {
    state,
    render,
    deliver: (message, sender = {}, sendResponse = () => {}) => onMessage(message, sender, sendResponse),
    asked: (type) => send.mock.calls.map(([m]) => m).filter((m) => m.type === type),
  });
}

describe("a Review drawn for wallet A, with wallet B opened in another window", () => {
  it("sends nothing from the old Confirm pressed while the popup reads B but still shows A", async () => {
    const t = await popupOn("confirm", {
      addressBook: { loaded: true, items: [] },
      draft: { to: TO, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
    });
    const { app, send, state } = t;
    const confirm = app.querySelectorAll("button").find((b) => b.textContent === "Confirm");
    expect(confirm).toBeTruthy();

    // Wallet B opens in another window. The popup reads its overview, then
    // waits on B's arrivals before drawing: A's Review is still the screen.
    t.open = wallet(B, "wb");
    arrivals.gate = Promise.withResolvers();
    arrivals.heldFor = B;
    t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    await flush();
    expect(state.overview.accounts[0]).toBe(B);
    expect(app.contains(confirm)).toBe(true);

    pastClickGuard();
    confirm.click();
    await flush();
    arrivals.gate.resolve();
    await flush();

    expect(send.mock.calls.map(([m]) => m).filter((m) => m.type === "DUSK_UI_SEND_TX")).toEqual([]);
    expect([state.route, state.sent?.phase, state.sent?.error]).toEqual(["sent", "not_sent", "The network, profile or wallet changed meanwhile."]);
  });
});

describe("a Review's Confirm, the moment the Review is up", () => {
  const review = () => ({
    addressBook: { loaded: true, items: [] },
    draft: { to: TO, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
  });
  const confirm = (t) => t.app.querySelectorAll("button").find((b) => b.textContent === "Confirm");

  it("ignores a click as a double-click on Review lands there, sends one a moment later, and a redraw doesn't hold it again", async () => {
    const t = await popupOn("send", review());
    // Review pressed: the Review comes up, and the second click lands on Confirm.
    t.state.route = "confirm";
    await t.render();
    await flush();
    confirm(t).click();
    await flush();
    expect([t.asked("DUSK_UI_SEND_TX"), t.state.route, confirm(t).disabled]).toEqual([[], "confirm", false]);

    // A moment on, drawn again meanwhile (a poll), it's the same Review: Confirm sends.
    pastClickGuard();
    await t.render();
    await flush();
    confirm(t).click();
    await flush();
    expect(t.asked("DUSK_UI_SEND_TX")).toHaveLength(1);
  });

  it("ignores a click as the Review comes back after an unlock, where Unlock was", async () => {
    const t = await popupOn("confirm", review());
    pastClickGuard();
    t.open = { ...wallet(A, "wa"), isUnlocked: false };
    await t.render({ forceRefresh: true });
    await flush();
    expect(confirm(t)).toBeUndefined();

    pastClickGuard();
    t.open = wallet(A, "wa");
    await t.render({ forceRefresh: true });
    await flush();
    confirm(t).click();
    await flush();
    expect(t.asked("DUSK_UI_SEND_TX")).toEqual([]);

    pastClickGuard();
    confirm(t).click();
    await flush();
    expect(t.asked("DUSK_UI_SEND_TX")).toHaveLength(1);
  });
});

describe("a step to a Review", () => {
  it("comes up at once, with no rise, even while the view before it is still rising", async () => {
    const t = await popupOn("home", {
      addressBook: { loaded: true, items: [] },
      draft: { to: TO, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
    });
    // Another view rises into place (ui.css: #app.view-animate).
    t.state.route = "send";
    await t.render();
    expect(t.app.classList.contains("view-animate")).toBe(true);
    // Review pressed before that rise is done: it's there at once.
    t.state.route = "confirm";
    await t.render();
    expect(t.app.classList.contains("view-animate")).toBe(false);
    // Back to the form: at once too.
    t.state.route = "send";
    await t.render();
    expect(t.app.classList.contains("view-animate")).toBe(false);
  });
});

describe("a Review's From line", () => {
  it("names the wallet the Review was drawn for, which its Confirm sends from", async () => {
    const t = await popupOn("confirm", {
      addressBook: { loaded: true, items: [] },
      draft: { to: TO, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
    });
    const from = () => t.app.querySelectorAll(".send-review > .group > .kv").map((kv) => kv.textContent).find((text) => text.startsWith("From"));
    expect(from()).toBe("FromWallet 1 · Profile 1 · Public");

    // Wallet B opens in another window: the Review drawn again says B, and sends from B.
    t.open = wallet(B, "wb");
    t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    await flush();
    expect(from()).toBe("FromWallet 2 · Profile 1 · Public");
    pastClickGuard();
    t.app.querySelectorAll("button").find((b) => b.textContent === "Confirm").click();
    await flush();
    expect(t.asked("DUSK_UI_SEND_TX")).toEqual([expect.objectContaining({ walletId: B })]);
  });
});

describe("a screen's own actions, after another wallet opened", () => {
  it("name the wallet the screen was drawn for, so the wallet refuses them for another", async () => {
    const t = await popupOn("options");
    const select = t.app.querySelectorAll("select").find((el) => accessibleName(el) === "Active profile");
    expect(select).toBeTruthy();
    select.value = "0";
    select.dispatchEvent(fakeEvent("change"));
    await flush();
    expect(t.asked("DUSK_UI_SET_ACCOUNT_INDEX")).toEqual([expect.objectContaining({ index: 0, walletId: A })]);
  });

  it("closes the profile menu that lists the wallet before", async () => {
    const t = await popupOn("home");
    t.dom.document.body.querySelector("#header-actions .account-chip").click();
    await flush();
    expect(t.dom.document.body.querySelector(".acct-menu")).toBeTruthy();
    t.open = wallet(B, "wb");
    t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    await flush();
    expect(t.dom.document.body.querySelector(".acct-menu")).toBeNull();
  });
});

describe("a wallet removed in another window", () => {
  it("leaves its Remove form for Settings, and the list is read again", async () => {
    const t = await popupOn("wallet_remove", { walletRemove: "wb" });
    expect(t.app.querySelector(".subnav")?.textContent ?? t.app.textContent).toContain("Remove wallet");
    const reads = t.asked("DUSK_UI_OVERVIEW").length;
    // Wallet B goes in another window: A stays open, so no switch is said.
    t.open = { ...wallet(A, "wa"), wallets: [wallet(A, "wa").wallets[0]] };
    t.deliver({ type: "DUSK_UI_WALLETS_CHANGED" });
    await flush();
    expect(t.asked("DUSK_UI_OVERVIEW").length).toBeGreaterThan(reads);
    expect([t.state.route, t.state.walletRemove]).toEqual(["options", null]);
    expect(t.app.querySelectorAll("button").map((b) => b.textContent)).not.toContain("Remove wallet");
  });
});

describe("stDUSK, found on the dashboard", () => {
  it("is found again for another wallet on the same network and profile", async () => {
    const STDUSK = "5d".repeat(32);
    // Each wallet holds stDUSK with Sozu, and watches no token yet.
    const t = await popupOn("home", {}, async (message) => {
      if (message.type === "DUSK_UI_GET_SOZU_STATUS") {
        return { ok: true, result: { contracts: { "staked-dusk": STDUSK }, position: { stDuskBalanceLux: "5000000000" } } };
      }
      if (message.type === "DUSK_UI_ASSETS_GET") return { ok: true, result: { tokens: [], nfts: [] } };
      return undefined;
    });
    await flush();
    expect(t.asked("DUSK_UI_ASSETS_WATCH_TOKEN").map((m) => m.walletId)).toEqual([A]);

    t.open = wallet(B, "wb");
    t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    await flush();
    expect(t.asked("DUSK_UI_ASSETS_WATCH_TOKEN").map((m) => m.walletId)).toEqual([A, B]);
  });
});

// Lena's, the third round: right after the extension's own unstake, Rewards by year kept the "taken out" from before.
describe("a stake or an unstake with Sozu that goes through", () => {
  it("has Staking read the history again for Rewards by year, once, and nothing for another send", async () => {
    const UNSTAKE = "7f".repeat(32);
    const PAYMENT = "7a".repeat(32);
    const t = await popupOn("home");
    t.open = { ...t.open, txs: [{ hash: UNSTAKE, status: "submitted", asset: { kind: "sozu", action: "sozu_unstake" } }, { hash: PAYMENT, status: "submitted" }] };
    await t.render({ forceRefresh: true });
    const read = () => ((t.state.sozu ??= {}).history = { key: "read before" });
    read();
    t.deliver({ type: "DUSK_UI_TX_STATUS", hash: PAYMENT, status: "executed" });
    await flush();
    expect(t.state.sozu.history).toEqual({ key: "read before" });
    t.deliver({ type: "DUSK_UI_TX_STATUS", hash: UNSTAKE, status: "executed" });
    await flush();
    expect(t.state.sozu.history).toBeNull();
    // Its next word, a recheck's: already read again.
    read();
    t.deliver({ type: "DUSK_UI_TX_STATUS", hash: UNSTAKE, status: "executed", feePaid: "1856759" });
    await flush();
    expect(t.state.sozu.history).toEqual({ key: "read before" });
  });
});

describe("a Copy button that says Copied", () => {
  it("keeps the focus when the popup is drawn again meanwhile", async () => {
    const t = await popupOn("receive");
    const copyAddress = () => t.app.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === "Copy address");
    const pressed = copyAddress();
    pressed.focus();
    pressed.click();
    await flush();
    expect(pressed.getAttribute("aria-label")).toBe("Copied");

    // A poll draws the popup again within the 1.5 s: the focus moves to the new Copy.
    await t.render();
    await flush();
    expect(t.dom.document.activeElement).toBe(copyAddress());
  });
});

// The page's history as a browser keeps it: Back (`back`) goes to the entry
// before, with a popstate; with none before, it closes the wallet.
function pageHistory(win) {
  const entries = [{}];
  let at = 0;
  return {
    closed: false,
    get length() {
      return entries.length;
    },
    get at() {
      return at;
    },
    pushState(state) {
      entries.splice(at + 1, Infinity, state);
      at++;
    },
    back() {
      this.go(-1);
    },
    go(delta) {
      if (at + delta < 0) {
        this.closed = true;
        return;
      }
      at += delta;
      setTimeout(() => win.dispatchEvent(fakeEvent("popstate", { state: entries[at] })), 0);
    },
  };
}

// A browser that takes one step of the page's history at a time, as Firefox
// for Android may: a step asked while one is under way goes nowhere. Its
// entries keep their state, which `state` gives for the one it's on.
function oneStepHistory(win) {
  const entries = [null];
  let at = 0;
  let moving = false;
  return {
    closed: false,
    get state() {
      return entries[at];
    },
    get at() {
      return at;
    },
    pushState(state) {
      entries.splice(at + 1, Infinity, state);
      at++;
    },
    back() {
      this.go(-1);
    },
    go(delta) {
      if (moving) return;
      if (at + delta < 0) {
        this.closed = true;
        return;
      }
      at += delta;
      moving = true;
      setTimeout(() => {
        moving = false;
        win.dispatchEvent(fakeEvent("popstate", { state: entries[at] }));
      }, 0);
    },
  };
}

describe("the phone's Back button", () => {
  // Amélie's: after a payment, Back on Home did nothing two or three times before it left.
  it("leaves from Home with one Back after a payment's Done, the browser taking one step at a time", async () => {
    let history;
    const t = await popupOn(
      "home",
      { addressBook: { loaded: true, items: [] }, draft: null },
      undefined,
      { history: (win) => (history = oneStepHistory(win)) }
    );
    const button = (text) => t.app.querySelectorAll("button").find((b) => b.textContent === text);
    t.app.querySelectorAll("button").find((b) => b.textContent === "Send" && b.closest(".action-bar, .dashboard-top-actions")).click();
    await flush();
    const field = (name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    field("To").value = B;
    field("To").dispatchEvent(fakeEvent("input"));
    field("Amount").value = "1";
    field("Amount").dispatchEvent(fakeEvent("input"));
    button("Review").click();
    await flush();
    pastClickGuard();
    button("Confirm").click();
    await flush();
    expect(t.state.route).toBe("sent");
    button("Done").click();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    expect(t.state.route).toBe("home");
    // Nothing of the wallet's left above the page's own entry: one Back leaves.
    expect(history.at).toBe(0);
    history.back();
    expect(history.closed).toBe(true);
  });

  it("keeps one entry for each step in: the page's own Back takes one, and none goes up while no one presses anything", async () => {
    let history;
    const t = await popupOn(
      "send",
      { addressBook: { loaded: true, items: [] }, draft: { to: B, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" } },
      undefined,
      { history: (win) => (history = pageHistory(win)) }
    );
    const button = (text) => t.app.querySelectorAll("button").find((b) => b.textContent === text);
    button("Review").click();
    await flush();
    expect(history.at).toBe(2);
    button("← Back").click();
    await flush();
    expect([t.state.route, history.at]).toEqual(["send", 1]);
    button("Review").click();
    await flush();
    expect(history.at).toBe(2);

    // The person's Back, then the wallet drawing again on its own: no entry goes up,
    // which a WebView would skip, closing the app on the next Back.
    history.back();
    await flush();
    await t.render({ forceRefresh: true });
    await flush();
    expect([t.state.route, history.at]).toEqual(["send", 1]);
  });

  // Amélie's: on Import opened from Firefox's menu, Back closed the wallet with 12 typed words.
  it("asks before Import's typed words go, and the question's own Back keeps them", async () => {
    let history;
    const t = await popupOn(
      "onboard_welcome",
      { onboard: { mode: null, mnemonic: null, password: "", reveal: false } },
      async (message) => (message.type === "DUSK_UI_OVERVIEW" ? { hasVault: false, isUnlocked: false, networkName: "Testnet" } : undefined),
      { history: (win) => (history = pageHistory(win)) }
    );
    const word = (n) => t.app.querySelectorAll("input").find((i) => accessibleName(i) === `Word ${n}`);
    const question = () => t.dom.document.querySelector("[role=alertdialog]");
    t.app.querySelectorAll("button").find((b) => b.textContent.startsWith("Import wallet")).click();
    await flush();
    expect([t.state.route, history.at]).toEqual(["onboard_import", 1]);
    word(1).value = "abandon";
    word(1).dispatchEvent(fakeEvent("input"));
    await flush();

    history.back();
    await flush();
    expect(question()?.textContent).toContain("Go back?");
    expect([t.state.route, history.closed]).toEqual(["onboard_import", false]);
    // The question's own Back: its Cancel, the words kept.
    history.back();
    await flush();
    expect([question(), word(1).value, history.closed]).toEqual([null, "abandon", false]);

    // Nothing typed: one entry, and Back goes at once.
    word(1).value = "";
    word(1).dispatchEvent(fakeEvent("input"));
    await flush();
    expect(history.at).toBe(1);
    history.back();
    await flush();
    expect([t.state.route, question()]).toEqual(["onboard_welcome", null]);
  });

  it("goes one screen back inside the wallet, Review to the Send form with what was typed, and leaves only from Home", async () => {
    let history;
    const t = await popupOn(
      "send",
      { addressBook: { loaded: true, items: [] }, draft: { to: B, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" } },
      undefined,
      { history: (win) => (history = pageHistory(win)) }
    );
    const { app, state } = t;
    const button = (text) => app.querySelectorAll("button").find((b) => b.textContent === text);
    const memo = () => app.querySelectorAll("input").find((i) => accessibleName(i) === "Memo");
    // A screen with a way back stands one entry above the page's own.
    expect(history.at).toBe(1);
    memo().value = "Lunch for Léa";
    memo().dispatchEvent(fakeEvent("input"));
    button("Review").click();
    await flush();
    expect(state.route).toBe("confirm");
    // A step in: one entry more.
    expect(history.at).toBe(2);

    history.back();
    await flush();
    expect(state.route).toBe("send");
    expect([app.querySelector(".to-input-wrap textarea").value, memo().value]).toEqual([B, "Lunch for Léa"]);
    expect([history.at, history.closed]).toEqual([1, false]);

    history.back();
    await flush();
    expect(state.route).toBe("home");
    // Home has no way back: Back leaves the wallet, as before.
    expect(history.at).toBe(0);
    history.back();
    expect(history.closed).toBe(true);
  });
});

// Astra's: called off on its Sent, a payment that waited said "Sent" on Home though nothing went out, and one
// whose try failed and whose record went said the same. Leaving the waiting list says nothing of how it left:
// one that went out is in Activity by then, as the wallet keeps it as sent first.
describe("a payment that waited, on Home", () => {
  it("never says it was sent for leaving the waiting list, called off on its Sent or failed", async () => {
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } });
    const waiting = (sendId, memo) => ({ sendId, walletId: A, nodeUrl: t.open.nodeUrl, profileIndex: 0, privacy: "public", to: B, lux: "10000000", feeLux: "2500000", memo, at: Date.now() - 60_000, waiting: true, waits: false });
    const cards = () => [...t.app.querySelectorAll(".home-waiting")].map((card) => card.textContent);
    t.open = { ...t.open, waitingSends: [waiting("send-0201", "Hors ligne un"), waiting("send-0202", "Hors ligne deux")] };
    await t.render({ forceRefresh: true });
    expect(cards()).toEqual([expect.stringContaining("Sending: "), expect.stringContaining("Sending: ")]);
    // Called off on its Sent, the other's try failed and its record went: both leave the list, nothing went out.
    t.open = { ...t.open, waitingSends: [] };
    await t.render({ forceRefresh: true });
    expect(cards()).toEqual([]);
    expect(t.app.textContent).not.toContain("Sent: ");
  });
});

// Chen's: Amelie and 0.02 typed, Back, Back, and Send again was empty, nothing asked.
describe("a half-typed Send, left with Back", () => {
  it("is there again as Send opens from Home, for the same wallet, profile and network, and goes once it's sent", async () => {
    let history;
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, undefined, { history: (win) => (history = pageHistory(win)) });
    const button = (text) => t.app.querySelectorAll("button").find((b) => b.textContent === text);
    const field = (name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    const type = (name, value) => {
      field(name).value = value;
      field(name).dispatchEvent(fakeEvent("input"));
    };
    const openSend = async () => {
      t.app.querySelectorAll("button").find((b) => b.textContent === "Send" && b.closest(".action-bar, .dashboard-top-actions")).click();
      await flush();
      expect(t.state.route).toBe("send");
    };
    await openSend();
    type("To", B);
    type("Amount", "0.02");
    type("Memo", "satay");
    history.back();
    await flush();
    expect(t.state.route).toBe("home");
    await openSend();
    expect(["To", "Amount", "Memo"].map((name) => field(name).value)).toEqual([B, "0.02", "satay"]);

    // Another profile: not its own, so nothing.
    button("← Back").click();
    await flush();
    t.open = { ...t.open, selectedAccountIndex: 1 };
    await t.render({ forceRefresh: true });
    await openSend();
    expect(["To", "Amount", "Memo"].map((name) => field(name).value)).toEqual(["", "", ""]);

    // Sent: gone for good.
    button("← Back").click();
    await flush();
    t.open = { ...t.open, selectedAccountIndex: 0 };
    await t.render({ forceRefresh: true });
    await openSend();
    type("To", B);
    type("Amount", "0.02");
    button("Review").click();
    await flush();
    pastClickGuard();
    button("Confirm").click();
    await flush();
    expect(t.asked("DUSK_UI_SEND_TX")).toHaveLength(1);
    button("Done").click();
    await flush();
    await openSend();
    expect(["To", "Amount"].map((name) => field(name).value)).toEqual(["", ""]);
  });
});

describe("a request's Send", () => {
  // Sofía's: a scanned request left with Back came back, 0.03 and its memo, in the next Send.
  // Astra's: a Testnet request kept that way could be paid on Mainnet.
  it("isn't kept once left with Back, and leaves nothing to pay on another network", async () => {
    let history;
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, undefined, { history: (win) => (history = pageHistory(win)) });
    const field = (name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    const values = () => ["To", "Amount", "Memo"].map((name) => field(name).value);
    const openSend = async () => {
      t.app.querySelectorAll("button").find((b) => b.textContent === "Send" && b.closest(".action-bar, .dashboard-top-actions")).click();
      await flush();
      expect(t.state.route).toBe("send");
    };
    const { makePaymentLink } = await import("@dusk-network/app-core/payment-links");
    const pasteLink = async () => {
      field("To").value = makePaymentLink({ amount: "0.02", memo: "satay", network: "testnet", to: B }).dusk;
      field("To").dispatchEvent(fakeEvent("input", { inputType: "insertFromPaste" }));
      await flush();
      expect(values()).toEqual([B, "0.02", "satay"]);
    };
    await openSend();
    await pasteLink();
    // Edited, and Review and back, it's still the link's.
    field("Memo").value = "satay twice";
    field("Memo").dispatchEvent(fakeEvent("input"));
    t.app.querySelectorAll("button").find((b) => b.textContent === "Review").click();
    await flush();
    expect(t.state.route).toBe("confirm");
    t.app.querySelectorAll("button").find((b) => b.textContent === "← Back").click();
    await flush();
    expect(values()).toEqual([B, "0.02", "satay twice"]);
    expect(t.app.textContent).toContain("Filled in from the link");
    // Amélie's and Chen's: the phone's Back threw the link's payment away without a word. It asks.
    const question = () => t.dom.document.querySelector("[role=alertdialog]");
    history.back();
    await flush();
    expect(visibleText(question())).toBe("Leave this payment?This clears the payment the link filled in.LeaveStay");
    // Amélie's and Chen's: Leave was the wide pink button under the thumb. Stay is the main one, with the focus.
    expect([...question().querySelectorAll("button")].map((b) => [b.textContent, b.className])).toEqual([
      ["Leave", "btn-outline"],
      ["Stay", "btn-primary"],
    ]);
    expect(t.dom.document.activeElement.textContent).toBe("Stay");
    // The question's own Back is Stay: the payment stays.
    history.back();
    await flush();
    expect([question(), t.state.route, ...values(), history.closed]).toEqual([null, "send", B, "0.02", "satay twice", false]);
    // Asked again, Stay keeps it too.
    t.app.querySelector(".subnav-back").click();
    await flush();
    [...question().querySelectorAll("button")].find((b) => b.textContent === "Stay").click();
    await flush();
    expect([question(), t.state.route, ...values()]).toEqual([null, "send", B, "0.02", "satay twice"]);
    // Leave: Home, and none of it in the next Send.
    history.back();
    await flush();
    [...question().querySelectorAll("button")].find((b) => b.textContent === "Leave").click();
    await flush();
    expect(t.state.route).toBe("home");
    await openSend();
    expect(values()).toEqual(["", "", ""]);
    expect(t.app.textContent).not.toContain("Filled in from");

    await pasteLink();
    // Mainnet, the form still open: nothing of the request stays to pay there.
    t.open = { ...t.open, nodeUrl: "https://nodes.dusk.network", networkName: "Mainnet" };
    await t.render({ forceRefresh: true });
    await flush();
    expect([t.state.route, ...values()]).toEqual(["send", "", "", ""]);
    expect(t.app.textContent).toContain("This request is for Testnet. You are on Mainnet.");
  });
});

// The page's history with each entry's address, as a browser keeps it: an
// entry pushed takes the address shown, replaceState rewrites the one it's on,
// Back and go() move with a popstate, and `location` (what a reload opens) is
// the address of the entry it's on.
function addressedHistory(win, first) {
  const entries = [{ state: null, url: first }];
  let at = 0;
  const shown = () => new URL(entries[at].url, "moz-extension://wallet");
  vi.stubGlobal("location", {
    get pathname() {
      return shown().pathname;
    },
    get search() {
      return shown().search;
    },
  });
  return {
    closed: false,
    get state() {
      return entries[at].state;
    },
    get at() {
      return at;
    },
    get url() {
      return entries[at].url;
    },
    get urls() {
      return entries.map((entry) => entry.url);
    },
    pushState(state, _title, url) {
      entries.splice(at + 1, Infinity, { state, url: url ?? entries[at].url });
      at++;
    },
    replaceState(state, _title, url) {
      entries[at] = { state, url: url ?? entries[at].url };
    },
    back() {
      this.go(-1);
    },
    go(delta) {
      if (at + delta < 0) {
        this.closed = true;
        return;
      }
      at += delta;
      setTimeout(() => win.dispatchEvent(fakeEvent("popstate", { state: entries[at].state })), 0);
    },
  };
}

// Amélie's: after paying a link and Done, or after Back from its Send, pulling the
// page down brought the same payment back, filled in: the wallet's entries for
// the phone's Back kept the link in their address, and Done stepped back onto one.
describe("a request link the extension's tab opened with", () => {
  const opened = async () => {
    const { makePaymentLink } = await import("@dusk-network/app-core/payment-links");
    const link = makePaymentLink({ amount: "0.02", memo: "Cadeau", network: "testnet", to: B }).https;
    let history;
    const t = await popupOn("send", { addressBook: { loaded: true, items: [] } }, undefined, {
      history: (win) => (history = addressedHistory(win, `/full.html?route=send&link=${encodeURIComponent(link)}`)),
    });
    const field = (name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    expect(["To", "Amount", "Memo"].map((name) => field(name).value)).toEqual([B, "0.02", "Cadeau"]);
    return { t, history, button: (text) => t.app.querySelectorAll("button").find((b) => b.textContent === text) };
  };
  // Pulling the page down: it opens again at the address it's on.
  const reloaded = async () => {
    vi.resetModules();
    const { state } = await import("./state.js");
    return [state.route, state.draft];
  };
  const settled = async () => {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
  };

  it("is off the page's address once it's paid and Done, from every entry it comes back to", async () => {
    const { t, history, button } = await opened();
    button("Review").click();
    await settled();
    pastClickGuard();
    button("Confirm").click();
    await settled();
    expect(t.state.route).toBe("sent");
    button("Done").click();
    await settled();

    expect(t.state.route).toBe("home");
    expect(history.url).toBe("/full.html");
    expect(await reloaded()).toEqual(["home", null]);
  });

  it("is off it once its Send is left with Back, and stays while it's paid", async () => {
    const { t, history, button } = await opened();
    // Review and back to the form: still the link's.
    button("Review").click();
    await settled();
    button("← Back").click();
    await settled();
    expect(t.state.route).toBe("send");
    expect(history.url).toContain("link=");

    button("← Back").click();
    await settled();
    // It asks first; Leave goes.
    [...t.dom.document.querySelectorAll("[role=alertdialog] button")].find((b) => b.textContent === "Leave").click();
    await settled();
    expect(t.state.route).toBe("home");
    expect(history.url).toBe("/full.html");
    expect(await reloaded()).toEqual(["home", null]);

    // Firefox's Forward, onto an entry the wallet put up for Review: no link there either.
    expect(history.urls.at(-1)).toContain("link=");
    history.go(history.urls.length - 1 - history.at);
    await settled();
    expect(history.url).not.toContain("link=");
    expect(await reloaded()).toEqual(["home", null]);
  });
});

describe("coming back to the wallet during a payment", () => {
  // Seen on testnet: after a send with no clear answer, each lookup, every 10 seconds, said it was still pending
  // again, a toast with View over Review's Confirm for three minutes.
  it("says a send is still pending once, not again at each lookup that hears no more of it", async () => {
    const HASH = "7e".repeat(32);
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } });
    const toasts = () => t.dom.document.body.querySelectorAll(".toast").filter((el) => !el.classList.contains("toast--leaving"));
    t.deliver({ type: "DUSK_UI_TX_STATUS", hash: HASH, status: "unknown" });
    await flush();
    const first = toasts().at(-1);
    expect(first?.textContent).toContain("still pending");
    t.deliver({ type: "DUSK_UI_TX_STATUS", hash: HASH, status: "unknown" });
    await flush();
    expect(toasts()).toEqual([first]);
    // News, once it comes.
    t.deliver({ type: "DUSK_UI_TX_STATUS", hash: HASH, status: "executed", ok: true });
    await flush();
    expect(toasts().at(-1).textContent).toContain("completed");
  });

  // Chen's: back a minute later, the first thing shown was "waiting for a block", the block long come.
  it("says it's looked up again from the moment it's left, never the wait for a block, till the lookup answers", async () => {
    const HASH = "9e".repeat(32);
    const looked = Promise.withResolvers();
    const t = await popupOn(
      "sent",
      { addressBook: { loaded: true, items: [] }, sent: { phase: "sent", status: "submitted", hash: HASH, title: "Send", amountLux: "30000000", feeCapLux: "2500000", sentAt: Date.now(), startedAt: Date.now() } },
      async (message, t) => {
        if (message.type === "DUSK_UI_RECHECK_TX" && message.hash === HASH) {
          await looked.promise;
          t.open = { ...t.open, txs: [{ hash: HASH, status: "executed", submittedAt: Date.now() - 60_000, feePaid: "1855943", blockHeight: "4823435" }] };
          t.deliver({ type: "DUSK_UI_TX_STATUS", hash: HASH, status: "executed", ok: true });
          return { ok: true };
        }
        return undefined;
      }
    );
    t.open = { ...t.open, txs: [{ hash: HASH, status: "submitted", submittedAt: Date.now() - 60_000 }] };
    await t.render({ forceRefresh: true });
    expect(t.app.textContent).toContain("Waiting for a block");

    // Home pressed: what shows as the wallet comes back is the lookup, not the wait.
    t.dom.document.visibilityState = "hidden";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    expect(t.app.textContent).toContain("Looking it up again…");
    expect(t.app.textContent).not.toContain("Waiting for a block");
    t.dom.document.visibilityState = "visible";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    await flush();
    expect(t.app.textContent).toContain("Looking it up again…");
    looked.resolve();
    await flush();
    expect(t.app.textContent).toContain("In block 4,823,435");
    expect(t.app.textContent).not.toContain("Looking it up again…");
  });

  // Amélie's, in Firefox for Android: back online, she confirmed again, and Sent said "Waiting
  // for a block" for 4.5 minutes, the payment long in its block: its watcher never answered.
  it("looks the payment up by its ID once its watcher has said nothing for 20 seconds", async () => {
    const HASH = "9d".repeat(32);
    const t = await popupOn(
      "sent",
      { addressBook: { loaded: true, items: [] }, sent: { phase: "sent", status: "submitted", hash: HASH, title: "Send", amountLux: "10000000", feeCapLux: "2500000", sentAt: Date.now() - 21_000, startedAt: Date.now() - 22_000 } },
      async (message, t) => {
        if (message.type === "DUSK_UI_RECHECK_TX" && message.hash === HASH) {
          t.open = { ...t.open, txs: [{ hash: HASH, status: "executed", submittedAt: Date.now() - 21_000, feePaid: "1856521", blockHeight: "4831109" }] };
          return { ok: true };
        }
        return undefined;
      }
    );
    await vi.waitFor(() => expect(t.app.textContent).toContain("In block 4,831,109"));
    expect(t.asked("DUSK_UI_RECHECK_TX").map((m) => m.hash)).toEqual([HASH]);
    expect(t.app.textContent).toContain("0.001856521");
  });

  // Lena's: Completed, in its block, said "Network fee Up to 0,0025 DUSK" 47 s after the
  // connection came back: the node hadn't answered with its fee as it completed.
  it("reads a completed payment's fee again once the connection is back, and says it", async () => {
    const HASH = "9c".repeat(32);
    let fee = null;
    const t = await popupOn(
      "sent",
      { addressBook: { loaded: true, items: [] }, sent: { phase: "sent", status: "executed", hash: HASH, title: "Send", amountLux: "10000000", feeCapLux: "2500000", blockHeight: "4833511", sentAt: Date.now(), startedAt: Date.now() } },
      async (message, t) => {
        if (message.type === "DUSK_UI_RECHECK_TX" && message.hash === HASH) {
          fee = "1856956";
          t.open = { ...t.open, txs: [{ hash: HASH, status: "executed", submittedAt: Date.now() - 30_000, feePaid: fee, blockHeight: "4833511" }] };
          return { ok: true };
        }
        return undefined;
      }
    );
    t.open = { ...t.open, txs: [{ hash: HASH, status: "executed", submittedAt: Date.now() - 30_000, blockHeight: "4833511" }] };
    await t.render({ forceRefresh: true });
    expect(t.app.textContent).toContain("Up to 0.0025");

    t.dom.window.dispatchEvent(fakeEvent("online"));
    await vi.waitFor(() => expect(t.app.textContent).toContain("0.001856956"));
    expect(t.app.textContent).not.toContain("Up to 0.0025");
    expect(fee).toBe("1856956");
  });

  // Lena's, the third round: the node went silent at Confirm and answered again 26 s later, and Completed kept
  // "Network fee Up to 0,0025 DUSK" 42 s after that: a read under way when it went silent never ended, and the
  // look-ups waited on it.
  it("goes on looking a completed payment's fee up though a read under way never ends, and says the fee it hears", async () => {
    const HASH = "9a".repeat(32);
    let silent = false;
    let looks = 0;
    const t = await popupOn(
      "sent",
      { addressBook: { loaded: true, items: [] }, sent: { phase: "sent", status: "executed", hash: HASH, title: "Send", amountLux: "10000000", feeCapLux: "2500000", blockHeight: "4854743", sentAt: Date.now(), startedAt: Date.now() } },
      async (message, t) => {
        // A read the silent node holds, for good.
        if (silent && message.type === "DUSK_UI_OVERVIEW") return new Promise(() => {});
        if (message.type === "DUSK_UI_RECHECK_TX" && message.hash === HASH) {
          looks += 1;
          // The node answers again from the second look on (the read it held stays held): the wallet tells the page
          // the block and fee it writes.
          if (looks > 1) {
            silent = false;
            t.deliver({ type: "DUSK_UI_TX_STATUS", hash: HASH, status: "executed", ok: true, feePaid: "1857579", blockHeight: "4854743" });
          }
          return { ok: true, result: { status: "executed" } };
        }
        return undefined;
      }
    );
    t.open = { ...t.open, txs: [{ hash: HASH, status: "executed", submittedAt: Date.now(), blockHeight: "4854743" }] };
    await t.render({ forceRefresh: true });
    expect(t.app.textContent).toContain("Up to 0.0025");
    silent = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Looked up as the connection comes back, then every 10 s, however the reads in between went.
      t.dom.window.dispatchEvent(fakeEvent("online"));
      await vi.advanceTimersByTimeAsync(0);
      expect(looks).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(looks).toBe(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(t.app.textContent).toContain("0.001857579");
      expect(t.app.textContent).not.toContain("Up to 0.0025");
    } finally {
      vi.useRealTimers();
    }
  });

  // Astra's, as the web wallet does it: Don't send, on one whose hand-over had no clear answer, forgot it, saying
  // nothing left the wallet, though it might still arrive. It's followed by its ID while the wallet shows, whatever
  // its age, and listed nowhere meanwhile; once it went after all, it's listed as Sent, and said so.
  it("follows a send chosen not to be sent, listing it nowhere, and says so once it went after all", async () => {
    const HASH = "9e".repeat(32);
    let arrived = false;
    const record = { hash: HASH, kind: "transfer", privacy: "public", to: TO, amount: "10000000", status: "unsent", dontSendAt: Date.now() - 60_000, submittedAt: Date.now() - 2 * 60 * 60_000, account: A, nonce: "7", nodeUrl: "https://testnet.nodes.dusk.network", walletId: A, profileIndex: 0, source: "sent", origin: "Wallet" };
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, async (message, t) => {
      if (message.type === "DUSK_UI_RECHECK_TX" && message.hash === HASH) {
        if (!arrived) return { ok: true, result: { status: "unsent" } };
        t.open = { ...t.open, txs: [{ ...record, status: "executed", dontSendAt: undefined, wentAfterAll: Date.now() }] };
        return { ok: true, result: { status: "executed", wentAfterAll: true } };
      }
      return undefined;
    });
    const toast = () => t.dom.document.body.querySelector(".toast")?.textContent ?? "";
    const back = async () => {
      t.dom.document.visibilityState = "visible";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
    };
    t.open = { ...t.open, txs: [record] };
    await t.render({ forceRefresh: true });
    await flush();
    expect(t.app.textContent).not.toContain("Not sent yet");
    await back();
    expect(t.asked("DUSK_UI_RECHECK_TX").map((m) => m.hash)).toEqual([HASH]);
    expect(toast()).not.toContain("after all");
    arrived = true;
    await back();
    expect(t.asked("DUSK_UI_RECHECK_TX").map((m) => m.hash)).toEqual([HASH, HASH]);
    await vi.waitFor(() => expect(toast()).toContain("A payment you chose not to send went out after all."));
  });

  it("looks the payment up by its ID, and says Completed with its real fee, though nothing was heard while away", async () => {
    const HASH = "9f".repeat(32);
    const t = await popupOn(
      "sent",
      { addressBook: { loaded: true, items: [] }, sent: { phase: "sent", status: "submitted", hash: HASH, title: "Send", amountLux: "30000000", feeCapLux: "2500000", sentAt: Date.now(), startedAt: Date.now() } },
      async (message, t) => {
        // The node has it in a block: the wallet writes that on its record and says so.
        if (message.type === "DUSK_UI_RECHECK_TX" && message.hash === HASH) {
          t.open = { ...t.open, txs: [{ hash: HASH, status: "executed", submittedAt: Date.now() - 40_000, feePaid: "2135802", blockHeight: "4802949" }] };
          t.deliver({ type: "DUSK_UI_TX_STATUS", hash: HASH, status: "executed", ok: true });
          return { ok: true };
        }
        return undefined;
      }
    );
    t.open = { ...t.open, txs: [{ hash: HASH, status: "submitted", submittedAt: Date.now() - 40_000 }] };
    await t.render({ forceRefresh: true });
    expect(t.app.textContent).toContain("Waiting for a block");
    expect(t.asked("DUSK_UI_RECHECK_TX")).toEqual([]);

    // Home pressed, then back after the block: the page shows again.
    t.dom.document.visibilityState = "visible";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    await flush();
    expect(t.asked("DUSK_UI_RECHECK_TX").map((m) => m.hash)).toEqual([HASH]);
    expect(t.app.textContent).toContain("In block 4,802,949");
    expect(t.app.textContent).toContain("0.002135802");
    expect(t.app.textContent).not.toContain("Waiting for a block");
  });
});

// Tauri's bridge to the app's wrapper: what each command answers, and the
// events the wrapper sends (`emit`).
function tauriBridge(answers = {}) {
  const handlers = [];
  const invoke = vi.fn(async (cmd, args) => {
    if (cmd === "plugin:event|listen") return handlers.push(args.handler) - 1;
    return typeof answers[cmd] === "function" ? answers[cmd](args) : (answers[cmd] ?? null);
  });
  return { invoke, transformCallback: (fn) => (handlers.push(fn), handlers.length - 1), emit: (payload) => handlers.forEach((fn) => typeof fn === "function" && fn({ payload })) };
}

describe("the app on a phone", () => {
  const LINK = `dusk:public-${B}@dusk:2?amount=0.01&memo=Deep+link+test`;

  // Astra's: Android ended the app with a Send a link filled in open. Back, it opened on that Send, and
  // left with Back, the link's payment came back in the next Send begun by hand, as one typed would.
  it("opens on a link's Send again after Android ended the app, and keeps none of it for the next Send", async () => {
    const kept = new Map();
    vi.stubGlobal("localStorage", { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) });
    const field = (t, name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    const values = (t) => ["To", "Amount", "Memo"].map((name) => field(t, name)?.value);
    const filled = { to: B, amountDusk: "0.01", memo: "Deep link test", requestChainId: "dusk:2", filledFrom: "link", filledIn: true };
    const open = await popupOn("send", { addressBook: { loaded: true, items: [] }, draft: filled }, undefined, { tauri: tauriBridge() });
    open.dom.document.visibilityState = "hidden";
    open.dom.document.dispatchEvent(fakeEvent("visibilitychange"));

    // Android ends the app; opened again, it's on that Send, as the link filled it in.
    const back = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, undefined, { tauri: tauriBridge() });
    expect(back.state.route).toBe("send");
    expect(values(back)).toEqual([B, "0.01", "Deep link test"]);
    expect(back.app.querySelector(".send-filled-note")?.textContent).toContain("Filled in from the link");

    // Left with Back, once Leave is pressed: the next Send, begun by hand on Home, is empty.
    back.app.querySelectorAll("button").find((b) => b.textContent === "← Back").click();
    await flush();
    [...back.dom.document.querySelectorAll("[role=alertdialog] button")].find((b) => b.textContent === "Leave").click();
    await flush();
    expect(back.state.route).toBe("home");
    back.app.querySelectorAll("button.action-btn").find((b) => b.textContent.trim() === "Send").click();
    await flush();
    expect(back.state.route).toBe("send");
    expect(values(back)).toEqual(["", "", ""]);
  });

  // Lena's: Send half typed, Home, and Android ended the app in the background: back,
  // it opened on Home with Send empty, 3 times out of 3.
  it("opens on Send again with what was typed, once unlocked, after Android ended it in the background", async () => {
    const kept = new Map();
    vi.stubGlobal("localStorage", { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) });
    const field = (t, name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    const values = (t) => ["To", "Amount", "Memo"].map((name) => field(t, name)?.value);
    const typed = await popupOn("send", { addressBook: { loaded: true, items: [] }, draft: null }, undefined, { tauri: tauriBridge() });
    for (const [name, value] of [["To", B], ["Amount", "0,02"], ["Memo", "satay"]]) {
      field(typed, name).value = value;
      field(typed, name).dispatchEvent(fakeEvent("input"));
    }
    typed.dom.document.visibilityState = "hidden";
    typed.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    expect(JSON.stringify([...kept.values()])).not.toMatch(/password/i);

    // Android ends the app; opened again, it's a new page, on Home.
    const back = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, undefined, { tauri: tauriBridge() });
    expect(back.state.route).toBe("send");
    expect(values(back)).toEqual([B, "0,02", "satay"]);

    // Left with Back, it's kept for Send, but the app opens on Home after that.
    back.app.querySelectorAll("button").find((b) => b.textContent === "← Back").click();
    await flush();
    const later = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, undefined, { tauri: tauriBridge() });
    expect(later.state.route).toBe("home");
  });

  // Chen's: a tap on "Your payment arrived" showed a red "Can't reach the network", then "Not
  // confirmed" and "Up to 0.0025", then Completed: the notice knew it had arrived, and its block.
  it("opens a notice's payment as the notice knew it, and says the network is being checked while it reconnects", async () => {
    const HASH = "9b".repeat(32);
    const TOKEN = "c4".repeat(16);
    const record = { hash: HASH, kind: "transfer", privacy: "public", to: B, amount: "10000000", status: "unknown", submittedAt: Date.now() - 60_000, profileIndex: 0, nodeUrl: "https://testnet.nodes.dusk.network" };
    let opened = { hash: "" };
    const bridge = tauriBridge({ notices: (args) => (args?.action === "opened" ? { allowed: true, ...opened } : { allowed: true }) });
    const answer = async (message, t) => {
      // The wallet takes a tap as its notice's only with the token it gave that send's notice.
      if (message.type === "DUSK_UI_TX_NOTICED") {
        if (message.hash !== HASH || message.token !== TOKEN) return { ok: true, result: null };
        t.open = { ...t.open, txs: [{ ...record, status: message.status, blockHeight: message.blockHeight }] };
        return { ok: true, result: { patched: true } };
      }
      // The node doesn't answer yet as the app comes back: Android cut its network while away.
      if (message.type === "DUSK_UI_CHECK_NODE" || message.type === "DUSK_UI_RECHECK_TX") return new Promise(() => {});
      return undefined;
    };
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, answer, { tauri: bridge });
    const make = (tag, props = {}) => Object.assign(t.dom.document.createElement(tag), props);
    const pill = make("button", { id: "network-pill" });
    pill.appendChild(make("span", { className: "network-pill__label" }));
    t.dom.document.body.prepend(pill);
    // What was read while the app was away: the node offline, the send not heard of.
    t.open = { ...t.open, txs: [record], networkStatus: { nodeStatus: "offline", nodeUrl: t.open.nodeUrl } };
    const comeBack = async () => {
      t.dom.document.visibilityState = "hidden";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      t.dom.document.visibilityState = "visible";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
    };

    // Astra's: any app can open the wallet as a tap would, with a send's ID it learned and an outcome of
    // its own. Without the notice's token, or with another, it opens nothing and says nothing of the send.
    for (const forged of [{ hash: HASH, outcome: "failed", block: 1 }, { hash: HASH, outcome: "failed", block: 1, token: "d5".repeat(16) }]) {
      opened = forged;
      await comeBack();
      await flush();
      expect(t.state.route).toBe("home");
    }
    expect(t.asked("DUSK_UI_TX_NOTICED")).toEqual([expect.objectContaining({ hash: HASH, token: "d5".repeat(16) })]);

    opened = { hash: HASH, outcome: "executed", block: 4831109, token: TOKEN };
    await comeBack();
    await vi.waitFor(() => expect(t.state.route).toBe("tx"));
    await flush();
    expect(t.asked("DUSK_UI_TX_NOTICED").at(-1)).toEqual(expect.objectContaining({ hash: HASH, token: TOKEN, status: "executed", blockHeight: "4831109" }));
    expect(t.app.textContent).not.toContain("Not confirmed");
    expect(t.app.textContent).not.toContain("stopped waiting");
    expect(t.dom.document.querySelector(".network-word")?.textContent ?? "").not.toContain("Can't reach the network");
    opened = { hash: "" };
  });

  // Sofía's: "Your payment arrived" tapped after Android had ended the app: the unlock, then Home with a toast
  // "0.01 DUSK to Lena completed · View" gone in seconds, not the payment, though "You received" opened its own.
  it("opens a send's notice tapped as the app starts on its payment, once unlocked", async () => {
    const HASH = "9e".repeat(32);
    const TOKEN = "c6".repeat(16);
    const record = { hash: HASH, kind: "transfer", privacy: "public", to: B, amount: "10000000", status: "executed", blockHeight: "4854200", submittedAt: Date.now() - 90_000, profileIndex: 0, nodeUrl: "https://testnet.nodes.dusk.network" };
    let tap = { hash: HASH, outcome: "executed", block: 4854200, token: TOKEN, ours: true };
    const bridge = tauriBridge({
      notices: (args) => {
        if (args?.action !== "opened") return { allowed: true };
        const out = { allowed: true, ...tap };
        tap = { hash: "" };
        return out;
      },
    });
    // A new process: locked, and its first read of the wallet slower than Android's answer.
    let locked = true;
    let firstRead;
    const read = new Promise((resolve) => (firstRead = resolve));
    const answer = async (message, t) => {
      if (message.type === "DUSK_UI_TX_NOTICED") return message.hash === HASH && message.token === TOKEN ? { ok: true, result: { patched: false } } : { ok: true, result: null };
      if (message.type === "DUSK_UI_OVERVIEW") {
        await read;
        return locked ? { ...t.open, isUnlocked: false, accounts: [], addresses: [], txs: [] } : { ...t.open, txs: [record] };
      }
      return undefined;
    };
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, answer, { tauri: bridge, mount: true });
    await vi.waitFor(() => expect(t.asked("DUSK_UI_TX_NOTICED")).toHaveLength(1));
    await flush();
    firstRead();
    await flush();
    // The unlock first, the payment the screen after it.
    expect(t.state.route).toBe("tx");
    expect(t.app.querySelector("input[type=password]")).toBeTruthy();
    locked = false;
    await t.render({ forceRefresh: true });
    await flush();
    expect([t.state.route, t.state.txDetailHash]).toEqual(["tx", HASH]);
    expect(t.app.querySelector(".tx-hero-amount")?.textContent).toContain("0.01");
  });

  // Issue #214: a notice of money that came in, tapped after the app locked itself, was dropped: the page
  // still showed it open, the wallet answered locked, and the unlock opened Home.
  it("keeps a tap on money that came in for the unlock where the wallet turns out locked", async () => {
    const HASH = "9f".repeat(32);
    const TOKEN = "c7".repeat(16);
    let tap = { hash: "" };
    const bridge = tauriBridge({
      notices: (args) => {
        if (args?.action !== "opened") return { allowed: true };
        const out = { allowed: true, ...tap };
        tap = { hash: "" };
        return out;
      },
    });
    let locked = false;
    const answer = async (message, t) => {
      if (message.type === "DUSK_UI_TX_NOTICED") return locked ? { error: { code: 4100, message: "Wallet locked" } } : { ok: true, result: { incoming: true, profileIndex: 0 } };
      if (message.type === "DUSK_UI_OVERVIEW" && locked) return { ...t.open, isUnlocked: false, accounts: [], addresses: [] };
      return undefined;
    };
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, answer, { tauri: bridge });
    // Locked by itself meanwhile: what the page read still says open.
    locked = true;
    tap = { hash: HASH, outcome: "executed", block: 4854300, token: TOKEN, account: A, ours: true };
    t.dom.document.visibilityState = "hidden";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    t.dom.document.visibilityState = "visible";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    await vi.waitFor(() => expect(t.app.querySelector("input[type=password]")).toBeTruthy());
    locked = false;
    await t.render({ forceRefresh: true });
    await vi.waitFor(() => expect([t.state.route, t.state.txDetailHash]).toEqual(["tx", HASH]));
  });

  // Chen's: a tap on "Your payment arrived" put a red "Can't reach the network" under the network for a second or
  // two, Wi-Fi on, as the app's network came back; drawn too while the app was away, the first thing seen back.
  it("never says it can't reach the network as a tap brings the app back, nor while it's away", async () => {
    const HASH = "a1".repeat(32);
    const TOKEN = "c8".repeat(16);
    const record = { hash: HASH, kind: "transfer", privacy: "public", to: B, amount: "10000000", status: "submitted", submittedAt: Date.now() - 30_000, profileIndex: 0, nodeUrl: "https://testnet.nodes.dusk.network" };
    let tap = { hash: "" };
    const bridge = tauriBridge({
      notices: (args) => {
        if (args?.action !== "opened") return { allowed: true };
        const out = { allowed: true, ...tap };
        tap = { hash: "" };
        return out;
      },
    });
    const answer = async (message) => {
      if (message.type === "DUSK_UI_TX_NOTICED") return { ok: true, result: { patched: true } };
      // The node doesn't answer yet: Android cut the page's network while away.
      if (message.type === "DUSK_UI_CHECK_NODE" || message.type === "DUSK_UI_RECHECK_TX") return new Promise(() => {});
      return undefined;
    };
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, answer, { tauri: bridge });
    const make = (tag, props = {}) => Object.assign(t.dom.document.createElement(tag), props);
    const pill = make("button", { id: "network-pill" });
    pill.appendChild(make("span", { className: "network-pill__label" }));
    // What the network's line says, each time it's said.
    const said = [];
    const word = make("p", { className: "network-word" });
    Object.defineProperty(word, "textContent", { get: () => said.at(-1) ?? "", set: (text) => said.push(text) });
    t.dom.document.body.prepend(pill, word);
    t.open = { ...t.open, txs: [record] };
    await t.render({ forceRefresh: true });
    t.dom.document.visibilityState = "hidden";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    // Away: a check of the network fails, as Android cut it, and the wallet is drawn again.
    t.open = { ...t.open, networkStatus: { nodeStatus: "offline", nodeUrl: t.open.nodeUrl } };
    t.deliver({ type: "DUSK_UI_NETWORK_CHANGED" });
    await flush();
    // Tapped: back, on the payment.
    tap = { hash: HASH, outcome: "executed", block: 4854400, token: TOKEN, ours: true };
    t.dom.document.visibilityState = "visible";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    await vi.waitFor(() => expect(t.state.route).toBe("tx"));
    await flush();
    expect(said.filter((text) => text === "Can't reach the network")).toEqual([]);
  });

  // Sofía's and Chen's: tapped from the Sent screen left with Home, "Your payment arrived" showed "Taking longer than
  // usual" and a red "Can't reach the network" for 1 to 5 s before Completed, as the app's network came back.
  it("opens a notice's payment from the Sent screen at once, as the notice knew it, though reads wait on the network coming back", async () => {
    const HASH = "9d".repeat(32);
    const TOKEN = "c5".repeat(16);
    let opened = { hash: "" };
    // Back from away, the network isn't back yet: reads fail at once, or wait on it.
    let away = "";
    const bridge = tauriBridge({ notices: (args) => (args?.action === "opened" ? { allowed: true, ...opened } : { allowed: true }) });
    const record = { hash: HASH, kind: "transfer", privacy: "public", to: B, amount: "10000000", status: "submitted", submittedAt: Date.now() - 30_000, profileIndex: 0, nodeUrl: "https://testnet.nodes.dusk.network" };
    const answer = async (message, t) => {
      if (message.type === "DUSK_UI_TX_NOTICED") {
        if (message.hash !== HASH || message.token !== TOKEN) return { ok: true, result: null };
        // Written on its record, and the page told, as the app's wallet does it.
        t.deliver({ type: "DUSK_UI_TX_STATUS", hash: HASH, status: "executed", ok: true, blockHeight: "4846300" });
        return { ok: true, result: { patched: true } };
      }
      if (away === "waits" && message.type === "DUSK_UI_OVERVIEW") return new Promise(() => {});
      if (away === "fails" && message.type === "DUSK_UI_OVERVIEW") return { ...t.open, balance: null, balanceError: "Failed to fetch", networkStatus: { nodeStatus: "offline", nodeUrl: t.open.nodeUrl } };
      if (away && message.type === "DUSK_UI_CHECK_NODE") return { ok: true, networkStatus: { nodeStatus: "offline", nodeUrl: t.open.nodeUrl } };
      if (message.type === "DUSK_UI_RECHECK_TX") {
        // Not found by a node it couldn't ask: its record says unknown, and the page is told so,
        // at once, or once the lookup gives up, after the notice's payment is open.
        const giveUp = () => {
          t.deliver({ type: "DUSK_UI_TX_STATUS", hash: message.hash, status: "unknown" });
          return { ok: true, result: { status: "unknown", error: "reconciliation_unavailable" } };
        };
        return holdLookups ? new Promise((resolve) => heldLookups.push(() => resolve(giveUp()))) : giveUp();
      }
      return undefined;
    };
    let holdLookups = false;
    const heldLookups = [];
    const sent = () => ({ phase: "sent", status: "submitted", hash: HASH, title: "Send", amountLux: "10000000", feeCapLux: "2500000", sentAt: Date.now() - 30_000, startedAt: Date.now() - 31_000 });
    const t = await popupOn("sent", { addressBook: { loaded: true, items: [] }, sent: sent() }, answer, { tauri: bridge });
    t.open = { ...t.open, txs: [record] };
    await t.render({ forceRefresh: true });
    const shown = [];
    // What the screen and its toast say, each moment.
    const said = () => `${t.app.textContent} ${t.dom.document.body.querySelector(".toast")?.textContent ?? ""}`;
    const leaveAndComeBack = async (how) => {
      t.dom.document.visibilityState = "hidden";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      away = how;
      t.dom.document.visibilityState = "visible";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      shown.push(said());
      for (let i = 0; i < 6; i++) {
        await flush();
        shown.push(said());
      }
    };

    // Back without a notice, the node not answered yet: being looked up, never taking long.
    await leaveAndComeBack("fails");
    expect(t.state.route).toBe("sent");
    expect(t.app.textContent).toContain("Looking it up again");
    for (const text of shown) expect(text).not.toMatch(/Taking longer than usual|Can't reach the network|Not confirmed/);

    // Back from the notice's tap: the payment as the notice knew it, at once, though the read waits.
    away = "";
    await t.render({ forceRefresh: true });
    shown.length = 0;
    opened = { hash: HASH, outcome: "executed", block: 4846300, token: TOKEN };
    holdLookups = true;
    await leaveAndComeBack("waits");
    // The payment's own page, drawn, not the Sent screen behind it.
    await vi.waitFor(() => expect(t.app.querySelector(".subnav-title")?.textContent).toBe("Transaction"));
    expect(t.app.textContent).toContain("Completed");
    // Nor a toast that it's still pending, from a lookup that couldn't ask the node (seen on the phone).
    for (const giveUp of heldLookups.splice(0)) giveUp();
    for (let i = 0; i < 6; i++) {
      await flush();
      shown.push(said());
    }
    for (const text of shown) expect(text).not.toMatch(/Taking longer than usual|Can't reach the network|Not confirmed|still pending/);
    expect(t.app.textContent).toContain("Completed");
    opened = { hash: "" };
  });

  // Chen's: a payment confirmed as the signal dropped went out only once he opened the app again, and nothing said
  // so while he was away. Android's notice of it (android/ArrivalJob.kt's Waiting) opens the wallet on that payment:
  // its Sent where that's the screen left, else Home, which lists it; only a tap with the notice's token does.
  it("opens a notice of a payment waiting on that payment, its Sent or Home, and only from the notice", async () => {
    let opened = { hash: "" };
    const bridge = tauriBridge({ notices: (args) => (args?.action === "opened" ? { allowed: true, ...opened } : { allowed: true }) });
    const comeBack = async (t) => {
      t.dom.document.visibilityState = "hidden";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      t.dom.document.visibilityState = "visible";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
    };
    const t = await popupOn("options", { addressBook: { loaded: true, items: [] } }, undefined, { tauri: bridge });
    // Android didn't know the tap's token as its notice's: nothing opens.
    opened = { hash: "", waiting: false };
    await comeBack(t);
    expect(t.state.route).toBe("options");
    opened = { hash: "", waiting: true };
    await comeBack(t);
    await vi.waitFor(() => expect(t.state.route).toBe("home"));

    // Left on that payment's Sent, still waiting for the network: there it stays.
    opened = { hash: "" };
    const waiting = { phase: "sending", sendId: "send-0001", waits: true, title: "Send", amountLux: "10000000", startedAt: Date.now() - 5_000 };
    const s = await popupOn("sent", { addressBook: { loaded: true, items: [] }, sent: waiting }, undefined, { tauri: bridge });
    opened = { hash: "", waiting: true };
    await comeBack(s);
    expect([s.state.route, s.state.sent?.sendId]).toEqual(["sent", "send-0001"]);
    opened = { hash: "" };
  });

  // Sofía's: no notice when a client paid her. Android's job tells money that came in (android/ArrivalJob.kt); its
  // tap opens that payment, in the profile it came to, once the wallet is open, and only with the wallet's token.
  it("opens a notice of money that came in on its payment, in the profile it came to, after the unlock where it's locked", async () => {
    const HASH = "9e".repeat(32);
    const TOKEN = "c6".repeat(16);
    const TO = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
    let opened = { hash: "" };
    const bridge = tauriBridge({ notices: (args) => (args?.action === "opened" ? { allowed: true, ...opened } : { allowed: true }) });
    const answer = async (message, t) => {
      if (message.type === "DUSK_UI_TX_NOTICED") {
        // The wallet's token for those notices, to one of its profiles, while it's open.
        const ok = t.open.isUnlocked && message.hash === HASH && message.token === TOKEN && message.account === TO;
        return { ok: true, result: ok ? { incoming: true, profileIndex: 1 } : null };
      }
      if (message.type === "DUSK_UI_SET_ACCOUNT_INDEX") {
        t.open = { ...t.open, selectedAccountIndex: message.index };
        return { ok: true };
      }
      return undefined;
    };
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, answer, { tauri: bridge });
    const comeBack = async () => {
      t.dom.document.visibilityState = "hidden";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      t.dom.document.visibilityState = "visible";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
    };

    // Another app's forged tap, without the wallet's token: nothing opens.
    opened = { hash: HASH, outcome: "executed", block: 4851300, token: "d5".repeat(16), account: TO };
    await comeBack();
    await flush();
    expect([t.state.route, t.asked("DUSK_UI_SET_ACCOUNT_INDEX")]).toEqual(["home", []]);

    // Locked as the app was left: opened once it's unlocked, in Profile 2, where it came.
    t.open = { ...t.open, isUnlocked: false };
    await t.render({ forceRefresh: true });
    opened = { hash: HASH, outcome: "executed", block: 4851300, token: TOKEN, account: TO };
    await comeBack();
    await flush();
    expect(t.state.route).not.toBe("tx");
    t.open = { ...t.open, isUnlocked: true };
    await t.render({ forceRefresh: true });
    await vi.waitFor(() => expect(t.state.route).toBe("tx"));
    expect(t.asked("DUSK_UI_SET_ACCOUNT_INDEX")).toEqual([expect.objectContaining({ index: 1 })]);
    expect(t.state.txDetailHash).toBe(HASH);
    // Its row comes with the history read for it: till then, it's looked for, never "isn't in your activity".
    expect(t.app.textContent).toContain("Looking for this transaction");
    opened = { hash: "" };
  });

  // Chen's, again: the tap showed the Sent screen left, "Looking it up again…", for 2 to 6 s on the phone, while the
  // wallet wrote the notice's news on the send's record. Android knows its own notice's token: opened at once.
  it("opens the app's own notice at once, as the notice knew it, before the send's record is written", async () => {
    const HASH = "9f".repeat(32);
    const TOKEN = "c7".repeat(16);
    let opened = { hash: "" };
    const bridge = tauriBridge({ notices: (args) => (args?.action === "opened" ? { allowed: true, ...opened } : { allowed: true }) });
    const record = { hash: HASH, kind: "transfer", privacy: "public", to: B, amount: "10000000", status: "submitted", submittedAt: Date.now() - 30_000, profileIndex: 0, nodeUrl: "https://testnet.nodes.dusk.network" };
    // The wallet's word on the tap waits, as it did on the phone just back.
    const noticed = [];
    const answer = async (message) => {
      if (message.type === "DUSK_UI_TX_NOTICED") return new Promise((resolve) => noticed.push(resolve));
      if (message.type === "DUSK_UI_RECHECK_TX" || message.type === "DUSK_UI_CHECK_NODE") return new Promise(() => {});
      return undefined;
    };
    const sent = { phase: "sent", status: "submitted", hash: HASH, title: "Send", amountLux: "10000000", feeCapLux: "2500000", sentAt: Date.now() - 30_000, startedAt: Date.now() - 31_000 };
    const t = await popupOn("sent", { addressBook: { loaded: true, items: [] }, sent }, answer, { tauri: bridge });
    t.open = { ...t.open, txs: [record] };
    await t.render({ forceRefresh: true });
    const leaveAndComeBack = async () => {
      t.dom.document.visibilityState = "hidden";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      t.dom.document.visibilityState = "visible";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
    };

    // A tap Android doesn't know as its notice's: nothing opens before the wallet says so.
    opened = { hash: HASH, outcome: "executed", block: 4851400, token: TOKEN, ours: false };
    await leaveAndComeBack();
    await flush();
    expect(t.state.route).toBe("sent");
    noticed.splice(0).forEach((resolve) => resolve({ ok: true, result: null }));
    await flush();
    expect(t.state.route).toBe("sent");

    // Its own: the payment's page, Completed, while the wallet's word still waits.
    opened = { hash: HASH, outcome: "executed", block: 4851400, token: TOKEN, ours: true };
    await leaveAndComeBack();
    await vi.waitFor(() => expect(t.app.querySelector(".subnav-title")?.textContent).toBe("Transaction"));
    expect(noticed).toHaveLength(1);
    expect(t.app.textContent).toContain("Completed");
    expect(t.app.textContent).not.toContain("Looking it up again");
    noticed.splice(0).forEach((resolve) => resolve({ ok: true, result: { patched: true } }));
    await flush();
    expect(t.state.route).toBe("tx");
    opened = { hash: "" };
  });

  it("opens on Home after it was ended with Send open but sent, or for another profile", async () => {
    const kept = new Map();
    vi.stubGlobal("localStorage", { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) });
    const typed = await popupOn("send", { addressBook: { loaded: true, items: [] }, draft: { to: B, amountDusk: "0.02", memo: "satay" } }, undefined, { tauri: tauriBridge() });
    typed.dom.document.visibilityState = "hidden";
    typed.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    // Opened on another profile: not its Send.
    const profileTwo = async (message, t) => (message.type === "DUSK_UI_OVERVIEW" ? { ...t.open, selectedAccountIndex: 1 } : undefined);
    const other = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, profileTwo, { tauri: tauriBridge() });
    expect(other.state.route).toBe("home");

    // Sent from the Send it opened on: nothing is kept for the next start.
    const t = await popupOn("send", { addressBook: { loaded: true, items: [] }, draft: { to: B, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" } }, undefined, { tauri: tauriBridge() });
    t.state.route = "confirm";
    await t.render();
    await flush();
    t.dom.document.visibilityState = "hidden";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    t.dom.document.visibilityState = "visible";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    await flush();
    pastClickGuard();
    t.app.querySelectorAll("button").find((b) => b.textContent === "Confirm").click();
    await flush();
    expect(t.asked("DUSK_UI_SEND_TX")).toHaveLength(1);
    const after = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, undefined, { tauri: tauriBridge() });
    expect(after.state.route).toBe("home");
  });

  // Chen's wish: lock when I leave the app, as phone wallets' Auto-lock: Immediately.
  it("locks as the person leaves it with Auto-lock: Immediately, not for the share sheet, and not otherwise", async () => {
    const bridge = tauriBridge();
    // The wallet locks when asked, and says so.
    const locks = async (message, t) => {
      if (message.type !== "DUSK_UI_LOCK") return undefined;
      t.open = { ...t.open, isUnlocked: false };
      t.deliver({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false });
      return { ok: true };
    };
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, locks, { tauri: bridge });
    const hide = async () => {
      t.dom.document.visibilityState = "hidden";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
    };
    const show = async () => {
      t.dom.document.visibilityState = "visible";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
    };
    // Off, as it starts: nothing locks.
    await hide();
    expect(t.asked("DUSK_UI_LOCK")).toEqual([]);
    await show();

    // Immediately, in Settings: Auto-lock's first choice in the app.
    t.state.route = "options";
    await t.render({ forceRefresh: true });
    const autoLock = () => t.app.querySelector("#auto-lock");
    expect(autoLock().querySelectorAll("option").map((o) => o.textContent)).toEqual(["Immediately", "5 minutes", "15 minutes", "Off"]);
    autoLock().value = "leave";
    autoLock().dispatchEvent(fakeEvent("change"));
    await flush();
    expect(t.asked("DUSK_UI_SET_LOCK_ON_LEAVE").at(-1)).toMatchObject({ lockOnLeave: true });
    t.open = { ...t.open, lockOnLeave: true };
    await t.render({ forceRefresh: true });
    expect(autoLock().value).toBe("leave");
    expect(t.app.textContent).toContain("Locks the wallet as you leave the app.");

    // The wallet's own share sheet is no leaving.
    const { shareText } = await import("../../platform/native.js");
    await shareText("an address");
    await hide();
    expect(t.asked("DUSK_UI_LOCK")).toEqual([]);
    await show();
    // Leaving is: back, the password is asked, not the locked Settings.
    await hide();
    expect(t.asked("DUSK_UI_LOCK")).toHaveLength(1);
    await show();
    expect(t.app.querySelector("input[type=password]")?.getAttribute("placeholder")).toBe("Password");
    expect(t.app.textContent).not.toContain("Locks the wallet as you leave the app.");
  });

  // Chen's and Sofía's: Immediately locked the app on a trip to Files or a call, and the unlock
  // landed on the dashboard, Send's half-typed payment and Receive's request gone.
  it("returns after Immediately's lock to the screen left, with what was typed on it", async () => {
    const bridge = tauriBridge();
    const locks = async (message, t) => {
      if (message.type === "DUSK_UI_LOCK") {
        t.open = { ...t.open, isUnlocked: false };
        t.deliver({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false });
        return { ok: true };
      }
      if (message.type === "DUSK_UI_UNLOCK") {
        t.open = { ...t.open, isUnlocked: true };
        return { ok: true };
      }
      return undefined;
    };
    const t = await popupOn("send", { addressBook: { loaded: true, items: [] }, draft: null }, locks, { tauri: bridge });
    t.open = { ...t.open, lockOnLeave: true };
    await t.render({ forceRefresh: true });
    const away = async () => {
      t.dom.document.visibilityState = "hidden";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
      t.dom.document.visibilityState = "visible";
      t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      await flush();
    };
    const unlock = async () => {
      const pwd = t.app.querySelector("#unlock-password");
      expect(pwd).toBeTruthy();
      pwd.value = "the password";
      t.app.querySelectorAll("button").find((b) => b.textContent === "Unlock").click();
      await flush();
    };
    const field = (name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    const type = (name, value) => {
      field(name).value = value;
      field(name).dispatchEvent(fakeEvent("input"));
    };

    // Send, half typed: To, an amount and a memo.
    type("To", B);
    type("Amount", "0.02");
    type("Memo", "Invoice 2026-120");
    await away();
    expect(t.asked("DUSK_UI_LOCK")).toHaveLength(1);
    await unlock();
    expect(t.state.route).toBe("send");
    expect(["To", "Amount", "Memo"].map((name) => field(name).value)).toEqual([B, "0.02", "Invoice 2026-120"]);

    // Receive, a request filled in, then Files to find its picture.
    t.state.route = "receive";
    t.state.receive = { tab: "public", requestOpen: true, amountDusk: "0.05", memo: "Chicken rice Tue" };
    await t.render();
    await away();
    expect(t.asked("DUSK_UI_LOCK")).toHaveLength(2);
    await unlock();
    expect(t.state.route).toBe("receive");
    const request = t.app.querySelector(".receive-request");
    expect(["Amount", "Memo"].map((name) => request.querySelectorAll("input").find((f) => accessibleName(f) === name).value)).toEqual(["0.05", "Chicken rice Tue"]);
  });

  // Astra's: with Immediately on, a Send a link filled in came back empty from the lock: its password
  // was asked on Home, and what the link filled in went as if its Send had been left.
  it("returns after Immediately's lock to a Send a link filled in, with what the link filled in", async () => {
    const locks = async (message, t) => {
      if (message.type === "DUSK_UI_LOCK") {
        t.open = { ...t.open, isUnlocked: false };
        t.deliver({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false });
        return { ok: true };
      }
      if (message.type === "DUSK_UI_UNLOCK") {
        t.open = { ...t.open, isUnlocked: true };
        return { ok: true };
      }
      return undefined;
    };
    const filled = { to: B, amountDusk: "0.01", memo: "Deep link test", requestChainId: "dusk:2", filledFrom: "link", filledIn: true };
    const t = await popupOn("send", { addressBook: { loaded: true, items: [] }, draft: filled }, locks, { tauri: tauriBridge() });
    t.open = { ...t.open, lockOnLeave: true };
    await t.render({ forceRefresh: true });
    const field = (name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    expect(["To", "Amount", "Memo"].map((name) => field(name).value)).toEqual([B, "0.01", "Deep link test"]);

    t.dom.document.visibilityState = "hidden";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    await flush();
    t.dom.document.visibilityState = "visible";
    t.dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    await flush();
    expect(t.asked("DUSK_UI_LOCK")).toHaveLength(1);
    t.app.querySelector("#unlock-password").value = "the password";
    t.app.querySelectorAll("button").find((b) => b.textContent === "Unlock").click();
    await flush();
    expect(t.state.route).toBe("send");
    expect(["To", "Amount", "Memo"].map((name) => field(name).value)).toEqual([B, "0.01", "Deep link test"]);
    expect(t.app.querySelector(".send-filled-note")?.textContent).toContain("Filled in from the link");
  });

  it("opens Send filled in from a dusk: link it was opened with, and from one opened while it runs", async () => {
    const bridge = tauriBridge({ "plugin:deep-link|get_current": [LINK] });
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, undefined, { tauri: bridge });
    await flush();
    const fields = () => t.app.querySelectorAll("input, textarea").map((f) => f.value);
    expect(t.state.route).toBe("send");
    expect(t.app.querySelector(".to-input-wrap textarea").value).toBe(B);
    expect(fields()).toContain("Deep link test");
    expect(fields()).toContain("0.01");

    // Another, from a chat, as the app runs: Send again, with that one's.
    t.state.route = "home";
    await t.render();
    bridge.emit([LINK.replace("0.01", "0.02").replace("Deep+link+test", "Second")]);
    await flush();
    expect([t.state.route, fields().includes("0.02"), fields().includes("Second")]).toEqual(["send", true, true]);

    // Lena's: one as the app comes back on Activity, while the wallet still
    // reads the node, which a phone just woken can take a minute to answer.
    t.state.route = "activity";
    await t.render();
    const answer = t.send.getMockImplementation();
    const node = Promise.withResolvers();
    t.send.mockImplementation(async (message) => (message.type === "DUSK_UI_OVERVIEW" ? (await node.promise, t.open) : answer(message)));
    bridge.emit([LINK.replace("0.01", "0.03").replace("Deep+link+test", "Third")]);
    await flush();
    expect([t.app.querySelector(".subnav-title")?.textContent, fields().includes("0.03"), fields().includes("Third")]).toEqual(["Send", true, true]);
    node.resolve();
    await flush();
    expect([t.app.querySelector(".subnav-title")?.textContent, fields().includes("0.03"), fields().includes("Third")]).toEqual(["Send", true, true]);

    // Lena's plain shape, dusk:<account>?amount=&memo=, read as the web wallet reads it.
    t.send.mockImplementation(answer);
    bridge.emit([`dusk:${B}?amount=0.04&memo=Plain`]);
    await flush();
    expect([t.app.querySelector(".to-input-wrap textarea").value, fields().includes("0.04"), fields().includes("Plain")]).toEqual([B, true, true]);
  });
});

// Amélie's: a request link opened the app, which had no wallet, on "Set up your Dusk Wallet", on Mainnet: for a second
// she thought her wallet and money were gone.
describe("a payment link that opens the app before there's a wallet in it", () => {
  const WEB = `https://apps.testnet.dusk.network/wallet/dashboard/send?to=${B}&amount=0.001&memo=Les+tulipes&network=testnet`;
  const fresh = { hasVault: false, isUnlocked: false, accounts: [], wallets: [], walletKey: null, networkName: "Mainnet", nodeUrl: "https://nodes.dusk.network" };
  const opened = async (link, answers = {}) => {
    const bridge = tauriBridge({ "plugin:deep-link|get_current": [link], ...answers });
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, async (message) => (message.type === "DUSK_UI_OVERVIEW" ? fresh : undefined), { tauri: bridge });
    await t.render({ forceRefresh: true });
    await flush();
    return { t, bridge };
  };
  const waiting = (t) => {
    const note = t.app.querySelector(".onboard-link");
    return note ? visibleText(note) : "";
  };

  afterEach(() => vi.useRealTimers());

  it("says on the setup screen that a payment link waits, for which network and since when, to set up or import a wallet to pay it, or open it in the browser", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 17, 7, 2));
    const { t } = await opened(WEB, { open_in_browser: true });
    expect(t.state.route).toBe("onboard_welcome");
    // Chen's: it didn't say Testnet; Sofía's: nor when it was opened.
    expect(waiting(t)).toBe("A payment link is waitingFor Testnet, opened at 07:02. Set up or import a wallet to pay it.Open in browser instead");
    expect(t.state.draft).toMatchObject({ to: B, memo: "Les tulipes", linkSetup: true });
    // Open in browser instead: handed to the phone's browser, never to the app, which Android gives these links to.
    t.app.querySelectorAll("button").find((b) => b.textContent === "Open in browser instead").click();
    await flush();
    expect(t.dom.window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith("open_in_browser", { url: WEB }, undefined);
    expect([waiting(t), t.state.draft]).toEqual(["", null]);
  });

  // Sofía's: another's link, opened on the shared phone, filled Send in right after her Import eleven minutes on, with
  // no time; and again with her own after Reset.
  it("says on Send when it was opened once the wallet's made within ten minutes, and goes past them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [minutes, shown] of [
      [8, "Filled in from the link, to pay on Testnet. Check it before you send. From a link opened at 07:02."],
      [11, null],
    ]) {
      vi.setSystemTime(new Date(2026, 10, 17, 7, 2));
      const { t } = await opened(WEB);
      expect(t.state.draft).toMatchObject({ linkSetup: true });
      // The wallet made: Send, the link's, as the setup leaves it.
      vi.setSystemTime(new Date(2026, 10, 17, 7, 2 + minutes));
      t.send.mockImplementation(async (message) => (message.type === "DUSK_UI_OVERVIEW" ? { ...t.open, nodeUrl: "https://testnet.nodes.dusk.network" } : message.type === "DUSK_UI_GET_CACHED_GAS_PRICE" ? { ok: true, result: { min: "1", median: "1", max: "1" } } : { ok: true, result: null }));
      t.state.route = "send";
      await t.render({ forceRefresh: true });
      await flush();
      if (shown) {
        expect(t.state.route).toBe("send");
        expect(t.app.querySelector(".send-filled-note")?.textContent).toBe(shown);
      } else {
        expect([t.state.route, t.state.draft]).toEqual(["home", null]);
      }
    }
  });

  it("offers a dusk: link to the browser as its web wallet's link", async () => {
    const { t } = await opened(`dusk:public-${B}@dusk:2?amount=0.001&memo=Les+tulipes`, { open_in_browser: true });
    t.app.querySelectorAll("button").find((b) => b.textContent === "Open in browser instead").click();
    await flush();
    expect(t.dom.window.__TAURI_INTERNALS__.invoke).toHaveBeenCalledWith("open_in_browser", { url: WEB }, undefined);
  });
});

describe("a payment link opened in the app while the wallet's locked", () => {
  const LINK = `dusk:public-${B}@dusk:2?amount=0.001&memo=Factura+2026-153`;
  // Locked: the wallet answers so till the password's given.
  const locked = async (message, t) => {
    if (message.type === "DUSK_UI_UNLOCK") {
      t.open = { ...t.open, isUnlocked: true };
      return { ok: true };
    }
    return undefined;
  };
  const opened = async () => {
    const bridge = tauriBridge();
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, locked, { tauri: bridge });
    t.open = { ...t.open, isUnlocked: false };
    await t.render({ forceRefresh: true });
    bridge.emit([LINK]);
    await flush();
    return t;
  };
  const unlock = async (t) => {
    t.app.querySelector("#unlock-password").value = "the password";
    t.app.querySelectorAll("button").find((b) => b.textContent === "Unlock").click();
    await flush();
  };

  afterEach(() => vi.useRealTimers());

  // Sofía's: a link opened while the wallet was locked filled Send in after a later unlock from the app's icon, even
  // one opened long before by someone else on a shared phone, saying nothing of where or when it came from.
  it("says on Send when it was opened, once unlocked within ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 15, 23, 51));
    const t = await opened();
    vi.setSystemTime(new Date(2026, 10, 15, 23, 59));
    await unlock(t);
    expect(t.state.route).toBe("send");
    expect(t.app.querySelector(".to-input-wrap textarea").value).toBe(B);
    expect(t.app.querySelector(".send-filled-note")?.textContent).toBe("Filled in from the link, to pay on Testnet. Check it before you send. From a link opened at 23:51.");
  });

  // Astra's: unlocked at minute 8 and the form edited, a redraw at minute 10 threw the payment away.
  it("keeps it once it opened after an unlock in time, edited, through redraws past ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 15, 23, 51));
    const t = await opened();
    vi.setSystemTime(new Date(2026, 10, 15, 23, 59));
    await unlock(t);
    const memo = () => t.app.querySelectorAll("input").find((i) => i.getAttribute("placeholder") === "Optional");
    memo().value = "Factura 2026-153, paid";
    memo().dispatchEvent(fakeEvent("input"));
    vi.setSystemTime(new Date(2026, 10, 16, 0, 5));
    await t.render({ forceRefresh: true });
    await flush();
    expect([t.state.route, t.app.querySelector(".to-input-wrap textarea").value, memo().value]).toEqual(["send", B, "Factura 2026-153, paid"]);
    expect(t.app.querySelector(".send-filled-note")?.textContent).toBe("Filled in from the link, to pay on Testnet. Check it before you send. From a link opened at 23:51.");
  });

  it("goes Home as usual on an unlock past ten minutes, the link's payment gone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 15, 23, 51));
    const t = await opened();
    vi.setSystemTime(new Date(2026, 10, 16, 0, 2));
    await unlock(t);
    expect([t.state.route, t.state.draft]).toEqual(["home", null]);
  });
});

// The phone's Back in the app, as Android hands it to the wallet (Tauri's
// back-button event, here a fake): through what people do, into screens,
// Back, the background, back in, a press between, Android answering late.
// Back takes one screen back at a time; on the first screen the app goes to
// the background; the page's history is never touched, and nothing closes.
describe("the phone's Back in the app, as Android hands it over", () => {
  const ROWS = [
    ["two screens in, back out, then to the background", "at once", [["settings", "options"], ["contacts", "contacts"], ["back", "options"], ["back", "home"], ["back", "home"]], 1],
    ["to the background, back in, Back with no press, twice (Lena's)", "at once", [["back", "home"], ["back", "home"], ["back", "home"]], 3],
    ["a press between two Backs to the background", "at once", [["back", "home"], ["tap", "home"], ["back", "home"]], 2],
    ["back in, two screens in and out, to the background again", "at once", [["back", "home"], ["settings", "options"], ["contacts", "contacts"], ["back", "options"], ["back", "home"], ["back", "home"], ["back", "home"]], 3],
    ["into Settings before Android answers (Sol's)", "on answer", [["back", "home"], ["settings", "options"], ["answer", "options"], ["back", "home"], ["back", "home"]], 2],
    ["into Settings and Back before Android answers (the delta review's)", "on answer", [["back", "home"], ["settings", "options"], ["back", "home"], ["answer", "home"], ["back", "home"]], 2],
    ["Android answering after the next Back too", "on answer", [["back", "home"], ["back", "home"], ["answer", "home"], ["answer", "home"], ["back", "home"]], 3],
    // Chen's: Back from Settings and from Add wallet went straight to the dashboard.
    ["Settings opened from Receive, Back to Receive", "at once", [["receive", "receive"], ["settings", "options"], ["back", "receive"], ["back", "home"], ["back", "home"]], 1],
    ["Add wallet from Settings, Back to Settings, then to where Settings was opened", "at once", [["receive", "receive"], ["settings", "options"], ["add", "wallet_add"], ["back", "options"], ["back", "receive"], ["back", "home"]], 0],
  ];

  it.each(ROWS)("%s", async (_, when, steps, toBackground) => {
    let history;
    let backButton;
    const waiting = [];
    const bridge = tauriBridge({
      // Android's Back, from the moment the wallet listens to it.
      "plugin:app|register_listener": (args) => {
        if (args?.event === "back-button") backButton = args.handler;
        return null;
      },
      move_to_back: () => (when === "at once" ? true : new Promise((resolve) => waiting.push(resolve))),
    });
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } }, undefined, { tauri: bridge, history: (win) => (history = pageHistory(win)) });
    await vi.waitFor(() => expect(backButton).toBeDefined());
    const button = (text) => [...t.dom.document.querySelectorAll("button")].find((b) => b.textContent === text || b.getAttribute("aria-label") === text);
    const done = [];
    for (const [step, route] of steps) {
      if (step === "settings") button("Settings").click();
      if (step === "contacts") button("Contacts").click();
      if (step === "receive") button("Receive").click();
      if (step === "add") [...t.app.querySelectorAll(".settings-row")].find((row) => row.textContent.includes("Add wallet")).click();
      if (step === "tap") t.app.click();
      if (step === "back") backButton.onmessage({ canGoBack: false });
      if (step === "answer") waiting.shift()?.(true);
      await flush();
      done.push(step);
      expect([done.join(" "), t.state.route, history.length, history.closed]).toEqual([done.join(" "), route, 1, false]);
    }
    expect(bridge.invoke.mock.calls.filter(([cmd]) => cmd === "move_to_back")).toHaveLength(toBackground);
  });

  // Chen's: Back on the Send a link filled in went straight to the dashboard, the payment gone.
  it("asks before a link's payment goes, and Back on the question keeps it", async () => {
    let backButton;
    const bridge = tauriBridge({
      "plugin:app|register_listener": (args) => {
        if (args?.event === "back-button") backButton = args.handler;
        return null;
      },
      move_to_back: () => true,
    });
    const filled = { to: B, amountDusk: "0.04", memo: "laksa", requestChainId: "dusk:2", filledFrom: "link", filledIn: "link" };
    const t = await popupOn("send", { addressBook: { loaded: true, items: [] }, draft: filled }, undefined, { tauri: bridge });
    await vi.waitFor(() => expect(backButton).toBeDefined());
    const values = () => ["To", "Amount", "Memo"].map((name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name)?.value);
    const question = () => t.dom.document.querySelector("[role=alertdialog]");
    const back = async () => {
      backButton.onmessage({ canGoBack: false });
      await flush();
    };
    await back();
    expect([t.state.route, visibleText(question())]).toEqual(["send", "Leave this payment?This clears the payment the link filled in.LeaveStay"]);
    // Back on the question: Stay.
    await back();
    expect([question(), t.state.route, ...values()]).toEqual([null, "send", B, "0.04", "laksa"]);
    await back();
    [...question().querySelectorAll("button")].find((b) => b.textContent === "Leave").click();
    await flush();
    expect(t.state.route).toBe("home");
    expect(bridge.invoke.mock.calls.filter(([cmd]) => cmd === "move_to_back")).toHaveLength(0);
  });
});


// Amélie's, Chen's and Marek's, in Firefox for Android: a link opened from the
// web wallet's page sent the wallet's tab, open already, to Send's address, and
// the phone's Back went to the page it showed before, Home, without a word.
describe("a request link handed to the wallet's tab open already", () => {
  it("fills Send in on the page as it is, and the phone's Back asks before the payment goes", async () => {
    const { makePaymentLink } = await import("@dusk-network/app-core/payment-links");
    const link = makePaymentLink({ amount: "0.02", memo: "popiah", network: "testnet", to: B }).https;
    let history;
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, undefined, {
      // A page pressed in before, as a browser keeps it: no press now.
      history: (win) => {
        win.navigator = { userActivation: { isActive: false, hasBeenActive: true } };
        return (history = pageHistory(win));
      },
      tab: { id: 7 },
    });
    const values = () => ["To", "Amount", "Memo"].map((name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name)?.value);
    const question = () => t.dom.document.querySelector("[role=alertdialog]");
    const answered = vi.fn();

    // Another tab's link: this page's left as it is.
    t.deliver({ type: "DUSK_UI_OPEN_LINK", tabId: 8, link }, {}, answered);
    await flush();
    expect([t.state.route, answered.mock.calls.length]).toEqual(["home", 0]);

    t.deliver({ type: "DUSK_UI_OPEN_LINK", tabId: 7, link }, {}, answered);
    await flush();
    expect(answered.mock.calls).toEqual([[{ ok: true }]]);
    expect([t.state.route, ...values()]).toEqual(["send", B, "0.02", "popiah"]);
    expect(t.app.textContent).toContain("Filled in from the link");

    history.back();
    await flush();
    expect(visibleText(question())).toBe("Leave this payment?This clears the payment the link filled in.LeaveStay");
    // The question's own Back is Stay.
    history.back();
    await flush();
    expect([question(), t.state.route, ...values(), history.closed]).toEqual([null, "send", B, "0.02", "popiah", false]);
  });
});

// Marek's and Amélie's: in Firefox for Android a pull down at the top of the page reloaded the wallet's tab, and the
// payment a link filled in went without a word, as did a half-filled request; after it, Back no longer asked.
describe("a wallet tab that reloads", () => {
  // The tab's session as a reload keeps it: its history's entries, each with its state, and its session storage.
  function tabSession() {
    const kept = new Map();
    const entries = [null];
    let at = 0;
    let win = null;
    const history = {
      closed: false,
      get state() {
        return entries[at];
      },
      get at() {
        return at;
      },
      pushState(state) {
        entries.splice(at + 1, Infinity, state);
        at++;
      },
      back() {
        this.go(-1);
      },
      go(delta) {
        if (at + delta < 0) {
          this.closed = true;
          return;
        }
        at += delta;
        setTimeout(() => win.dispatchEvent(fakeEvent("popstate", { state: entries[at] })), 0);
      },
    };
    return {
      history,
      kept,
      // The page loaded in it: pressed in before, or, just reloaded, not.
      page: (pressed) => (w) => {
        win = w;
        w.navigator = { userActivation: { isActive: false, hasBeenActive: pressed } };
        vi.stubGlobal("sessionStorage", { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, String(value)), removeItem: (key) => kept.delete(key) });
        return history;
      },
    };
  }
  const values = (t) => ["To", "Amount", "Memo"].map((name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name)?.value);
  const question = (t) => t.dom.document.querySelector("[role=alertdialog]");

  it("opens again on a link's payment, and the phone's Back still asks before it goes", async () => {
    const { makePaymentLink } = await import("@dusk-network/app-core/payment-links");
    const link = makePaymentLink({ amount: "0.02", memo: "popiah", network: "testnet", to: B }).https;
    const tab = tabSession();
    let t = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, undefined, { history: tab.page(true), tab: { id: 7 } });
    t.deliver({ type: "DUSK_UI_OPEN_LINK", tabId: 7, link }, {}, vi.fn());
    await flush();
    expect([t.state.route, ...values(t), tab.history.at]).toEqual(["send", B, "0.02", "popiah", 2]);

    // Pulled down: the page goes, and loads again in the same tab, with nothing pressed in it.
    t.dom.window.dispatchEvent(fakeEvent("pagehide"));
    t = await popupOn("home", { addressBook: { loaded: true, items: [] }, draft: null }, undefined, { history: tab.page(false), tab: { id: 7 } });
    expect([t.state.route, ...values(t), tab.history.at]).toEqual(["send", B, "0.02", "popiah", 2]);
    expect(t.app.textContent).toContain("Filled in from the link");
    tab.history.back();
    await flush();
    expect(visibleText(question(t))).toBe("Leave this payment?This clears the payment the link filled in.LeaveStay");
    // The question's own Back is Stay.
    tab.history.back();
    await flush();
    expect([question(t), t.state.route, ...values(t), tab.history.closed]).toEqual([null, "send", B, "0.02", "popiah", false]);
  });

  it("opens again on the request form as it was being filled in, and on Home once it was left", async () => {
    const tab = tabSession();
    const { typeInto } = await import("../testing/fakeDom.js");
    let t = await popupOn("receive", { addressBook: { loaded: true, items: [] }, receive: null }, undefined, { history: tab.page(true), tab: { id: 7 } });
    t.state.receive.requestOpen = true;
    await t.render();
    await flush();
    const field = (name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name);
    typeInto(field("Amount"), "0.5");
    typeInto(field("Memo"), "Rent March");
    await vi.waitFor(() => expect(t.app.querySelector(".receive-request__meta")?.textContent).toBe("0.5 DUSK"));
    t.dom.window.dispatchEvent(fakeEvent("pagehide"));

    t = await popupOn("home", { addressBook: { loaded: true, items: [] }, receive: null }, undefined, { history: tab.page(false), tab: { id: 7 } });
    expect([t.state.route, field("Amount")?.value, field("Memo")?.value, t.app.querySelector("details.receive-request")?.open]).toEqual(["receive", "0.5", "Rent March", true]);

    // Left for Home, then reloaded: Home.
    t.state.route = "home";
    await t.render();
    t.dom.window.dispatchEvent(fakeEvent("pagehide"));
    t = await popupOn("home", { addressBook: { loaded: true, items: [] }, receive: null }, undefined, { history: tab.page(false), tab: { id: 7 } });
    expect(t.state.route).toBe("home");
  });
});

// Astra's: a link handed to the tab in place left the request the tab was opened with in its address, and a reload,
// or Firefox bringing the tab back, filled Send with that one.
describe("a request link handed to a wallet tab opened with another", () => {
  it("takes the one the tab was opened with off its address, from every entry it comes back to", async () => {
    const { makePaymentLink } = await import("@dusk-network/app-core/payment-links");
    const before = makePaymentLink({ amount: "0.02", memo: "Cadeau", network: "testnet", to: B }).https;
    const handed = makePaymentLink({ amount: "0.05", memo: "Laksa", network: "testnet", to: B }).https;
    let history;
    const t = await popupOn("send", { addressBook: { loaded: true, items: [] } }, undefined, {
      history: (win) => (history = addressedHistory(win, `/full.html?route=send&link=${encodeURIComponent(before)}`)),
      tab: { id: 7 },
    });
    const values = () => ["To", "Amount", "Memo"].map((name) => t.app.querySelectorAll("input, textarea").find((f) => accessibleName(f) === name)?.value);
    expect(values()).toEqual([B, "0.02", "Cadeau"]);
    t.deliver({ type: "DUSK_UI_OPEN_LINK", tabId: 7, link: handed }, {}, vi.fn());
    await flush();
    expect(values()).toEqual([B, "0.05", "Laksa"]);
    expect(history.url).toBe("/full.html");
    // Pulled down: the wallet, not the request it was opened with.
    vi.resetModules();
    const { state } = await import("./state.js");
    expect([state.route, state.draft]).toEqual(["home", null]);
    // Nor on any entry of the page's it comes back to.
    while (history.at > 0) {
      history.back();
      await flush();
      expect(history.url).toBe("/full.html");
    }
  });
});

// Chen's, in Firefox for Android: Activity's search typed quickly kept "sa" of
// "satay": each letter drew the screen again, and a field swapped under a
// phone's keyboard loses what it's composing. Once, an amount came out "002.".
describe("a field typed in while the wallet draws its screen again", () => {
  it("stays the field typed in, with what's typed, till the typing stops; the screen follows then", async () => {
    const t = await popupOn("activity", { addressBook: { loaded: true, items: [] } });
    const search = () => t.app.querySelector(".activity-search");
    const field = search();
    field.focus();
    for (const typed of ["s", "sa", "sat", "sata", "satay"]) {
      field.value = typed;
      field.dispatchEvent(fakeEvent("input"));
      // A poll draws the screen again meanwhile, too.
      await t.render({ forceRefresh: true });
    }
    await flush();
    expect([search(), field.value, t.dom.document.activeElement]).toEqual([field, "satay", field]);

    // Once the typing stops, the screen is drawn from what was typed.
    await vi.waitFor(() => expect(search()).not.toBe(field), { timeout: 3000 });
    expect([search().value, t.dom.document.activeElement]).toEqual(["satay", search()]);
    expect(t.app.textContent).toContain("Nothing in your activity matches that.");
  });

  // Sofía's, in the app: the export's dates closed by themselves within seconds, as polls drew the page again, and her
  // next taps landed on the page under them.
  it("stays a list or a date whose picker may be open, till it's left; the screen follows then", async () => {
    const t = await popupOn("activity", { addressBook: { loaded: true, items: [] }, activityExport: { open: true, period: "dates", withContacts: false } });
    for (const selector of ["#activity-export-from", "#activity-export-period"]) {
      const field = t.app.querySelector(selector);
      expect(field).toBeTruthy();
      field.focus();
      await t.render({ forceRefresh: true });
      await t.render({ forceRefresh: true });
      await flush();
      expect([t.app.querySelector(selector), t.dom.document.activeElement]).toEqual([field, field]);
      // Left: drawn again.
      field.blur();
      await vi.waitFor(() => expect(t.app.querySelector(selector)).not.toBe(field), { timeout: 3000 });
    }
  });

  // Astra's, the second time: Period's own choice, Choose dates, showed no days till something else was focused, as
  // a list keeps the focus once its picker closes. A choice made in it closes it: what it asks for is drawn at once.
  it("draws what a choice in a list asks for at once, the choice having closed its picker", async () => {
    const t = await popupOn("activity", { addressBook: { loaded: true, items: [] }, activityExport: { open: true, period: "all", withContacts: false } });
    const period = t.app.querySelector("#activity-export-period");
    expect(t.app.querySelector("#activity-export-from")).toBeNull();
    period.focus();
    period.value = "dates";
    period.dispatchEvent(fakeEvent("change"));
    await vi.waitFor(() => expect(t.app.querySelector("#activity-export-from")).toBeTruthy(), { timeout: 3000 });
    expect(t.app.querySelector("#activity-export-period").value).toBe("dates");
  });

  it("is drawn again at once on another wallet or a lock, typed in or not", async () => {
    const t = await popupOn("activity", { addressBook: { loaded: true, items: [] } });
    const field = t.app.querySelector(".activity-search");
    field.focus();
    field.value = "sa";
    field.dispatchEvent(fakeEvent("input"));
    t.open = { ...t.open, isUnlocked: false };
    await t.render({ forceRefresh: true });
    await flush();
    expect(t.app.contains(field)).toBe(false);
  });
});

// Lena's: held as her account sent something else meanwhile, Activity didn't list what it sent for 1 to 3 minutes.
describe("a payment held as its account sent something else while it waited", () => {
  it("has the account's history read again as the hold comes, so Activity can list what it sent", async () => {
    // The archive, asked where the account's history stands, as each read of it begins.
    const asked = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(init?.body ?? "").includes("lastBlockPair")) asked.push(String(url));
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    // The history kept on this device.
    const { IDBFactory, IDBKeyRange } = await import("fake-indexeddb");
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    const t = await popupOn("home", { addressBook: { loaded: true, items: [] } });
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(t.state.activity.syncing).toBeFalsy());
    await flush();
    asked.length = 0;
    t.deliver({ type: "DUSK_UI_SEND_WAITING", sendId: "s1", waits: true });
    await flush();
    expect(asked).toEqual([]);
    t.deliver({ type: "DUSK_UI_SEND_WAITING", sendId: "s1", waits: false, held: true });
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
  });
});
