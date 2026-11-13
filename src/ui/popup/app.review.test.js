import { afterEach, describe, expect, it, vi } from "vitest";

import { accessibleName, fakeEvent, installFakeDom, pastClickGuard, settle } from "../testing/fakeDom.js";

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
async function popupOn(route, extra = {}, answer = async () => undefined, { history, tauri } = {}) {
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
  const { render } = await import("./app.js");
  await render();
  await flush();
  return Object.assign(t, { state, render, deliver: (message) => onMessage(message), asked: (type) => send.mock.calls.map(([m]) => m).filter((m) => m.type === type) });
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
    history.back();
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

    // Left with Back: the next Send, begun by hand on Home, is empty.
    back.app.querySelectorAll("button").find((b) => b.textContent === "← Back").click();
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
